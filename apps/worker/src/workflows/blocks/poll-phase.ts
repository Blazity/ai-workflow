import { RunBudgetError, type RunBudgetObservation } from "../run-budget.js";
import {
  V2InvocationCancelledError,
  type V2InvocationCancellation,
} from "../../workflow-definition/invocation-context.js";

/**
 * Wait for an agent phase's sentinel file, polling every 30s up to maxMinutes.
 * Returns false when the phase stopped without finishing or the cap ran out.
 * Plain async orchestration (not a "use step"): it drives the checkPhaseDone
 * step, so it is safe to share between block executors.
 *
 * Every await in this loop must be reproducible on replay. Blocks that poll run
 * concurrently in a fan-out, and the workflow runtime replays the whole function
 * to rebuild its state, matching recorded step events to call sites in the order
 * they are reached. If one loop's timing shifts, a later step event is handed to
 * a different block's call site, the runtime reports a replay divergence and,
 * after its recovery attempts, discards the run with CORRUPTED_EVENT_LOG. That
 * failure arrives with no diagnostic of ours attached, because our error paths
 * never run: the whole run is thrown away.
 *
 * Concretely, this means the sleep duration is computed only from constants and
 * this loop's own counter, and nothing here races a durable await against a
 * plain in-memory promise. Both rules cost a little responsiveness and buy the
 * only thing that matters here, a run that survives its own replay.
 */
export async function pollPhaseUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxMinutes: number,
  commandId: string,
  observeBudget: (requireRemainingDuration?: boolean) => Promise<RunBudgetObservation>,
  cancellation?: V2InvocationCancellation,
): Promise<boolean> {
  const { sleep } = await import("workflow");
  const { checkPhaseDone } = await import("../../sandbox/poll-agent.js");
  const phaseLimitMs = maxMinutes * 60_000;
  let phaseElapsedMs = 0;
  while (phaseElapsedMs < phaseLimitMs) {
    if (cancellation?.cancelled) {
      await killPhaseCommand(sandboxId, commandId);
      throw new V2InvocationCancelledError(cancellation.reason);
    }
    const before = await observeBudget(true);
    if (before.check.status !== "ok") {
      await killPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError(before.check);
    }
    // The sleep length is derived only from constants and this loop's own
    // counter, never from the run budget. Several agent blocks poll at once
    // while sharing one budget accumulator, so a budget-derived duration is not
    // reproducible on replay: the workflow runtime then matches recorded step
    // events to the wrong call site and kills the run with CORRUPTED_EVENT_LOG
    // instead of any failure we could report. Budget exhaustion is still
    // enforced, by the guard below and by the check after the sleep; the only
    // cost is noticing an exhausted duration budget up to one interval late.
    const sleepMs = Math.min(30_000, phaseLimitMs - phaseElapsedMs);
    if (sleepMs <= 0 || before.remainingDurationMs <= 0) {
      const limit = before.durationLimitMs ?? before.activeElapsedMs ?? 0;
      const consumed = before.activeElapsedMs ?? limit;
      await killPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit,
        consumed,
        reason: `budget_exceeded: duration ${consumed} reached limit ${limit} while command is active`,
      });
    }

    // Never race this durable sleep against the cancellation promise. That
    // promise lives in memory only, so a replay recreates it unresolved and the
    // race can settle differently than it did on the original pass, which is
    // the same event-log corruption described above. The check right after the
    // sleep already picks a sibling's failure up, one interval later at worst.
    await sleep(`${Math.ceil(sleepMs)}ms`);
    phaseElapsedMs += sleepMs;

    if (cancellation?.cancelled) {
      await killPhaseCommand(sandboxId, commandId);
      throw new V2InvocationCancelledError(cancellation.reason);
    }
    const after = await observeBudget(false);
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) return true;
    if (after.check.status !== "ok") {
      await killPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError(after.check);
    }
    if (status === "stopped") return false;
    if (after.remainingDurationMs === 0) {
      const limit = after.durationLimitMs ?? after.activeElapsedMs ?? 0;
      const consumed = after.activeElapsedMs ?? limit;
      await killPhaseCommand(sandboxId, commandId);
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit,
        consumed,
        reason: `budget_exceeded: duration ${consumed} reached limit ${limit} while command is active`,
      });
    }
  }
  await killPhaseCommand(sandboxId, commandId);
  return false;
}

async function killPhaseCommand(sandboxId: string, commandId: string): Promise<void> {
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
killPhaseCommand.maxRetries = 0;
