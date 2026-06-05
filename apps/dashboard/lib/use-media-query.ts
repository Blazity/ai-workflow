// apps/dashboard/lib/use-media-query.ts
"use client";

import { useSyncExternalStore } from "react";

/**
 * SSR-safe media-query hook. Returns `false` during SSR and first paint, then
 * the real match after hydration — no layout thrash because we only use it for
 * runtime branching (e.g. the editor's touch affordances), never for the
 * desktop/mobile *layout* split (that's CSS `lg:` visibility).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (cb: () => void) => {
    if (typeof window === "undefined") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  };
  const getSnapshot = () =>
    typeof window !== "undefined" && window.matchMedia(query).matches;
  const getServerSnapshot = () => false;
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True below the `lg` breakpoint (1024px) — i.e. mobile/tablet chrome band. */
export function useIsMobileViewport(): boolean {
  return useMediaQuery("(max-width: 1023px)");
}
