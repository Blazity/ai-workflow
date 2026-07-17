// localStorage-backed "recently inserted" prompt ids that feed the insert
// popup's RECENT group. Kept SSR-safe (no window access at import time) and
// pure at the core so node:test can exercise the parse/dedupe/cap logic through
// an injected store, mirroring the SSR guarding in lib/use-tweaks.ts.

const STORAGE_KEY = "aiwf:prompt-recent";
const MAX_RECENT = 8;

/** The slice of the Storage API we touch. Injectable so tests can drive the
 *  read/write round-trip without a DOM. */
export interface RecentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Pick the store: an injected one (tests) or window.localStorage when present.
// Returns null under SSR or when storage is blocked (private mode / quota).
function resolveStore(injected?: RecentStore): RecentStore | null {
  if (injected) return injected;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Keep only finite integer ids, dedupe (first occurrence wins), and cap to the
// newest MAX_RECENT entries. Pure: the whole point of the module's testability.
function normalize(ids: readonly unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ids) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

/** Read the recent prompt ids, most recent first. Returns [] under SSR, when
 *  storage is unavailable, or when the stored value is missing or corrupt. */
export function readRecentPromptIds(store?: RecentStore): number[] {
  const s = resolveStore(store);
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalize(parsed);
  } catch {
    return [];
  }
}

/** Move a prompt id to the front of the recent list, deduped and capped. No-op
 *  under SSR or when storage is unavailable. */
export function pushRecentPromptId(id: number, store?: RecentStore): void {
  const s = resolveStore(store);
  if (!s) return;
  const next = normalize([id, ...readRecentPromptIds(store)]);
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full / blocked: the recent list is a nicety, not critical state.
  }
}
