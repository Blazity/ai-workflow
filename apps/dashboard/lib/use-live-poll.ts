// apps/dashboard/lib/use-live-poll.ts
"use client";

import { useEffect, useRef, useState } from "react";
import { createLivePoll } from "./live-poll";

/** Live-mode poll cadence (ms). Single source of truth — tune here. */
export const LIVE_POLL_MS = 5000;

/**
 * Cadence for a surface that is still worth watching but has nothing in flight —
 * a runs list whose visible runs have all finished still has to notice the next
 * run starting. Slower rather than stopped, which is what AIW-266 asks for.
 */
export const IDLE_POLL_MS = 30_000;

/**
 * Calls `onTick` every `intervalMs` while `enabled`, pausing when the browser
 * tab is hidden (and firing once immediately when it becomes visible again).
 * Thin DOM/React adapter over the pure `createLivePoll` controller.
 *
 * Returns whether the interval is running right now, so the UI can report the
 * real state instead of the intent.
 */
export function useLivePoll({
  enabled,
  intervalMs,
  onTick,
}: {
  enabled: boolean;
  intervalMs: number;
  onTick: () => void;
}): boolean {
  // Keep the latest onTick without restarting the interval on its identity change.
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }

    const poll = createLivePoll({
      intervalMs,
      onTick: () => onTickRef.current(),
      onRunningChange: setRunning,
      isHidden: () => document.visibilityState === "hidden",
      subscribeVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        // Not every way back into a tab delivers `visibilitychange` (window
        // managers, extension-driven focus). Regained window focus is a second,
        // harmless chance to resume: the handler no-ops when already running.
        window.addEventListener("focus", cb);
        return () => {
          document.removeEventListener("visibilitychange", cb);
          window.removeEventListener("focus", cb);
        };
      },
    });
    poll.start();
    return () => {
      poll.stop();
      setRunning(false);
    };
  }, [enabled, intervalMs]);

  return running;
}
