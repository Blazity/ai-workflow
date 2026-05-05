export interface RunRow {
  ticketKey: string;
  runId: string;
}

export interface RunStatusSnapshot {
  runId: string | null;
  sandboxId: string | null;
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

export const HELP_TEXT = [
  "*Blazebot commands*",
  "• `/ai-workflow list` — show every tracked workflow",
  "• `/ai-workflow status <KEY>` — show the run + sandbox tied to a ticket",
  "• `/ai-workflow cancel <KEY>` — cancel the workflow run for a ticket",
].join("\n");

function jiraLink(ticketKey: string, jiraBaseUrl: string): string {
  const base = jiraBaseUrl.replace(/\/$/, "");
  return `<${base}/browse/${ticketKey}|${ticketKey}>`;
}
