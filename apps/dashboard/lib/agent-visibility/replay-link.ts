/**
 * Where a person is in a run's replay, kept in the page URL so a refresh, or a
 * link sent to a colleague, lands on the same block attempt, tab, send and
 * section.
 *
 * Written with `history.replaceState`, which the App Router follows without a
 * navigation, so moving around a replay never refetches the page and never
 * adds a history entry per click (Back leaves the replay, as it did). Every
 * other query parameter (the ticket page's `run`) is kept as it is.
 */

export interface ReplayLink {
  /** The block (node id) of the selected attempt. */
  node: string | null;
  /** The selected Block Attempt, by its replay id. */
  attempt: number | null;
  tab: string | null;
  /** The selected send, by its briefing id. The id and not the worker's
   *  sequence number: a record this build cannot read carries no sequence, so
   *  a number would have to be invented and would collide with a real one. */
  send: string | null;
  /** The open section by index, `map` for the repository map, or `sources`. */
  section: string | null;
}

const NAMES = ["node", "attempt", "tab", "send", "section"] as const;

const WHOLE = /^[0-9]{1,9}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,200}$/;

function token(value: string | null): string | null {
  return value !== null && TOKEN.test(value) ? value : null;
}

function whole(value: string | null): number | null {
  return value !== null && WHOLE.test(value) ? Number(value) : null;
}

export function readReplayLink(search: string): ReplayLink {
  const params = new URLSearchParams(search);
  return {
    node: token(params.get("node")),
    attempt: whole(params.get("attempt")),
    tab: token(params.get("tab")),
    send: token(params.get("send")),
    section: token(params.get("section")),
  };
}

/** `search` with the given link fields set (null removes one). */
export function withReplayLink(search: string, patch: Partial<ReplayLink>): string {
  const params = new URLSearchParams(search);
  for (const name of NAMES) {
    if (!(name in patch)) continue;
    const value = patch[name];
    if (value === null || value === undefined) params.delete(name);
    else params.set(name, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Where the page says it is, or null when nothing can say.
 *
 * Not every `window` is a browser's: a server render has none at all, and a
 * test renderer's stub is whatever that test needed (a `localStorage`, a
 * `confirm`). Reading `location` off one of those throws, and a screen that
 * only wants to know which tab is open must not take a page down with it.
 */
function browserLocation(): { search: string; pathname: string; hash: string } | null {
  if (typeof window === "undefined") return null;
  const location = (window as Partial<Window>).location;
  return location && typeof location.search === "string" ? location : null;
}

/** The link as the browser shows it now; empty where there is no location. */
export function currentReplayLink(): ReplayLink {
  return readReplayLink(browserLocation()?.search ?? "");
}

/** Updates the browser URL in place. A no-op where there is no location to
 *  update, and when nothing changes. */
export function writeReplayLink(patch: Partial<ReplayLink>): void {
  const location = browserLocation();
  if (!location || typeof window.history?.replaceState !== "function") return;
  const next = withReplayLink(location.search, patch);
  if (next === location.search) return;
  // `null`, as the App Router documents it: its own state object carries a
  // marker that makes the router skip syncing the new URL.
  window.history.replaceState(null, "", `${location.pathname}${next}${location.hash}`);
}
