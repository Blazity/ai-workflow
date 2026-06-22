// apps/dashboard/app/(cockpit)/cockpit-shell.tsx
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useTweaks } from "@/lib/use-tweaks";
import { runHref } from "@/lib/run-href";
import { useLivePoll } from "@/lib/use-live-poll";
import type { Run } from "@/lib/types";

import {
  CockpitCtx,
  TWEAK_DEFAULTS,
  type Tweaks,
} from "@/components/cockpit/context";
import { CkSidebar } from "@/components/cockpit/chrome";
import { CkActivityDrawer } from "@/components/cockpit/activity-drawer";
import { SpotlightSearch } from "@/components/cockpit/spotlight-search";
import { BottomTabBar } from "@/components/cockpit/mobile/bottom-tab-bar";
import { MobileHeader } from "@/components/cockpit/mobile/mobile-header";
import { MoreSheet } from "@/components/cockpit/mobile/more-sheet";

/** Live-mode poll cadence (ms). Single source of truth — tune here. */
const LIVE_POLL_MS = 5000;

/** Overview lives at `/`; every other screen is `/<id>` (matches the nav ids). */
const pathForScreen = (id: string) => (id === "overview" ? "/" : `/${id}`);
const screenForPath = (path: string) => {
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg === "" ? "overview" : seg;
};

const TITLE_FOR_SCREEN: Record<string, string> = {
  overview: "Overview",
  runs: "Workflow runs",
  prompts: "Prompts",
  evals: "Arthur evals",
  cost: "Cost & usage",
  editor: "Workflow editor",
  trace: "Run trace",
  ticket: "Ticket runs",
};

/**
 * Persistent cockpit chrome (sidebar, topbar, activity drawer) plus the shared
 * context. Lives in the route-group layout so the sidebar, drawer and the
 * selected-run state survive navigation between the per-screen routes, while
 * each route's `children` are rendered server-side where possible.
 */
export function CockpitShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const screen = screenForPath(pathname);

  const [t, setTweak] = useTweaks<Tweaks>(TWEAK_DEFAULTS);
  const [persona] = useState("swe");
  const [range] = useState("24h");
  const [env] = useState("prod");
  const [activityOpen, setActivityOpen] = useState<boolean>(
    !!t.activityDrawerOpen,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const moreScreens = ["prompts", "evals", "cost"];

  useEffect(() => {
    setActivityOpen(!!t.activityDrawerOpen);
  }, [t.activityDrawerOpen]);

  const openRun = (r: Run) => {
    router.push(runHref(r));
  };

  useLivePoll({
    enabled: !!t.livePolling,
    intervalMs: LIVE_POLL_MS,
    onTick: () => router.refresh(),
  });

  return (
    <CockpitCtx.Provider
      value={{ t, setTweak, persona, range, env, openRun }}
    >
      <div className="h-dvh w-screen flex flex-col lg:flex-row overflow-hidden bg-app-bg relative">
        {/* Desktop sidebar — lg and up only */}
        <div className="hidden lg:flex">
          <CkSidebar
            active={screen}
            onNav={(id) => router.push(pathForScreen(id))}
            collapsed={!!t.sidebarCollapsed}
            onToggleCollapse={() => setTweak("sidebarCollapsed", !t.sidebarCollapsed)}
            live={!!t.livePolling}
            onToggleLive={() => setTweak("livePolling", !t.livePolling)}
          />
        </div>

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Mobile header */}
          <div className="lg:hidden">
            <MobileHeader title={TITLE_FOR_SCREEN[screen] ?? "AI Workflow"} />
          </div>

          <div className="flex-1 overflow-auto min-h-0">{children}</div>

          {/* Mobile bottom tab bar */}
          <div className="lg:hidden">
            <BottomTabBar
              active={screen}
              moreActive={moreScreens.includes(screen)}
              onNav={(id) => router.push(pathForScreen(id))}
              onOpenMore={() => setMoreOpen(true)}
            />
          </div>
        </main>

        {/* Activity drawer — desktop only (removed on mobile by decision) */}
        <div className="hidden lg:block">
          <CkActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
        </div>

        {/* Mobile "More" menu */}
        <div className="lg:hidden">
          <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} active={screen} onNav={(id) => router.push(pathForScreen(id))} />
        </div>

        {/* Spotlight ticket search — global overlay, summoned by ⌘K from any screen */}
        <SpotlightSearch />
      </div>
    </CockpitCtx.Provider>
  );
}
