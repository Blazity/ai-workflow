import type {
  RunRegistryAdapter,
  ThreadStore,
} from "../../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import { isClaimingSentinel } from "../dispatch.js";
import { logger } from "../logger.js";
import {
  formatInspectAll,
  formatInspectTicket,
  formatRunList,
  formatRunStatus,
} from "./format.js";

export type CancelRunFn = (
  ticketKey: string,
  runId: string,
  registry: RunRegistryAdapter,
  issueTracker?: IssueTrackerAdapter,
  targetColumn?: string,
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
  issueTracker?: IssueTrackerAdapter,
  targetColumn?: string,
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

  const ok = await cancelRunFn(ticketKey, runId, registry, issueTracker, targetColumn);
  if (ok) return `Cancelled ${ticketKey} (runId \`${runId}\`).`;
  return `${ticketKey}: could not cancel run \`${runId}\` cleanly — sandbox + registry have been cleaned up.`;
}

export async function handleInspect(
  registry: RunRegistryAdapter & ThreadStore,
  ticketKey: string,
  jiraBaseUrl: string,
): Promise<string> {
  const [runId, sandboxId, entryCreatedAt, threadParent, isFailed] =
    await Promise.all([
      registry.getRunId(ticketKey).catch(() => null),
      registry.getSandboxId(ticketKey).catch(() => null),
      registry.getEntryCreatedAt(ticketKey).catch(() => null),
      registry.getParent(ticketKey).catch(() => null),
      registry.isTicketFailed(ticketKey).catch(() => false),
    ]);
  return formatInspectTicket(ticketKey, jiraBaseUrl, {
    runId,
    sandboxId,
    entryCreatedAt,
    threadParent,
    isFailed,
  });
}

export async function handleSummary(
  registry: RunRegistryAdapter & ThreadStore,
  jiraBaseUrl: string,
): Promise<string> {
  const [active, failed] = await Promise.all([
    registry.listAll().catch(() => []),
    registry.listAllFailed().catch(() => []),
  ]);
  return formatInspectAll(active, failed, jiraBaseUrl);
}

export async function handleReset(
  registry: RunRegistryAdapter & ThreadStore,
  ticketKey: string,
): Promise<string> {
  const cleared: string[] = [];
  const failures: string[] = [];

  try {
    await registry.unregister(ticketKey);
    cleared.push("active+sandbox+entry-ts");
  } catch (err) {
    failures.push(`unregister: ${(err as Error).message}`);
  }
  try {
    await registry.clearFailedMark(ticketKey);
    cleared.push("failed-mark");
  } catch (err) {
    failures.push(`clearFailedMark: ${(err as Error).message}`);
  }
  try {
    await registry.clearParent(ticketKey);
    cleared.push("thread-parent");
  } catch (err) {
    failures.push(`clearParent: ${(err as Error).message}`);
  }

  if (failures.length > 0) {
    logger.warn(
      { ticketKey, failures },
      "slack_reset_partial",
    );
    return `${ticketKey}: partial reset. Cleared ${cleared.join(", ")}. Failed: ${failures.join("; ")}.`;
  }
  return `${ticketKey}: reset Redis entries (${cleared.join(", ")}). Workflow run was NOT cancelled — use \`cancel\` for that.`;
}
