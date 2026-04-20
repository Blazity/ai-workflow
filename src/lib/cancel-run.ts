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

  // Look up the sandboxId first so the stop path is O(1) instead of a
  // branch-scan across every running sandbox. Best-effort — if this
  // lookup errors or returns null, stopTicketSandboxes falls back to the
  // parallel branch scan.
  const sandboxId = await runRegistry.getSandboxId(ticketKey).catch(() => null);
  await stopTicketSandboxes(ticketKey, sandboxId).catch(() => {});
  await runRegistry.unregister(ticketKey).catch(() => {});
  return cancelled;
}
