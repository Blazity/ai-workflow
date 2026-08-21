import { RunBudgetError, type RunBudgetObservation } from "../run-budget.js";
import {
  V2InvocationCancelledError,
  type V2InvocationCancellation,
} from "../../workflow-definition/invocation-context.js";

/**
 * Longest a single tick may sleep.
 *
 * Coupled to the deployed step function's duration limit, not chosen for
 * responsiveness: see poll-delay.ts. Ramping a tick beyond this ceiling is not
 * available, however long the phase is, so `tickGrowthFactor` ramps up to it
 * and stops.
 */
export const PHASE_POLL_TICK_MAX_MS = 30_000;

/** What a poll consumed, and why it ended. Filled in by pollPhaseUntilDone when
 *  the caller supplies one, so a caller can report the bound that actually
 *  applied instead of restating the bound it asked for. */
export interface PhasePollOutcome {
  /** Tick time actually consumed. The cap the caller passed is an upper bound
   *  on this, never a description of it. */
  elapsedMs: number;
  ticks: number;
  reason: "finished" | "duration_cap" | "tick_cap" | "sandbox_stopped";
}

/**
 * Optional poll behaviour. Every field defaults to the behaviour agent phases
 * have today, so omitting the argument entirely changes nothing: a flat 30s
 * tick, no pre-check, no tick ceiling, and one "stopped" observation is enough
 * to abandon the phase.
 */
export interface PhasePollTuning {
  /** Read the sentinel once before sleeping at all, so an already finished
   *  phase costs no tick of latency. Default false. */
  checkBeforeFirstTick?: boolean;
  /** Length of the first tick, ramped by `tickGrowthFactor` toward
   *  PHASE_POLL_TICK_MAX_MS. Default PHASE_POLL_TICK_MAX_MS, meaning no ramp. */
  initialTickMs?: number;
  /** Multiplier applied to the tick after each poll. Default 1, meaning no ramp. */
  tickGrowthFactor?: number;
  /** Hard ceiling on the number of ticks, and so on the number of step records
   *  one poll can append to the run's event log. Default unbounded. */
  maxTicks?: number;
  /**
   * Time bound in milliseconds, replacing `maxMinutes` when given.
   *
   * Callers that derive their bound from the run's remaining duration budget
   * cannot express it in whole minutes: flooring makes the phase cap expire
   * before the budget does, so the budget stop is pre-empted by a phase timeout
   * and the run reports a timed-out phase instead of halting as
   * budget_exceeded. Default: `maxMinutes * 60_000`, exactly as before.
   */
  phaseLimitMs?: number;
  /**
   * Stop consulting the observation's remaining duration, and bound the poll by
   * `phaseLimitMs` alone. Default false, which is what every agent phase does.
   *
   * For a phase that spends its OWN budget rather than the run's. The checks
   * phase has a ceiling of its own and charges its time to it, so the run's
   * remaining duration says nothing about how long this poll may wait, and
   * letting it speak produces the wrong ending: a run halted as
   * budget_exceeded, with no report of how far the checks got, in place of a
   * loud "the checks ran for N minutes without finishing" plus whatever the
   * batch had already written. Token and cost failures still stop the poll;
   * only the duration dimension is silenced.
   */
  ignoreRemainingDuration?: boolean;
  /**
   * Consecutive "stopped" readings required before the phase is abandoned.
   * Default 1, which is what every caller did before this existed.
   *
   * checkPhaseDone reports "stopped" both for a sandbox that is genuinely gone
   * and for any error reaching it, so a caller that polls for a long time and
   * treats a single reading as fatal is betting on never seeing a transient
   * network fault. Raising this trades one extra tick of latency on a real
   * sandbox death for immunity to a single blip.
   */
  stoppedObservations?: number;
  /** Record to fill in with what the poll consumed and why it ended. */
  outcome?: PhasePollOutcome;
  /**
   * Called after every completed tick, with what the poll has consumed so far.
   *
   * The one seam a long phase has for reporting progress while it is still
   * running: everything else about a batch is written inside the sandbox and
   * read back only when it finishes, so a forty minute checks phase is
   * indistinguishable from a hung run until it ends. Deliberately scoped to the
   * caller rather than emitted here: only the checks and setup batches have
   * anything to report, and an agent phase does not need one observation per
   * tick.
   *
   * Reporting is not the phase. Whatever this does must swallow its own
   * failures; a throw from here would end a poll that is otherwise healthy.
   */
  onTick?: (progress: {
    elapsedMs: number;
    ticks: number;
    /** How long the tick that just elapsed actually slept. A throttling caller
     *  needs it: the interval only ever grows to PHASE_POLL_TICK_MAX_MS, so a
     *  "has 30s passed" test that ignores it drops every second report. */
    sleepMs: number;
    /** What the run's duration budget had left when this tick began. It is the
     *  bound a setup batch actually obeys, so a reporter cannot describe one
     *  honestly from the phase limit alone. */
    remainingDurationMs: number;
  }) => void | Promise<void>;
}

/**
 * Wait for an agent phase's sentinel file, polling up to maxMinutes.
 * Returns false when the phase stopped without finishing or the cap ran out.
 * Plain async orchestration (not a "use step"): it drives the checkPhaseDone
 * step, so it is safe to share between block executors.
 *
 * The tick is a sleeping step rather than a Workflow sleep() wait. See
 * poll-delay.ts: a wait here corrupts the run's event log as soon as two blocks
 * poll concurrently, which is why production pinned V2_MAX_BLOCK_CONCURRENCY to 1
 * until this path stopped waiting. That module also records what the step costs
 * against a wait, and why the tick ceiling below is coupled to the deployed
 * function's duration limit.
 */
