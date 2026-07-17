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
