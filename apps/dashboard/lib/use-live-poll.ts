// apps/dashboard/lib/use-live-poll.ts
"use client";

import { useEffect, useRef } from "react";
import { createLivePoll } from "./live-poll";

/**
 * Calls `onTick` every `intervalMs` while `enabled`, pausing when the browser
 * tab is hidden (and firing once immediately when it becomes visible again).
 * Thin DOM/React adapter over the pure `createLivePoll` controller.
 */
export function useLivePoll({
  enabled,
  intervalMs,
  onTick,
}: {
  enabled: boolean;
  intervalMs: number;
  onTick: () => void;
}): void {
  // Keep the latest onTick without restarting the interval on its identity change.
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  useEffect(() => {
    if (!enabled) return;

    const poll = createLivePoll({
      intervalMs,
      onTick: () => onTickRef.current(),
      isHidden: () => document.visibilityState === "hidden",
      subscribeVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
    });
    poll.start();
    return () => poll.stop();
  }, [enabled, intervalMs]);
}