export async function pollPhaseUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxMinutes: number,
  commandId: string,
  observeBudget: (requireRemainingDuration?: boolean) => Promise<RunBudgetObservation>,
  cancellation?: V2InvocationCancellation,
  tuning: PhasePollTuning = {},
): Promise<boolean> {
  const { delayPhasePollStep } = await import("./poll-delay.js");
  const { checkPhaseDone } = await import("../../sandbox/poll-agent.js");
  const phaseLimitMs = tuning.phaseLimitMs ?? maxMinutes * 60_000;
  const maxTicks = tuning.maxTicks ?? Number.POSITIVE_INFINITY;
  const tickGrowthFactor = tuning.tickGrowthFactor ?? 1;
  const stoppedObservations = Math.max(1, tuning.stoppedObservations ?? 1);
  const ignoreRemainingDuration = tuning.ignoreRemainingDuration === true;
  let tickMs = Math.min(
    tuning.initialTickMs ?? PHASE_POLL_TICK_MAX_MS,
    PHASE_POLL_TICK_MAX_MS,
  );
  let phaseElapsedMs = 0;
  let ticks = 0;
  let consecutiveStopped = 0;
  const record = (reason: PhasePollOutcome["reason"]): void => {
    if (!tuning.outcome) return;
    tuning.outcome.elapsedMs = phaseElapsedMs;
    tuning.outcome.ticks = ticks;
    tuning.outcome.reason = reason;
  };

  if (tuning.checkBeforeFirstTick) {
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) {
      record("finished");
      return true;
    }
    if (status === "stopped") {
      consecutiveStopped = 1;
      if (consecutiveStopped >= stoppedObservations) {
        record("sandbox_stopped");
        return false;
      }
    }
  }

  while (phaseElapsedMs < phaseLimitMs && ticks < maxTicks) {
    if (cancellation?.cancelled) {
      await stopPhaseCommand(sandboxId, commandId);
      throw new V2InvocationCancelledError(cancellation.reason);
    }
    const before = await observeBudget(!ignoreRemainingDuration);
    if (before.check.status !== "ok") {
      await stopPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError(before.check);
    }
    const sleepMs = ignoreRemainingDuration
      ? Math.min(tickMs, phaseLimitMs - phaseElapsedMs)
      : Math.min(tickMs, phaseLimitMs - phaseElapsedMs, before.remainingDurationMs);
    if (sleepMs <= 0) {
      const limit = before.durationLimitMs ?? before.activeElapsedMs ?? 0;
      const consumed = before.activeElapsedMs ?? limit;
      await stopPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit,
        consumed,
        reason: `budget_exceeded: duration ${consumed} reached limit ${limit} while command is active`,
      });
    }

    if (cancellation) {
      // Racing a step promise against the cancellation promise stays replay-safe:
      // the cancellation side is a plain in-memory promise resolved by an
      // in-process cancel() call (see createV2InvocationCancellationController),
      // so it produces no event of its own and cannot lose the race to a
      // recorded resolution.
      const cancelled = await Promise.race([
        delayPhasePollStep(Math.ceil(sleepMs)).then(() => false),
        cancellation.wait().then(() => true),
      ]);
      if (cancelled) {
        await stopPhaseCommand(sandboxId, commandId);
        throw new V2InvocationCancelledError(cancellation.reason);
      }
    } else {
      await delayPhasePollStep(Math.ceil(sleepMs));
    }
    phaseElapsedMs += sleepMs;
    ticks++;
    tickMs = Math.min(PHASE_POLL_TICK_MAX_MS, tickMs * tickGrowthFactor);
    await tuning.onTick?.({
      elapsedMs: phaseElapsedMs,
      ticks,
      sleepMs,
      remainingDurationMs: before.remainingDurationMs,
    });

    if (cancellation?.cancelled) {
      await stopPhaseCommand(sandboxId, commandId);
      throw new V2InvocationCancelledError(cancellation.reason);
    }
    const after = await observeBudget(false);
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) {
      record("finished");
      return true;
    }
    if (after.check.status !== "ok") {
      await stopPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError(after.check);
    }
    if (status === "stopped") {
      consecutiveStopped++;
      if (consecutiveStopped >= stoppedObservations) {
        record("sandbox_stopped");
        return false;
      }
    } else {
      consecutiveStopped = 0;
    }
    if (!ignoreRemainingDuration && after.remainingDurationMs === 0) {
      const limit = after.durationLimitMs ?? after.activeElapsedMs ?? 0;
      const consumed = after.activeElapsedMs ?? limit;
      await stopPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit,
        consumed,
        reason: `budget_exceeded: duration ${consumed} reached limit ${limit} while command is active`,
      });
    }
  }
  await stopPhaseCommand(sandboxId, commandId);
  record(ticks >= maxTicks ? "tick_cap" : "duration_cap");
  return false;
}

export async function stopPhaseCommand(
  sandboxId: string,
  commandId: string,
): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
    const command = await sandbox.getCommand(commandId);
    await command.kill();
  } catch {
    // The command or sandbox may already have stopped. Terminal teardown remains
    // responsible for the sandbox itself; budget handling must stay deterministic.
  }
}
stopPhaseCommand.maxRetries = 0;
