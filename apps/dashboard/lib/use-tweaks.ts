"use client";

// lib/use-tweaks.ts
// Ported from .design_tmp/ai-workflow/project/tweaks-panel.jsx (useTweaks).
//
// The prototype persisted tweak values through a host postMessage protocol
// (__edit_mode_set_keys). In Next.js there is no host frame, so we persist to
// localStorage instead. The hook stays SSR-safe: state initializes from the
// passed-in `defaults` on first render (matching the server-rendered markup),
// then hydrates from localStorage in an effect to avoid a hydration mismatch.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "aiwf:tweaks";

export function useTweaks<T extends Record<string, unknown>>(
  defaults: T,
): [T, <K extends keyof T>(key: K, value: T[K]) => void] {
  // First render (and SSR) always starts from defaults so server and client
  // markup agree. Persisted values are layered in via the effect below.
  const [values, setValues] = useState<T>(defaults);

  // Hydrate from localStorage after mount. Guard window access for SSR.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<T>;
      // Only merge keys we know about so stale/foreign keys can't leak in.
      setValues((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(prev) as (keyof T)[]) {
          if (k in stored) next[k] = stored[k] as T[typeof k];
        }
        return next;
      });
    } catch {
      // Corrupt/blocked storage — fall back to defaults.
    }
    // defaults is the initial source of truth; re-running on identity changes
    // would clobber user edits, so we intentionally run this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTweak = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => {
      setValues((prev) => {
        const next = { ...prev, [key]: value };
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            // Storage unavailable (private mode / quota) — state still updates.
          }
        }
        // Same-window signal so in-page listeners can react, mirroring the
        // prototype's `tweakchange` CustomEvent dispatch.
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("tweakchange", { detail: { [key]: value } }),
          );
        }
        return next;
      });
    },
    [],
  );

  return [values, setTweak];
}
