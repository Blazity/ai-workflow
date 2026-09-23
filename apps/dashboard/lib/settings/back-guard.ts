// apps/dashboard/lib/settings/back-guard.ts
//
// The browser's Back and Forward, and a phone's back gesture, while a screen
// holds unsaved work.
//
// The cockpit's own links ask first (the shell's `navigate`), and a reload or
// a closed tab asks through `beforeunload` (`useUnsavedWork`). Back did
// neither: the App Router handles `popstate` inside the page, no unload
// happens, and a pasted API token was gone with no word. On a phone the back
// gesture is the main way off a screen.
//
// The router listens for `popstate` on `window` without `capture`. A listener
// registered WITH `capture` on the same target runs first (the DOM dispatch
// algorithm invokes capturing listeners at the target before the others), so
// this one can ask, and on a no stop the event before the router sees it. The
// URL has already moved by then, so it is put back by pushing the entry that
// was on screen, with the router's own state: the router's patched `pushState`
// passes an entry carrying its state straight through without navigating.

import { DISCARD_UNSAVED_PROMPT } from "./unsaved";

/** The parts of `window` this reads, so a test can hand it a document of its own. */
export interface HistoryTraversalWindow {
  addEventListener(type: "popstate", listener: (event: Event) => void, options: { capture: true }): void;
  removeEventListener(type: "popstate", listener: (event: Event) => void, options: { capture: true }): void;
  readonly history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  readonly location: { readonly href: string };
  confirm(message?: string): boolean;
}

export interface HistoryTraversalGuard {
  /** Records the entry on screen, to put back if a Back is declined. Call
   *  after every render: the router rewrites the entry's state as it goes. */
  remember(): void;
  dispose(): void;
}

export function guardHistoryTraversal(
  win: HistoryTraversalWindow,
  ask: {
    /** Whether leaving would throw away unsaved work nobody agreed to lose. */
    readonly holdsUnsavedWork: () => boolean;
    /** Told when the person agreed, so the next question is not asked twice. */
    readonly agreedToLeave: () => void;
  },
): HistoryTraversalGuard {
  let held: { state: unknown; href: string } | null = null;

  const onPopState = (event: Event) => {
    if (!ask.holdsUnsavedWork()) return;
    if (win.confirm(DISCARD_UNSAVED_PROMPT)) {
      ask.agreedToLeave();
      return;
    }
    event.stopImmediatePropagation();
    if (held) win.history.pushState(held.state, "", held.href);
  };

  win.addEventListener("popstate", onPopState, { capture: true });
  return {
    remember() {
      held = { state: win.history.state, href: win.location.href };
    },
    dispose() {
      win.removeEventListener("popstate", onPopState, { capture: true });
    },
  };
}
