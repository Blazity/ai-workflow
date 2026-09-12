import type { WorkflowRunBudgetFailure } from "@shared/contracts";
import {
  aggregateUsage,
  usdToNanos,
  type CostProvider,
  type TokenPrice,
} from "@shared/costs";
import type { PhaseUsage } from "../../sandbox/agents/types.js";

export interface RunBudgetLimits {
  maxDurationMs: number;
  /** Where the workflow-level duration ceiling came from. Optional only for
   *  legacy journaled values and lightweight callers that predate this field. */
  maxDurationSource?: "definition" | "env" | "profile";
  maxDurationProfileName?: string;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface RunBudgetState {
  activeElapsedMs: number;
  /**
   * Wall-clock time attributed to the checks phase instead of to the run.
   *
   * Optional, and always read through checksElapsedOf. A budget state can cross
   * a step boundary as a journaled argument, so a run started on a deployment
   * that predates this field resumes with it absent, and `undefined - x` is NaN
   * that would silently disable every bound derived from it.
   *
   * Separate from activeElapsedMs because a test suite is not agent work. A
   * repository whose checks take nineteen minutes would otherwise spend two
   * thirds of a thirty minute run budget proving that the agent's work was
   * fine, and the run would halt as budget_exceeded with a green check run
   * behind it.
   */
  checksElapsedMs?: number;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  tokensKnown: boolean;
  /** Integer nanodollars are authoritative; costUsd is the display projection. */
  costNanos: number;
  costUsd: number;
  costKnown: boolean;
}

export type RunBudgetFailure = WorkflowRunBudgetFailure;

export type RunBudgetCheck = { status: "ok" } | RunBudgetFailure;

export interface RunBudgetObservation {
  check: RunBudgetCheck;
  remainingDurationMs: number;
  /** Durable clock reading that produced this observation. Optional because
   *  older deployments and lightweight callers do not include it. */
  observedAtMs?: number;
  durationLimitMs?: number;
  activeElapsedMs?: number;
  /** Source paired with durationLimitMs. Absent legacy observations use the
   *  JOB_TIMEOUT_MS fallback wording. */
  maxDurationSource?: "definition" | "env" | "profile";
  /** Display name paired with a profile-sourced duration limit, when known. */
  maxDurationProfileName?: string;
  /** Checks time this observation has seen. Optional for the same reason the
   *  state field is: an observation produced by an older deployment carries no
   *  such number, and remainingChecksMs treats that as zero spent. */
  checksElapsedMs?: number;
}

/**
 * Which clock an observation charges the time since the previous one to.
 *
 * The attribution belongs to the OBSERVATION, not to the block: a budget
 * context only learns how much time passed when it is next asked, so the
 * stretch between two observations is charged wherever the closing one says.
 * That is why the checks path takes its first observation immediately before
 * launching a batch and charges it to "duration": everything up to the launch
 * is the run's, everything after it is the checks phase's.
 */
export type RunBudgetAttribution = "duration" | "checks";

export class RunBudgetError extends Error {
  readonly failure: RunBudgetFailure;

  constructor(failure: RunBudgetFailure) {
    super(failure.reason);
    this.name = "RunBudgetError";
    this.failure = failure;
  }
}

export interface ChecksCeilingExceededError extends Error {
  readonly ceilingMs: number;
  readonly detail: string;
}

export function checksCeilingExceededError(
  ceilingMs: number,
  activity: string,
): ChecksCeilingExceededError {
  return Object.assign(
    new Error(checksCeilingFailureReason(ceilingMs, activity)),
    {
      name: "ChecksCeilingExceededError",
      ceilingMs,
      detail: checksCeilingFailureDetail(ceilingMs, activity),
    },
  );
}

export function isChecksCeilingExceededError(
  error: unknown,
): error is ChecksCeilingExceededError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ChecksCeilingExceededError" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function checksCeilingErrorDetail(
  error: Pick<Error, "message"> & { detail?: string },
): string {
  if (error.detail) return error.detail;
  const marker = "(checks_ceiling_exceeded:";
  const start = error.message.lastIndexOf(marker);
  return start >= 0 && error.message.endsWith(")")
    ? error.message.slice(start + 1, -1)
    : error.message;
}

export function isRunBudgetError(error: unknown): error is RunBudgetError {
  return isRunBudgetControlError(error) && "failure" in error && isRunBudgetFailure(error.failure);
}

/** Workflow's generic Error rehydration preserves name/message even when an
 * older deployment did not retain the structured failure. It must still stop
 * graph execution, but callers may consume metadata only through the stricter
 * `isRunBudgetError` guard. */
export function isRunBudgetControlError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "RunBudgetError" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function runBudgetFailureFromError(error: unknown): RunBudgetFailure | null {
  return isRunBudgetError(error) ? error.failure : null;
}

