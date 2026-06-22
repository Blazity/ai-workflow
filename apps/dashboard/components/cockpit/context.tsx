"use client";

import { createContext, useContext } from "react";
import type { Run } from "@/lib/types";

export type Density = "compact" | "comfy";

export type Tweaks = {
  density: Density;
  showEditorialHero: boolean;
  showStreamingRun: boolean;
  activityDrawerOpen: boolean;
  /** Collapses the cockpit sidebar to an icon-only rail; persists across visits. */
  sidebarCollapsed: boolean;
  accentColor: string;
  /** Flow selected in the workflow editor; persists the select across visits. */
  editorFlow: string;
  /** When on, the cockpit polls and refreshes the active screen's data. */
  livePolling: boolean;
};

export const TWEAK_DEFAULTS: Tweaks = {
  density: "comfy",
  showEditorialHero: false,
  showStreamingRun: true,
  activityDrawerOpen: false,
  sidebarCollapsed: false,
  accentColor: "#3C43E7",
  editorFlow: "presandbox",
  livePolling: false,
};

/** Topbar selections. Kept as loose string unions; the topbar owns the option lists. */
export type Persona = string;
export type TimeRange = string;
export type EnvName = string;

export interface CockpitCtxValue {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  persona: Persona;
  range: TimeRange;
  env: EnvName;
  /** Open a run in the Trace screen. Provided by CockpitShell; no-op in the default ctx. */
  openRun: (run: Run) => void;
}

export const CockpitCtx = createContext<CockpitCtxValue>({
  t: TWEAK_DEFAULTS,
  setTweak: () => {},
  persona: "swe",
  range: "24h",
  env: "prod",
  openRun: () => {},
});

/** Convenience hook for nested screens to read cockpit context without prop drilling. */
export function useCockpit(): CockpitCtxValue {
  return useContext(CockpitCtx);
}
