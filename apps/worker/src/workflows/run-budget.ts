import type { WorkflowRunBudgetFailure } from "@shared/contracts";
import type { PhaseUsage } from "../sandbox/agents/types.js";
import type { TokenPrice } from "../sandbox/agents/pricing.js";

export interface RunBudgetLimits {
  maxDurationMs: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface RunBudgetState {
  activeElapsedMs: number;
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
  durationLimitMs?: number;
  activeElapsedMs?: number;
}

export class RunBudgetError extends Error {
  readonly failure: RunBudgetFailure;

  constructor(failure: RunBudgetFailure) {
    super(failure.reason);
    this.name = "RunBudgetError";
    this.failure = failure;
  }
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

export function recordBudgetUsage(
  state: RunBudgetState,
  usage: PhaseUsage | null,
  price: TokenPrice | null,
): RunBudgetState {
  if (!usage) {
    return { ...state, tokensKnown: false, costKnown: false };
  }

  const tokens = usage.tokens;
  const tokensValid =
    tokens !== null &&
    [tokens.input, tokens.cached_input, tokens.output].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
  const next = tokensValid && tokens
    ? {
        ...state,
        tokensInput: state.tokensInput + tokens.input,
        tokensCached: state.tokensCached + tokens.cached_input,
        tokensOutput: state.tokensOutput + tokens.output,
      }
    : { ...state, tokensKnown: false };

  if (typeof usage.cost_usd === "number" && usage.cost_usd >= 0) {
    const costNanos = usdToNanos(usage.cost_usd);
    if (costNanos !== null && Number.isSafeInteger(next.costNanos + costNanos)) {
      return withCostNanos(next, next.costNanos + costNanos);
    }
    return { ...next, costKnown: false };
  }

  const priceValid =
    price !== null &&
    [price.input, price.cached_input, price.output].every(
      (value) => Number.isFinite(value) && value >= 0,
    );
  if (tokensValid && tokens && priceValid && price) {
    const inputNanos = usdToNanos(price.input);
    const cachedNanos = usdToNanos(price.cached_input);
    const outputNanos = usdToNanos(price.output);
    if (inputNanos === null || cachedNanos === null || outputNanos === null) {
      return { ...next, costKnown: false };
    }
    const derivedNanos =
      tokens.input * inputNanos +
      tokens.cached_input * cachedNanos +
      tokens.output * outputNanos;
    if (!Number.isSafeInteger(derivedNanos) || !Number.isSafeInteger(next.costNanos + derivedNanos)) {
      return { ...next, costKnown: false };
    }
    return withCostNanos(next, next.costNanos + derivedNanos);
  }

  return { ...next, costKnown: false };
}

export function totalBudgetTokens(state: RunBudgetState): number {
  return state.tokensInput + state.tokensCached + state.tokensOutput;
}

export function checkRunBudget(
  state: RunBudgetState,
  limits: RunBudgetLimits,
): RunBudgetCheck {
  if (state.activeElapsedMs > limits.maxDurationMs) {
    return exceeded("duration", limits.maxDurationMs, state.activeElapsedMs);
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

const USD_NANOS = 1_000_000_000;

function usdToNanos(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const nanos = Math.round(value * USD_NANOS);
  return Number.isSafeInteger(nanos) ? nanos : null;
}

function withCostNanos(state: RunBudgetState, costNanos: number): RunBudgetState {
  return { ...state, costNanos, costUsd: costNanos / USD_NANOS };
}

export function observeRunBudget(
  state: RunBudgetState,
  limits: RunBudgetLimits,
  requireRemainingDuration: boolean,
): RunBudgetObservation {
  const remainingDurationMs = Math.max(0, limits.maxDurationMs - state.activeElapsedMs);
  let check = checkRunBudget(state, limits);
  if (check.status === "ok" && requireRemainingDuration && remainingDurationMs === 0) {
    check = {
      status: "budget_exceeded",
      metric: "duration",
      limit: limits.maxDurationMs,
      consumed: state.activeElapsedMs,
      reason: `budget_exceeded: duration ${state.activeElapsedMs} reached limit ${limits.maxDurationMs} before more work`,
    };
  }
  return {
    check,
    remainingDurationMs,
    durationLimitMs: limits.maxDurationMs,
    activeElapsedMs: state.activeElapsedMs,
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

export function durationBudgetFailure(
  observation: RunBudgetObservation,
  activity: string,
): RunBudgetFailure {
  const limit = observation.durationLimitMs ?? observation.activeElapsedMs ?? 0;
  const consumed = Math.max(limit, observation.activeElapsedMs ?? limit);
  return {
    status: "budget_exceeded",
    metric: "duration",
    limit,
    consumed,
    reason: `budget_exceeded: duration ${consumed} reached limit ${limit} during ${activity}`,
  };
}

function exceeded(
  metric: "duration" | "tokens" | "cost",
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
