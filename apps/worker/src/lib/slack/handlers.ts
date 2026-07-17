import type {
  RunRegistryAdapter,
  ThreadStore,
} from "../../adapters/run-registry/types.js";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../../adapters/issue-tracker/types.js";
import { logger } from "../logger.js";
import { ticketSubjectKey } from "../subject-key.js";
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
  targetColumn?: IssueTrackerMoveTarget,
  onReleased?: (subjectKey: string) => Promise<void> | void,
) => Promise<boolean>;

export type StopTicketSandboxesFn = (
  sandboxIds: readonly string[],
) => Promise<unknown>;

export async function handleList(
  registry: RunRegistryAdapter,
  jiraBaseUrl: string,
): Promise<string> {
  const all = await registry.listAll();
  const live = all.flatMap((row) =>
    row.state === "bound" && row.runId && row.ticketKey
      ? [{ ticketKey: row.ticketKey, runId: row.runId }]
      : [],
  );
  return formatRunList(live, jiraBaseUrl);
}

export async function handleStatus(
  registry: RunRegistryAdapter,
  ticketKey: string,
  jiraBaseUrl: string,
): Promise<string> {
  // Sandbox lookup is best-effort: a missing or transiently-failing sandbox
  // shouldn't blank out the runId we *can* read.
  const entry = await registry.get(ticketSubjectKey("jira", ticketKey));
  const runId = entry?.state === "bound" ? entry.runId : null;
  let sandboxId: string | null = null;
  try {
    sandboxId = entry
      ? (await registry.listSandboxes(entry.subjectKey, entry.ownerToken))[0] ?? null
      : null;
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
  targetColumn?: IssueTrackerMoveTarget,
): Promise<string> {
  const entry = await registry.get(ticketSubjectKey("jira", ticketKey));
  if (!entry) return `No active run for ${ticketKey}.`;

  if (entry.state === "reserved") {
    let sandboxIds: string[] = [];
    try {
      sandboxIds = await registry.listSandboxes(entry.subjectKey, entry.ownerToken);
    } catch (err) {
      logger.warn(
        { ticketKey, error: (err as Error).message },
        "slack_cancel_sandbox_lookup_failed",
      );
    }

    const failures: string[] = [];
    try {
      await stopSandboxes(sandboxIds);
    } catch (err) {
      failures.push(`stopSandboxes: ${(err as Error).message}`);
      logger.error(
        { ticketKey, sandboxIds, error: (err as Error).message },
        "slack_cancel_stop_sandboxes_failed",
      );
    }
    try {
      const released = await registry.releaseReservation(entry.subjectKey, entry.ownerToken);
      if (!released) failures.push("reservation owner changed");
    } catch (err) {
      failures.push(`registry.releaseReservation: ${(err as Error).message}`);
      logger.error(
        { ticketKey, error: (err as Error).message },
        "slack_cancel_release_reservation_failed",
      );
    }

    if (failures.length > 0) {
      return `${ticketKey} is mid-dispatch; failed to clear the claim (${failures.join("; ")}). Check logs and retry.`;
    }
    return `${ticketKey} is mid-dispatch; cleared the claim. Try the cancel again in a moment if a real run shows up.`;
  }

  const runId = entry.runId;
  if (!runId) return `No active run for ${ticketKey}.`;
  const ok = await cancelRunFn(ticketKey, runId, registry, issueTracker, targetColumn);
  if (ok) return `Cancelled ${ticketKey} (runId \`${runId}\`).`;
  return `${ticketKey}: could not cancel run \`${runId}\` cleanly — owned sandboxes + registry were cleaned up.`;
}

export async function handleInspect(
  registry: RunRegistryAdapter & ThreadStore,
  ticketKey: string,
  jiraBaseUrl: string,
): Promise<string> {
  const entry = await registry.get(ticketSubjectKey("jira", ticketKey)).catch(() => null);
  const [sandboxIds, threadParent, isFailed] =
    await Promise.all([
      entry
        ? registry.listSandboxes(entry.subjectKey, entry.ownerToken).catch(() => [])
        : Promise.resolve([]),
      registry.getParent(ticketKey).catch(() => null),
      registry.isTicketFailed(ticketKey).catch(() => false),
    ]);
  return formatInspectTicket(ticketKey, jiraBaseUrl, {
    runId: entry?.runId ?? null,
    sandboxId: sandboxIds[0] ?? null,
    entryCreatedAt: entry?.createdAt ?? null,
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
  return formatInspectAll(
    active.flatMap((row) =>
      row.state === "bound" && row.runId && row.ticketKey
        ? [{ ticketKey: row.ticketKey, runId: row.runId }]
        : [],
    ),
    failed,
    jiraBaseUrl,
  );
}

export async function handleReset(
  registry: RunRegistryAdapter & ThreadStore,
  ticketKey: string,
): Promise<string> {
  const cleared: string[] = [];
  const failures: string[] = [];

  try {
    const entry = await registry.get(ticketSubjectKey("jira", ticketKey));
    if (entry?.state === "reserved") {
      const released = await registry.releaseReservation(entry.subjectKey, entry.ownerToken);
      if (released) cleared.push("reservation+sandboxes");
      else failures.push("reservation owner changed");
    } else if (entry?.state === "bound") {
      failures.push("active run owner requires cancel");
    }
  } catch (err) {
    failures.push(`active lookup/release: ${(err as Error).message}`);
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
