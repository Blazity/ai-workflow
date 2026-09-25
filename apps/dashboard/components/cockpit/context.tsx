"use client";

import { createContext, useContext } from "react";
import type { Run } from "@/lib/types";
import { LIVE_POLL_MS } from "@/lib/use-live-poll";

type Density = "compact" | "comfy";

/**
 * How often a mounted run surface needs the cockpit to refresh it.
 * - `live`: something is in flight, refresh at the live cadence.
 * - `idle`: nothing in flight, but the surface still has to notice new work
 *   arriving (a runs list), so keep watching at a slower cadence.
 * - `off`: nothing here can change any more (a terminal run's trace).
 */
export type RunRefreshCadence = "off" | "idle" | "live";

export type Tweaks = {
  density: Density;
  showEditorialHero: boolean;
  showStreamingRun: boolean;
  /** Collapses the cockpit sidebar to an icon-only rail; persists across visits. */
  sidebarCollapsed: boolean;
  /**
   * Sidebar groups this person has folded away, by group id. Persisted, because
   * the number of entries below the Integrations separator is not ours to
   * decide and folding the core groups is how somebody with ten of them keeps
   * the column readable.
   */
  collapsedNavGroups: string[];
  accentColor: string;
  /** When on, the cockpit polls and refreshes the active screen's data. */
  livePolling: boolean;
};

export const TWEAK_DEFAULTS: Tweaks = {
  density: "comfy",
  showEditorialHero: false,
  showStreamingRun: true,
  sidebarCollapsed: false,
  collapsedNavGroups: [],
  accentColor: "#3C43E7",
  livePolling: false,
};

/** Topbar selections. Kept as loose string unions; the topbar owns the option lists. */
type Persona = string;
type TimeRange = string;
type EnvName = string;

export interface CockpitCtxValue {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  persona: Persona;
  range: TimeRange;
  env: EnvName;
  /** Open a run in the Trace screen. Provided by CockpitShell; no-op in the default ctx. */
  openRun: (run: Run) => void;
  /**
   * Move somewhere else in the cockpit.
   *
   * Every in-cockpit move goes through here rather than through `router.push`
   * or a bare link, because `router.push` never fires `beforeunload` and the
   * only thing standing between an admin half way through typing a token and
   * an empty form is this guard. Answers false when the person called the
   * navigation off. Provided by CockpitShell; no-op in the default ctx.
   */
  navigate: (href: string) => boolean;
  /** Owners and admins. What gates the Settings area's System health and Users tabs. */
  canManageUsers: boolean;
  /** Live-polling on/off (mirrors the persisted `livePolling` tweak). */
  livePolling: boolean;
  /** Flip live polling on/off. */
  toggleLive: () => void;
  /** Epoch ms of the next scheduled refresh while live; null when off. */
  nextRefreshAt: number | null;
  /** True while the cockpit's refresh loop is actually running (not paused). */
  liveRunning: boolean;
  /** Length of one refresh cycle in ms, so a countdown can match it. */
  liveCycleMs: number;
  /** The strongest cadence the mounted run surfaces are asking for. */
  runRefreshCadence: RunRefreshCadence;
  /** Register how often a mounted run surface needs to be refreshed. */
  registerRunRefresh: (key: string, cadence: RunRefreshCadence) => () => void;
}

export const CockpitCtx = createContext<CockpitCtxValue>({
  t: TWEAK_DEFAULTS,
  setTweak: () => {},
  persona: "swe",
  range: "24h",
  env: "prod",
  openRun: () => {},
  navigate: () => true,
  canManageUsers: false,
  livePolling: false,
  toggleLive: () => {},
  nextRefreshAt: null,
  liveRunning: false,
  liveCycleMs: LIVE_POLL_MS,
  runRefreshCadence: "off",
  registerRunRefresh: () => () => {},
});

/** Convenience hook for nested screens to read cockpit context without prop drilling. */
export function useCockpit(): CockpitCtxValue {
  return useContext(CockpitCtx);
}
