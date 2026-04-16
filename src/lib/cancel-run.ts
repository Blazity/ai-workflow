import { getRun } from "workflow/api";
import { logger } from "./logger.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import { stopTicketSandboxes } from "../sandbox/stop-ticket-sandboxes.js";

/**
 * Cancel a workflow run and unregister it from the registry.
 * Idempotent: safe to call multiple times for the same ticket.
 * Returns true if cancel succeeded, false if it errored (still unregisters).
 */
export async function cancelRun(
  ticketKey: string,
  runId: string,
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  let cancelled = false;
  try {
    const run = getRun(runId);
    await run.cancel();
    cancelled = true;
  } catch (err) {
    logger.warn(
      { ticketKey, runId, error: (err as Error).message },
      "cancel_run_error",
    );
  }

  await stopTicketSandboxes(ticketKey).catch(() => {});
  await runRegistry.unregister(ticketKey).catch(() => {});
  return cancelled;
}
