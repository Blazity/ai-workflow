"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { PromptLibraryListResponse, PromptLibraryListRowDto } from "@shared/contracts";

export type PromptLibraryStatus = "loading" | "ready" | "error";

export interface PromptLibraryState {
  status: PromptLibraryStatus;
  /** Fetched with includeArchived=1; consumers filter (e.g. filterPrompts). */
  rows: PromptLibraryListRowDto[];
  refresh: () => void;
}

const noop = () => {};

// Safe default so usePromptLibrary() outside a provider reports "loading" with
// an empty library instead of throwing; the insert popup can render harmlessly.
const PromptLibraryContext = createContext<PromptLibraryState>({
  status: "loading",
  rows: [],
  refresh: noop,
});

/**
 * Loads the dashboard's prompt library once and shares it with any insert UI
 * mounted under the workflow editor. Fetches /api/prompt-library?includeArchived=1
 * on mount; refresh() refetches on demand (the popup calls it when it opens).
 */
export function PromptLibraryProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<PromptLibraryStatus>("loading");
  const [rows, setRows] = useState<PromptLibraryListRowDto[]>([]);
  // Incrementing token so a slow in-flight fetch can't overwrite a newer one
  // (clone of spotlight-search.tsx's reqId race guard).
  const reqId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++reqId.current;
    setStatus("loading");
    fetch("/api/prompt-library?includeArchived=1")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<PromptLibraryListResponse>;
      })
      .then((data) => {
        if (id !== reqId.current) return; // a newer refresh won
        setRows(data.prompts ?? []);
        setStatus("ready");
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <PromptLibraryContext.Provider value={{ status, rows, refresh }}>
      {children}
    </PromptLibraryContext.Provider>
  );
}

export function usePromptLibrary(): PromptLibraryState {
  return useContext(PromptLibraryContext);
}
