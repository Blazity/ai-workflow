import type { FailedTicketMeta } from "../../adapters/run-registry/types.js";

export interface RunRow {
  ticketKey: string;
  runId: string;
}

export interface RunStatusSnapshot {
  runId: string | null;
  sandboxId: string | null;
}

export interface InspectTicketSnapshot {
  runId: string | null;
  sandboxId: string | null;
  entryCreatedAt: number | null;
  threadParent: string | null;
  isFailed: boolean;
}

export function formatRunList(rows: RunRow[], jiraBaseUrl: string): string {
  if (rows.length === 0) return "No active workflows.";
  return rows
    .map(({ ticketKey, runId }) => `• ${jiraLink(ticketKey, jiraBaseUrl)} — runId: \`${runId}\``)
    .join("\n");
}

export function formatRunStatus(
  ticketKey: string,
  snapshot: RunStatusSnapshot,
  jiraBaseUrl: string,
): string {
  const link = jiraLink(ticketKey, jiraBaseUrl);
  if (!snapshot.runId) return `${link}: not tracked.`;
  const sandbox = snapshot.sandboxId ? "yes" : "no";
  return `${link}: runId \`${snapshot.runId}\`, sandbox: ${sandbox}`;
}

export function formatInspectTicket(
  ticketKey: string,
  jiraBaseUrl: string,
  snap: InspectTicketSnapshot,
): string {
  const link = jiraLink(ticketKey, jiraBaseUrl);
  const lines: string[] = [`*Inspect ${link}*`];
  lines.push(`• runId: ${snap.runId ? `\`${snap.runId}\`` : "_none_"}`);
  lines.push(`• sandboxId: ${snap.sandboxId ? `\`${snap.sandboxId}\`` : "_none_"}`);
  lines.push(
    `• entryCreatedAt: ${snap.entryCreatedAt ? new Date(snap.entryCreatedAt).toISOString() : "_none_"}`,
  );
  lines.push(`• threadParent: ${snap.threadParent ? `\`${snap.threadParent}\`` : "_none_"}`);
  lines.push(`• failed: ${snap.isFailed ? "yes" : "no"}`);
  return lines.join("\n");
}

export function formatInspectAll(
  active: RunRow[],
  failed: Array<{ ticketKey: string; meta: FailedTicketMeta }>,
  jiraBaseUrl: string,
): string {
  const lines: string[] = ["*Redis snapshot*"];
  lines.push(`*Active runs (${active.length}):*`);
  if (active.length === 0) {
    lines.push("• _none_");
  } else {
    for (const { ticketKey, runId } of active) {
      lines.push(`• ${jiraLink(ticketKey, jiraBaseUrl)} — \`${runId}\``);
    }
  }
  lines.push(`*Failed markers (${failed.length}):*`);
  if (failed.length === 0) {
    lines.push("• _none_");
  } else {
    for (const { ticketKey, meta } of failed) {
      lines.push(
        `• ${jiraLink(ticketKey, jiraBaseUrl)} — \`${meta.runId}\` (${meta.failedAt})`,
      );
    }
  }
  return lines.join("\n");
}

export const HELP_TEXT = [
  "*Blazebot commands*",
  "• `/ai-workflow list` — show every tracked workflow",
  "• `/ai-workflow status <KEY>` — show the run + sandbox tied to a ticket",
  "• `/ai-workflow cancel <KEY>` — cancel the workflow run + move ticket to backlog",
  "• `/ai-workflow inspect [KEY]` — dump Redis state for a ticket, or summary across all hashes",
  "• `/ai-workflow reset <KEY>` — clear Redis entries for a ticket (does NOT cancel the run)",
].join("\n");

function jiraLink(ticketKey: string, jiraBaseUrl: string): string {
  const base = jiraBaseUrl.replace(/\/$/, "");
  return `<${base}/browse/${ticketKey}|${ticketKey}>`;
}
