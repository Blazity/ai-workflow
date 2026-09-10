/**
 * Dashboard deep links the workflow embeds in Slack notifications and the
 * one-time Jira pickup comment. Mirrors the dashboard's own scheme in
 * apps/dashboard/lib/run-href.ts: a ticket run opens the ticket view with the
 * run preselected.
 */

/** Ticket view with a specific run preselected: `<origin>/ticket/<key>?run=<runId>`. */
export function ticketRunUrl(origin: string, ticketKey: string, runId: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/ticket/${encodeURIComponent(ticketKey)}?run=${encodeURIComponent(runId)}`;
}

/** Ticket view without a run param; the view auto-selects the newest run. */
export function ticketPageUrl(origin: string, ticketKey: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/ticket/${encodeURIComponent(ticketKey)}`;
}

/** Workflow editor opened on one definition: `<origin>/editor?definition=<id>`.
 *  The page reads exactly this parameter and ignores anything that is not digits
 *  (apps/dashboard/app/(cockpit)/editor/page.tsx). */
export function workflowDefinitionUrl(origin: string, definitionId: number): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/editor?definition=${definitionId}`;
}

/** Prompt library with one prompt selected: `<origin>/prompts?prompt=<id>`, the
 *  parameter the library screen selects by (apps/dashboard/lib/prompt-library/
 *  query-selection.ts). */
export function promptLibraryUrl(origin: string, promptId: number): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/prompts?prompt=${promptId}`;
}

/**
 * True when any comment already links to this ticket's dashboard view. The deep
 * link itself is the pickup marker: the workflow posts exactly one dashboard
 * link per ticket, so its presence in a comment body means the pickup comment
 * was already posted and must not be posted again.
 */
export function hasDashboardLinkComment(
  comments: Array<{ body: string }>,
  ticketKey: string,
): boolean {
  // URI-encode first so the marker matches what ticketRunUrl/ticketPageUrl
  // actually emit, then regex-escape. Anchored so a key never matches its own
  // prefix (AWT-4 vs /ticket/AWT-42): the marker must be followed by a query
  // string, whitespace, or the end.
  const escaped = encodeURIComponent(ticketKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`/ticket/${escaped}(?![\\w-])`);
  return comments.some((c) => marker.test(c.body));
}
