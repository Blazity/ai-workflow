/**
 * The page a person opens for a ticket.
 *
 * A LEAF on purpose: no imports at all. The workflow body needs it, to put a
 * ticket link on a run's telemetry, and a Workflow DevKit function may not
 * reach a Node module. Importing it from `messaging.ts`, where it used to
 * live, dragged the messaging module, the integrations resolver, the logger
 * and `node:crypto` into the workflow bundle, which fails at the Vercel build
 * rather than anywhere a test would look. Nothing may be added here that
 * imports.
 */
const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Null rather than a guess for anything that is not a tracker key. Synthesized
 * subjects (a webhook delivery, a schedule occurrence, a pull request with no
 * ticket) have no page on the tracker, and `/browse/<that>` is always a 404.
 * Null again when no tracker is connected, because a link to nowhere helps
 * nobody.
 */
export function ticketUrlFor(ticketKey: string, baseUrl: string): string | null {
  if (!TICKET_KEY_PATTERN.test(ticketKey)) return null;
  const base = baseUrl.replace(/\/$/, "");
  return base === "" ? null : `${base}/browse/${ticketKey}`;
}
