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
 * The tick is a sleeping step rather than a Workflow sleep() wait. See
 * poll-delay.ts: a wait here corrupts the run's event log as soon as two blocks
 * poll concurrently, which is why AIW-233 pinned V2_MAX_BLOCK_CONCURRENCY to 1.
 */
export async function pollPhaseUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxMinutes: number,
  commandId: string,
  observeBudget: (requireRemainingDuration?: boolean) => Promise<RunBudgetObservation>,
  cancellation?: V2InvocationCancellation,
): Promise<boolean> {
  const { delayPhasePollStep } = await import("./poll-delay.js");
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
    const sleepMs = Math.min(30_000, phaseLimitMs - phaseElapsedMs, before.remainingDurationMs);
    if (sleepMs <= 0) {
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
        await killPhaseCommand(sandboxId, commandId);
        throw new V2InvocationCancelledError(cancellation.reason);
      }
    } else {
      await delayPhasePollStep(Math.ceil(sleepMs));
    }
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