function isRunBudgetFailure(value: unknown): value is RunBudgetFailure {
  if (typeof value !== "object" || value === null) return false;
  const failure = value as Partial<Record<keyof RunBudgetFailure, unknown>>;
  if (
    typeof failure.reason !== "string" ||
    !isNonNegativeFiniteNumber(failure.limit)
  ) {
    return false;
  }
  if (failure.status === "budget_exceeded") {
    return (
      (failure.metric === "duration" ||
        failure.metric === "tokens" ||
        failure.metric === "cost") &&
      isNonNegativeFiniteNumber(failure.consumed)
    );
  }
  return (
    failure.status === "budget_unverifiable" &&
    (failure.metric === "tokens" || failure.metric === "cost") &&
    failure.consumed === null
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createRunBudgetState(): RunBudgetState {
  return {
    activeElapsedMs: 0,
    checksElapsedMs: 0,
    tokensInput: 0,
    tokensCached: 0,
    tokensOutput: 0,
    tokensKnown: true,
    costNanos: 0,
    costUsd: 0,
    costKnown: true,
  };
}

export function addActiveElapsed(state: RunBudgetState, elapsedMs: number): RunBudgetState {
  const increment = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return { ...state, activeElapsedMs: state.activeElapsedMs + increment };
}

/** Checks time spent so far, defaulting an absent field to zero. Every read of
 *  checksElapsedMs goes through here. */
export function checksElapsedOf(state: Pick<RunBudgetState, "checksElapsedMs">): number {
  const value = state.checksElapsedMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Charge elapsed time to the checks phase rather than to the run's duration. */
export function addChecksElapsed(state: RunBudgetState, elapsedMs: number): RunBudgetState {
  const increment = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return { ...state, checksElapsedMs: checksElapsedOf(state) + increment };
}

/** Charge elapsed time to whichever clock the caller named. */
export function addElapsed(
  state: RunBudgetState,
  elapsedMs: number,
  attribution: RunBudgetAttribution,
): RunBudgetState {
  return attribution === "checks"
    ? addChecksElapsed(state, elapsedMs)
    : addActiveElapsed(state, elapsedMs);
}

/**
 * How much of the checks ceiling is left, given what an observation has seen.
 *
 * The ceiling is per run, not per batch: a workspace with four repositories
 * shares one, so the fourth batch is bounded by what the first three left. That
 * is the point of holding the elapsed total on the budget state rather than
 * timing each batch on its own.
 */
export function remainingChecksMs(
  observation: Pick<RunBudgetObservation, "checksElapsedMs">,
  ceilingMs: number,
): number {
  const ceiling = Number.isFinite(ceilingMs) ? Math.max(0, ceilingMs) : 0;
  return Math.max(0, ceiling - checksElapsedOf(observation));
}

export function recordBudgetUsage(
  state: RunBudgetState,
  usage: PhaseUsage | null,
  provider: CostProvider | null,
  phase: string,
): RunBudgetState {
  const totals = aggregateUsage(
    { [phase]: usage },
    { [phase]: provider ?? undefined },
    {
      costNanos: state.costNanos,
      costKnown: state.costKnown,
      tokensInput: state.tokensInput,
      tokensCached: state.tokensCached,
      tokensOutput: state.tokensOutput,
      tokensKnown: state.tokensKnown,
    },
  );

  return {
    ...state,
    costNanos: totals.costNanos,
    costUsd: totals.costUsd,
    costKnown: totals.costKnown,
    tokensInput: totals.tokensInput,
    tokensCached: totals.tokensCached,
    tokensOutput: totals.tokensOutput,
    tokensKnown: totals.tokensKnown,
  };
}

export function totalBudgetTokens(state: RunBudgetState): number {
  return state.tokensInput + state.tokensCached + state.tokensOutput;
}

export function checkRunBudget(state: RunBudgetState, limits: RunBudgetLimits): RunBudgetCheck {
  if (state.activeElapsedMs > limits.maxDurationMs) {
    return durationBudgetFailure({
      durationLimitMs: limits.maxDurationMs,
      activeElapsedMs: state.activeElapsedMs,
      maxDurationSource: limits.maxDurationSource,
      maxDurationProfileName: limits.maxDurationProfileName,
    });
  }
  if (limits.maxTokens !== undefined) {
    if (!state.tokensKnown) {
      return {
        status: "budget_unverifiable",
        metric: "tokens",
        limit: limits.maxTokens,
        consumed: null,
        reason: "budget_unverifiable: token usage is unavailable",
      };
    }
    const tokens = totalBudgetTokens(state);
    if (tokens > limits.maxTokens) return exceeded("tokens", limits.maxTokens, tokens);
  }
  if (limits.maxCostUsd !== undefined) {
    if (!state.costKnown) {
      return {
        status: "budget_unverifiable",
        metric: "cost",
        limit: limits.maxCostUsd,
        consumed: null,
        reason: "budget_unverifiable: cost usage or pricing is unavailable",
      };
    }
    const limitNanos = usdToNanos(limits.maxCostUsd);
    if (limitNanos === null) {
      return {
        status: "budget_unverifiable",
        metric: "cost",
        limit: limits.maxCostUsd,
        consumed: null,
        reason: "budget_unverifiable: configured cost limit cannot be represented",
      };
    }
    if (state.costNanos > limitNanos) {
      return exceeded("cost", limits.maxCostUsd, state.costUsd);
    }
  }

  return { status: "ok" };
}

export function missingRequiredPriceFailure(
  maxCostUsd: number | undefined,
  requiredModels: ReadonlySet<string>,
  prices: ReadonlyMap<string, TokenPrice>,
): RunBudgetFailure | null {
  if (maxCostUsd === undefined) return null;

  const missing = [...requiredModels].filter((model) => !prices.has(model)).sort();
  if (missing.length === 0) return null;

  const label = missing.length === 1 ? "required model" : "required models";
  return {
    status: "budget_unverifiable",
    metric: "cost",
    limit: maxCostUsd,
    consumed: null,
    reason: `budget_unverifiable: pricing is unavailable for ${label} ${missing.join(", ")}`,
  };
}

export function observeRunBudget(
  state: RunBudgetState,
  limits: RunBudgetLimits,
  requireRemainingDuration: boolean,
): RunBudgetObservation {
  const remainingDurationMs = Math.max(0, limits.maxDurationMs - state.activeElapsedMs);
  let check = checkRunBudget(state, limits);
  if (check.status === "ok" && requireRemainingDuration && remainingDurationMs === 0) {
    check = durationBudgetFailure({
      durationLimitMs: limits.maxDurationMs,
      activeElapsedMs: state.activeElapsedMs,
      maxDurationSource: limits.maxDurationSource,
      maxDurationProfileName: limits.maxDurationProfileName,
    });
  }
  return {
    check,
    remainingDurationMs,
    durationLimitMs: limits.maxDurationMs,
    activeElapsedMs: state.activeElapsedMs,
    maxDurationSource: limits.maxDurationSource ?? "env",
    maxDurationProfileName: limits.maxDurationProfileName,
    checksElapsedMs: checksElapsedOf(state),
  };
}

export function isDurationAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Workflow rehydrates invocation cancellation as a plain Error, so the name
 *  is the only identity that survives the durable boundary. */
export function isV2InvocationCancelledError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "V2InvocationCancelledError"
  );
}

/** Keep infrastructure aborts and invocation cancellation out of error
 *  conversion paths. Both must reach the workflow boundary unchanged. */
export function propagateInvocationInterruption(error: unknown): void {
  if (isDurationAbortError(error) || isV2InvocationCancelledError(error)) {
    throw error;
  }
}

export function durationBudgetFailure(
  observation: Pick<
    RunBudgetObservation,
    | "durationLimitMs"
    | "activeElapsedMs"
    | "maxDurationSource"
    | "maxDurationProfileName"
  >,
): RunBudgetFailure {
  const limit = observation.durationLimitMs ?? observation.activeElapsedMs ?? 0;
  const consumed = Math.max(limit, observation.activeElapsedMs ?? limit);
  const elapsed = formatBudgetDuration(consumed);
  const configuredLimit = formatBudgetDuration(limit);
  const source = observation.maxDurationSource ?? "env";
  const profileLabel = observation.maxDurationProfileName
    ? ` "${observation.maxDurationProfileName}"`
    : "";
  return {
    status: "budget_exceeded",
    metric: "duration",
    limit,
    consumed,
    reason:
      source === "profile"
        ? `budget_exceeded: this invocation took ${elapsed}, over the ${configuredLimit} limit from ` +
          `the harness profile${profileLabel} (runtimeLimits.maxDurationMs). ` +
          "Raise that limit on the profile to allow longer invocations."
        : source === "definition"
        ? `budget_exceeded: the run took ${elapsed}, over the ${configuredLimit} limit from ` +
          "budgets.maxDurationMs on this workflow definition. Raise budgets.maxDurationMs to allow longer runs."
        : `budget_exceeded: the run took ${elapsed}, over the ${configuredLimit} limit from ` +
          "JOB_TIMEOUT_MS (this workflow sets no budgets.maxDurationMs). Raise " +
          "budgets.maxDurationMs on the workflow definition, or JOB_TIMEOUT_MS, to allow longer runs.",
  };
}

function formatBudgetDuration(durationMs: number): string {
  const wholeSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

function checksCeilingFailureReason(
  ceilingMs: number,
  activity: string,
): string {
  return checksCeilingUserMessage(ceilingMs) +
    " " +
    `(${checksCeilingFailureDetail(ceilingMs, activity)})`;
}

function checksCeilingUserMessage(ceilingMs: number): string {
  const minutes = Math.round(ceilingMs / 60_000);
  return (
    `The repository checks did not finish within the ${minutes} minute checks ceiling. ` +
    "Raise the checks ceiling on the Repositories page (open the repository, " +
    "Scripts tab, checks ceiling), or split the run."
  );
}

function checksCeilingFailureDetail(ceilingMs: number, activity: string): string {
  const minutes = Math.round(ceilingMs / 60_000);
  return `checks_ceiling_exceeded: ${activity} reached the ${minutes} minute checks ceiling`;
}

function exceeded(
  metric: "tokens" | "cost",
  limit: number,
  consumed: number,
): RunBudgetFailure {
  return {
    status: "budget_exceeded",
    metric,
    limit,
    consumed,
    reason: `budget_exceeded: ${metric} ${consumed} exceeds limit ${limit}`,
  };
}
