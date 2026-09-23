// apps/dashboard/lib/window.ts
// Shared time-window vocabulary for the dashboard. Mirrors the worker's
// whitelist (apps/worker/src/db/queries/runs-read.ts) so the value the UI sends
// is always one the worker accepts; the worker re-validates regardless.

export const WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type TimeWindow = (typeof WINDOWS)[number];

/** Normalize a raw search-param value to a known window; anything else → "24h". */
export function parseWindow(raw: string | string[] | undefined): TimeWindow {
  return typeof raw === "string" && (WINDOWS as readonly string[]).includes(raw)
    ? (raw as TimeWindow)
    : "24h";
}

/** Compact label for the segmented control. */
export function windowShort(w: TimeWindow): string {
  return w === "all" ? "All" : w;
}

/** Sentence-fragment label for headers, e.g. "last 7 days". */
export function windowPhrase(w: TimeWindow): string {
  switch (w) {
    case "24h":
      return "last 24h";
    case "7d":
      return "last 7 days";
    case "30d":
      return "last 30 days";
    case "all":
      return "all time";
  }
}

/** "vs prior 24h" etc., empty for "all", which has no comparable prior period. */
export function windowDeltaSuffix(w: TimeWindow): string {
  return w === "all" ? "" : `vs prior ${w}`;
}

/** How far back a window reaches, in minutes, the way the worker cuts its run
 *  reads off (`bounds` in its dashboard run data); "all" has no cutoff. */
export function windowMinutes(window: TimeWindow): number {
  switch (window) {
    case "24h":
      return 24 * 60;
    case "7d":
      return 7 * 24 * 60;
    case "30d":
      return 30 * 24 * 60;
    case "all":
      return Number.POSITIVE_INFINITY;
  }
}
