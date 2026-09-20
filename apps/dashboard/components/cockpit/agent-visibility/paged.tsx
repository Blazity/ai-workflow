"use client";

/**
 * Loading a sequence of pages (a list by cursor, a section's text by byte
 * offset) one request at a time.
 *
 * Three promises every view built on it keeps:
 * - A response to an earlier selection never lands under a newer one: each
 *   request remembers the key it was made for and is dropped if the key moved.
 * - A failure keeps whatever was already loaded; it is shown beside it.
 * - What was loaded for a key survives the view unmounting (switching pass and
 *   back, a live poll re-rendering the tab), through `PagedCacheProvider`. A
 *   recorded briefing never changes, so its pages are never refetched.
 */
import React from "react";

import type { LoadFailure, Loaded } from "@/lib/agent-visibility/load";

interface Stored {
  pages: unknown[];
  next: unknown;
  done: boolean;
}

const PagedCacheContext = React.createContext<Map<string, Stored> | null>(null);

export function PagedCacheProvider({ children }: { children: React.ReactNode }) {
  const [cache] = React.useState(() => new Map<string, Stored>());
  return <PagedCacheContext.Provider value={cache}>{children}</PagedCacheContext.Provider>;
}

interface PagedState<P, C> {
  pages: P[];
  /** Where the next page starts; null once the last page is in. */
  next: C | null;
  done: boolean;
  loading: boolean;
  failure: LoadFailure | null;
}

export interface Paged<P, C> extends PagedState<P, C> {
  loadMore: () => Promise<void>;
  /** Loads until `enough` holds for the pages, the sequence ends, or a load
   *  fails; resolves to the pages loaded by then. */
  loadUntil: (enough: (pages: readonly P[]) => boolean) => Promise<readonly P[]>;
  loadAll: () => Promise<readonly P[]>;
}

export function usePagedSequence<P, C>({
  key,
  first,
  fetch,
  nextOf,
  eager,
}: {
  /** What is being loaded; null loads nothing. A new key starts over. */
  key: string | null;
  first: C;
  fetch: (cursor: C, signal: AbortSignal) => Promise<Loaded<P>>;
  nextOf: (page: P) => C | null;
  /** On a new key: load nothing, the first page, or every page. */
  eager: "none" | "first" | "all";
}): Paged<P, C> {
  const cache = React.useContext(PagedCacheContext);
  const fresh = React.useCallback((): PagedState<P, C> => {
    const stored = key === null ? undefined : cache?.get(key);
    return stored
      ? { pages: stored.pages as P[], next: stored.next as C | null, done: stored.done, loading: false, failure: null }
      : { pages: [], next: first, done: false, loading: false, failure: null };
    // `first` is a value of the key; a new first always comes with a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key]);
  const [state, setState] = React.useState<PagedState<P, C>>(fresh);
  const stateRef = React.useRef(state);
  const keyRef = React.useRef(key);
  const inFlight = React.useRef<Promise<void> | null>(null);
  const requestId = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const fetchRef = React.useRef(fetch);
  const nextOfRef = React.useRef(nextOf);
  React.useEffect(() => {
    fetchRef.current = fetch;
    nextOfRef.current = nextOf;
  });

  const commit = React.useCallback(
    (next: PagedState<P, C>) => {
      stateRef.current = next;
      setState(next);
      if (keyRef.current !== null && cache && !next.loading) {
        cache.set(keyRef.current, { pages: next.pages, next: next.next, done: next.done });
      }
    },
    [cache],
  );

  const loadMore = React.useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const current = stateRef.current;
    const requestKey = keyRef.current;
    if (requestKey === null || current.done) return Promise.resolve();
    // A list's first cursor is null, so null is a cursor here; `done` says
    // when there is nothing left.
    const cursor = current.next as C;
    const abort = new AbortController();
    abortRef.current = abort;
    commit({ ...current, loading: true, failure: null });
    // Numbered, so the request that finishes clears `inFlight` only while it
    // is still the one in flight: a later request must not be dropped by an
    // earlier one's `finally`.
    const id = requestId.current + 1;
    requestId.current = id;
    const request = (async () => {
      try {
        const loaded = await fetchRef.current(cursor, abort.signal);
        if (keyRef.current !== requestKey) return;
        const latest = stateRef.current;
        if (!loaded.ok) {
          commit({ ...latest, loading: false, failure: loaded.failure });
          return;
        }
        const next = nextOfRef.current(loaded.value);
        commit({ pages: [...latest.pages, loaded.value], next, done: next === null, loading: false, failure: null });
      } catch (error) {
        if (keyRef.current !== requestKey || abort.signal.aborted) return;
        commit({
          ...stateRef.current,
          loading: false,
          failure: { kind: "unavailable", status: null, message: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        if (requestId.current === id) inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [commit]);

  const loadUntil = React.useCallback(
    async (enough: (pages: readonly P[]) => boolean): Promise<readonly P[]> => {
      const requestKey = keyRef.current;
      for (;;) {
        const current = stateRef.current;
        if (keyRef.current !== requestKey || current.done || current.failure || enough(current.pages)) {
          return current.pages;
        }
        const before = current.pages.length;
        await loadMore();
        const after = stateRef.current;
        if (after.pages.length === before && !after.done && !after.failure) return after.pages;
      }
    },
    [loadMore],
  );

  const loadAll = React.useCallback(() => loadUntil(() => false), [loadUntil]);

  React.useEffect(() => {
    keyRef.current = key;
    abortRef.current?.abort();
    inFlight.current = null;
    const initial = fresh();
    stateRef.current = initial;
    setState(initial);
    if (key !== null && !initial.done) {
      if (eager === "all") void loadAll();
      else if (eager === "first" && initial.pages.length === 0) void loadMore();
    }
    return () => abortRef.current?.abort();
    // `eager` is how a key starts; changing it for the same key starts nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fresh]);

  return { ...state, loadMore, loadUntil, loadAll };
}
