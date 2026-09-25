"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { IntegrationsListResponse } from "@shared/contracts";

import { apiClient } from "@/lib/api/client";

/**
 * "An integration changed": the signal every screen that shows one listens for.
 *
 * Each of those screens is a pure function of what the server rendered with, so
 * an admin whose colleague just disconnected something would keep reading
 * Connected, and an author would keep a palette the deployment can no longer
 * run. The signal carries no payload: what changed is the server's answer, and
 * a browser that worked it out for itself is the disagreement this avoids.
 *
 * One channel per document, kept open. A channel closed straight after
 * `postMessage` drops the message it was created to deliver. A channel never
 * delivers to the document that posted on it, so the tab making the change is
 * not woken by its own signal.
 */
const CHANNEL_NAME = "ai-workflow:integrations";

let shared: BroadcastChannel | null | undefined;

function channel(): BroadcastChannel | null {
  if (shared !== undefined) return shared;
  if (typeof BroadcastChannel !== "function") {
    shared = null;
    return shared;
  }
  try {
    shared = new BroadcastChannel(CHANNEL_NAME);
    // Node has a BroadcastChannel too, and an open one is a ref'd handle that
    // keeps the process alive forever. Any test that renders the editor would
    // hang after its last assertion, which is exactly what the dashboard suite
    // did. `unref` does not exist in a browser, where nothing is waiting to
    // exit, so the call is optional rather than branched on the environment.
    (shared as { unref?: () => void }).unref?.();
  } catch {
    shared = null;
  }
  return shared;
}

/** Tell every other tab of this browser that an integration was changed. */
export function publishIntegrationChange(): void {
  channel()?.postMessage("changed");
}

/** Coming back to the tab twice in a few seconds is one arrival, not two. */
const MIN_REFRESH_GAP_MS = 10_000;

/**
 * Re-render this screen from the server when an integration changes anywhere.
 *
 * `router.refresh()` re-runs the server component and leaves client state where
 * it is, which is the whole point: an unsaved canvas and a half-typed form both
 * survive it. Two things trigger it: the change signal, for another tab of this
 * browser, and coming back to the tab, which covers a change made by anybody
 * else. Every screen that shows an integration's status uses this, because a
 * screen that kept offering Disconnect for a connection somebody else already
 * erased is worse than one that flickers.
 *
 * What it does not preserve is anything typed: these pages read their data in
 * an async server component under a `Suspense` boundary, and that boundary
 * suspending again takes the client tree with it. A screen with a form passes
 * `enabled: false` while there is something to lose and tells the person
 * instead, which is also what leaves the stale version token in place for the
 * save to collide with.
 *
 * Telling them needs a change to tell them about. The signal is one: another
 * tab of this browser changed something. Coming back to the tab is not, it is
 * only a moment when somebody else's change may have landed, so while the
 * refresh is off it asks the server and compares (`changedSince`). A screen
 * that said "changed elsewhere" on every return to its window was saying it
 * about nothing most of the time, and a warning that is usually false is one
 * people learn to skip.
 */
export function useIntegrationChangeRefresh(
  options: {
    /**
     * False while a refresh would throw work away. A server component that
     * suspends again remounts the client tree under it, so on a screen with a
     * form the refresh empties the inputs: the caller says when that is the
     * wrong trade and hears about the change instead.
     */
    readonly enabled?: boolean;
    /** Called in place of the refresh while it is off, for a known change. */
    readonly onSuppressed?: () => void;
    /**
     * Whether what the server reports now differs from what this screen was
     * rendered from. Asked when the person comes back to the tab while the
     * refresh is off; without it a return says nothing, because a return is
     * not a change.
     */
    readonly changedSince?: (current: IntegrationsListResponse) => boolean;
  } = {},
): void {
  const router = useRouter();
  // When this screen last asked the server, by a refresh or a check.
  const lastAskedAt = useRef(0);
  // Read at the moment the signal arrives rather than when it was subscribed,
  // so nobody has to re-subscribe on every keystroke.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let unmounted = false;
    const refreshOrReport = () => {
      if (latest.current.enabled === false) {
        latest.current.onSuppressed?.();
        return;
      }
      lastAskedAt.current = Date.now();
      router.refresh();
    };
    const checkForChange = async () => {
      if (!latest.current.changedSince) return;
      const current = await apiClient.integrations.list().catch(() => null);
      // Read again after the wait: a save in between moves what this screen
      // was rendered from, and the comparison has to be against that.
      if (unmounted || !current?.ok || !latest.current.changedSince?.(current.data)) return;
      refreshOrReport();
    };
    const onArrival = () => {
      if (Date.now() - lastAskedAt.current < MIN_REFRESH_GAP_MS) return;
      lastAskedAt.current = Date.now();
      if (latest.current.enabled === false) {
        void checkForChange();
        return;
      }
      router.refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onArrival();
    };

    const unsubscribe = subscribeToIntegrationChanges(refreshOrReport);
    // A renderer without a document has no tab to come back to, so there is
    // nothing to listen for. Guarded rather than assumed: these screens are
    // rendered in tests that have no DOM, and a hook that threw there would
    // take those tests down over a listener it never needed.
    if (typeof window === "undefined" || typeof document === "undefined") {
      return () => {
        unmounted = true;
        unsubscribe();
      };
    }
    window.addEventListener("focus", onArrival);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unmounted = true;
      unsubscribe();
      window.removeEventListener("focus", onArrival);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);
}

/** Run `handler` when another tab reports a change. Returns the unsubscribe. */
function subscribeToIntegrationChanges(handler: () => void): () => void {
  const bus = channel();
  if (!bus) return () => {};
  const listener = () => handler();
  bus.addEventListener("message", listener);
  return () => bus.removeEventListener("message", listener);
}
