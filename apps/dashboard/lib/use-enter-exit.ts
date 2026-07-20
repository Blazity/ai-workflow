"use client";

import { useEffect, useRef, useState } from "react";

export type EnterExitState = "open" | "closed";

/**
 * Drives enter/exit transitions for an element without a motion library.
 *
 * While `open` is true the element mounts and its `state` flips to "open" on the
 * next frame, so a CSS transition keyed on `[data-state="open"]` animates it in.
 * When `open` goes false, `state` flips to "closed" (the exit transition) and the
 * element stays mounted for `durationMs` so the exit is actually visible instead
 * of the node vanishing. A timeout (not `transitionend`) drives the unmount so a
 * multi-property transition can't strand the element mounted.
 *
 * An element already open on first render mounts directly in the "open" state, so
 * it does not animate in on page load (only on later open toggles).
 */
export function useEnterExit(
  open: boolean,
  durationMs = 200,
): { mounted: boolean; state: EnterExitState } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<EnterExitState>(open ? "open" : "closed");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (open) {
      setMounted(true);
      // Mount in "closed", then flip to "open" next frame so the browser has an
      // initial style to transition FROM.
      const raf = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(raf);
    }
    setState("closed");
    timer.current = window.setTimeout(() => {
      setMounted(false);
      timer.current = null;
    }, durationMs);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open, durationMs]);

  return { mounted, state };
}
