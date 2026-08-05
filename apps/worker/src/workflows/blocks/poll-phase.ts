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
      const cancelled = await Promise.race([
        sleep(`${Math.ceil(sleepMs)}ms`).then(() => false),
        cancellation.wait().then(() => true),
      ]);
      if (cancelled) {
        await killPhaseCommand(sandboxId, commandId);
        throw new V2InvocationCancelledError(cancellation.reason);
      }
    } else {
      await sleep(`${Math.ceil(sleepMs)}ms`);
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
