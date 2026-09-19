"use client";

/**
 * Whether this instance of a view is the one a person can see.
 *
 * The ticket page mounts its detail twice, the desktop split and the phone
 * view, and hides one with CSS. Both are live React trees: without this, a
 * phone downloads the desktop tree's briefings as well as its own, and every
 * request and byte is paid twice.
 *
 * `null` means "not measured yet": the first render asks for nothing, the
 * layout effect answers before paint, and a caller loads only on `true`. Where
 * there is no DOM (the server, the test renderer) the answer is `true`, so
 * nothing is hidden from a render that has no layout at all.
 */
import React from "react";

export function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean | null {
  const [onScreen, setOnScreen] = React.useState<boolean | null>(null);
  React.useLayoutEffect(() => {
    const read = () => {
      const node = ref.current;
      setOnScreen(node === null || typeof node.getClientRects !== "function" || node.getClientRects().length > 0);
    };
    read();
    // The breakpoint decides which twin is on screen, so a resize can swap
    // them while both are mounted.
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [ref]);
  return onScreen;
}
