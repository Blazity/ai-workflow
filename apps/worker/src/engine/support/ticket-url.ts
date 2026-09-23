/**
 * The page a person opens for a ticket, as the tracker that owns it links it.
 *
 * Core never spells a tracker's URL or its key grammar: the issue tracker port
 * says both (`ticketUrl` on `IssueTrackerAdapter`), and every place core shows
 * a ticket beside a run goes through the two functions below, so a tracker
 * whose pages live somewhere unusual, or a Site URL saved with a path, links
 * the same way on every surface. Until this moved, core built
 * `<Site URL>/browse/<KEY>` here from the raw connection value while the
 * tracker built its own links from the site's origin, and a Site URL with a
 * path gave every run view, message and MCP answer a link that went nowhere.
 *
 * A LEAF on purpose: no imports at all. The workflow body reads a ticket's
 * recorded link, and a Workflow DevKit function may not reach a Node module;
 * the messaging module, the integrations resolver, the logger and
 * `node:crypto` are what an import here once dragged into the workflow bundle,
 * which fails at the Vercel build rather than anywhere a test would look.
 * Nothing may be added here that imports.
 */

/** How the active tracker links a ticket key: null for a key it has no page for. */
export type TicketLinks = (ticketKey: string) => string | null;

/** A deployment with no tracker: no key has a page, and nothing is guessed. */
export const NO_TICKET_LINKS: TicketLinks = () => null;

/**
 * The links of a tracker core holds, or none.
 *
 * The port's own answer, and nothing core adds to it: null for a key that is
 * not one of the tracker's tickets (a webhook delivery, a schedule occurrence,
 * a pull request with no ticket), and null from a tracker that gives no
 * links. A tracker that throws gives none as well, because a link sits beside
 * something a person is already reading, and a run list must not stop
 * rendering over one.
 */
export function ticketLinksOf(
  tracker: { ticketUrl?(ticketKey: string): string | null } | null | undefined,
): TicketLinks {
  if (!tracker || typeof tracker.ticketUrl !== "function") return NO_TICKET_LINKS;
  return (ticketKey) => {
    try {
      return tracker.ticketUrl?.(ticketKey) ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * The link shown for a run's ticket.
 *
 * The tracker in force wins when it links the key ON THE SAME HOST as the link
 * the run recorded: that is the same site, and its answer today is the right
 * one, which repairs the links core used to spell itself (a Site URL saved
 * with a path gave `.../jira/browse/KEY`, a page that does not exist). A
 * recorded link on another host is kept: the tracker was reconnected to
 * another site since, or is another tracker, and the run's ticket lives where
 * it was read. With no recorded link the tracker in force links the key; with
 * neither, there is none.
 */
export function ticketLinkFor(
  recorded: string | null | undefined,
  ticketKey: string | null | undefined,
  links: TicketLinks,
): string | null {
  const current = ticketKey ? links(ticketKey) : null;
  if (!recorded) return current;
  return current !== null && hostOf(current) !== null && hostOf(current) === hostOf(recorded)
    ? current
    : recorded;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
