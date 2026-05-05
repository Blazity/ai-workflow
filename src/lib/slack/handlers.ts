import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import { isClaimingSentinel } from "../dispatch.js";
import { logger } from "../logger.js";
import { formatRunList, formatRunStatus } from "./format.js";

export type CancelRunFn = (
  ticketKey: string,
  runId: string,
  registry: RunRegistryAdapter,
) => Promise<boolean>;

export type StopTicketSandboxesFn = (
  ticketKey: string,
  sandboxId: string | null,
) => Promise<unknown>;

export async function handleList(
  registry: RunRegistryAdapter,
  jiraBaseUrl: string,
): Promise<string> {
  const all = await registry.listAll();
  const live = all.filter((row) => !isClaimingSentinel(row.runId));
  return formatRunList(live, jiraBaseUrl);
}

export async function handleStatus(
  registry: RunRegistryAdapter,
  ticketKey: string,
  jiraBaseUrl: string,
): Promise<string> {
  // Sandbox lookup is best-effort: a missing or transiently-failing sandbox
  // shouldn't blank out the runId we *can* read.
  const runId = await registry.getRunId(ticketKey);
  let sandboxId: string | null = null;
  try {
    sandboxId = await registry.getSandboxId(ticketKey);
  } catch (err) {
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "slack_status_sandbox_lookup_failed",
    );
  }
  return formatRunStatus(ticketKey, { runId, sandboxId }, jiraBaseUrl);
}

export async function handleCancel(
  registry: RunRegistryAdapter,
  ticketKey: string,
  cancelRunFn: CancelRunFn,
  stopSandboxes: StopTicketSandboxesFn,
): Promise<string> {
  const runId = await registry.getRunId(ticketKey);
  if (!runId) return `No active run for ${ticketKey}.`;

  if (isClaimingSentinel(runId)) {
    // Mid-dispatch: dispatch.ts has called start() but not yet swapped in the
    // real runId. We can't cancel a workflow whose id we don't know. Stop any
    // sandbox that may have leaked and clear the entry so the next dispatch
    // sees a clean slot — same shape as the jira webhook handles it.
    let sandboxId: string | null = null;
    try {
      sandboxId = await registry.getSandboxId(ticketKey);
    } catch (err) {
      logger.warn(
        { ticketKey, error: (err as Error).message },
        "slack_cancel_sandbox_lookup_failed",
      );
    }

    const failures: string[] = [];
    try {
      await stopSandboxes(ticketKey, sandboxId);
    } catch (err) {
      failures.push(`stopSandboxes: ${(err as Error).message}`);
      logger.error(
        { ticketKey, sandboxId, error: (err as Error).message },
        "slack_cancel_stop_sandboxes_failed",
      );
    }
    try {
      await registry.unregister(ticketKey);
    } catch (err) {
      failures.push(`registry.unregister: ${(err as Error).message}`);
      logger.error(
        { ticketKey, error: (err as Error).message },
        "slack_cancel_unregister_failed",
      );
    }

    if (failures.length > 0) {
      return `${ticketKey} is mid-dispatch; failed to clear the claim (${failures.join("; ")}). Check logs and retry.`;
    }
    return `${ticketKey} is mid-dispatch; cleared the claim. Try the cancel again in a moment if a real run shows up.`;
  }

  const ok = await cancelRunFn(ticketKey, runId, registry);
  if (ok) return `Cancelled ${ticketKey} (runId \`${runId}\`).`;
  return `${ticketKey}: could not cancel run \`${runId}\` cleanly — sandbox + registry have been cleaned up.`;
}
