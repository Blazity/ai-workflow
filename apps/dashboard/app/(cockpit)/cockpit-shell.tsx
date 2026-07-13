// apps/dashboard/app/(cockpit)/cockpit-shell.tsx
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useTweaks } from "@/lib/use-tweaks";
import { runHref } from "@/lib/run-href";
import { useLivePoll, LIVE_POLL_MS } from "@/lib/use-live-poll";
import type { Run } from "@/lib/types";
import type { DashboardSession } from "@/lib/auth/session";

import {
  CockpitCtx,
  TWEAK_DEFAULTS,
  type Tweaks,
} from "@/components/cockpit/context";
import {
  CkSidebar,
  cockpitNavItems,
  isMobileMoreNavItem,
} from "@/components/cockpit/chrome";
import { LivePollControl } from "@/components/cockpit/controls";
import { LogoutButton } from "@/components/cockpit/logout-button";
import { CkActivityDrawer } from "@/components/cockpit/activity-drawer";
import { SpotlightSearch } from "@/components/cockpit/spotlight-search";
import { BottomTabBar } from "@/components/cockpit/mobile/bottom-tab-bar";
import { MobileHeader } from "@/components/cockpit/mobile/mobile-header";
import { MoreSheet } from "@/components/cockpit/mobile/more-sheet";

/** Overview lives at `/`; every other screen is `/<id>` (matches the nav ids). */
const pathForScreen = (id: string) => (id === "overview" ? "/" : `/${id}`);
const screenForPath = (path: string) => {
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg === "" ? "overview" : seg;
};

const TITLE_FOR_SCREEN: Record<string, string> = {
  overview: "Overview",
  runs: "Workflow runs",
  approvals: "Approvals",
  prompts: "Prompts",
  evals: "Arthur evals",
  cost: "Cost & usage",
  editor: "Workflow editor",
  checks: "Pre-PR checks",
  users: "Users",
  trace: "Run trace",
  ticket: "Ticket runs",
};

/**
 * Persistent cockpit chrome (sidebar, topbar, activity drawer) plus the shared
 * context. Lives in the route-group layout so the sidebar, drawer and the
 * selected-run state survive navigation between the per-screen routes, while
 * each route's `children` are rendered server-side where possible.
 */
export function CockpitShell({
  children,
  session,
}: {
  children: React.ReactNode;
  session: DashboardSession;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const screen = screenForPath(pathname);
  const canManageUsers = session.canManageUsers;

  const [t, setTweak] = useTweaks<Tweaks>(TWEAK_DEFAULTS);
  const [persona] = useState("swe");
  const [range] = useState("24h");
  const [env] = useState("prod");
  const [activityOpen, setActivityOpen] = useState<boolean>(
    !!t.activityDrawerOpen,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const moreScreens = cockpitNavItems({ canManageUsers })
    .filter((item) => isMobileMoreNavItem(item.id))
    .map((item) => item.id);

  useEffect(() => {
    setActivityOpen(!!t.activityDrawerOpen);
  }, [t.activityDrawerOpen]);

  const openRun = (r: Run) => {
    router.push(runHref(r));
  };

  // Timestamp of the next scheduled refresh, surfaced via context so the
  // live-poll control can render a countdown ring in sync with the actual
  // refreshes (which are driven here, once, for the whole cockpit).
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  useEffect(() => {
    setNextRefreshAt(t.livePolling ? Date.now() + LIVE_POLL_MS : null);
  }, [t.livePolling]);

  useLivePoll({
    enabled: !!t.livePolling,
    intervalMs: LIVE_POLL_MS,
    onTick: () => {
      router.refresh();
      setNextRefreshAt(Date.now() + LIVE_POLL_MS);
    },
  });

  return (
    <CockpitCtx.Provider
      value={{
        t,
        setTweak,
        persona,
        range,
        env,
        openRun,
        livePolling: !!t.livePolling,
        toggleLive: () => setTweak("livePolling", !t.livePolling),
        nextRefreshAt,
      }}
    >
      <div className="h-dvh w-screen flex flex-col lg:flex-row overflow-hidden bg-app-bg relative">
        {/* Desktop sidebar — lg and up only */}
        <div className="hidden lg:flex">
          <CkSidebar
            active={screen}
            onNav={(id) => router.push(pathForScreen(id))}
            collapsed={!!t.sidebarCollapsed}
            onToggleCollapse={() => setTweak("sidebarCollapsed", !t.sidebarCollapsed)}
            canManageUsers={canManageUsers}
          />
        </div>

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Mobile header */}
          <div className="lg:hidden">
            <MobileHeader title={TITLE_FOR_SCREEN[screen] ?? "AI Workflow"} />
          </div>

          {/* Desktop top bar — global live-poll control, present on every screen */}
          <div className="hidden lg:flex items-center justify-between flex-[0_0_44px] h-11 border-b border-neutral-200 bg-panel px-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
              {TITLE_FOR_SCREEN[screen] ?? "AI Workflow"}
            </span>
            <div className="flex items-center gap-4">
              <LivePollControl />
              <LogoutButton />
            </div>
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
          <MoreSheet
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            active={screen}
            onNav={(id) => router.push(pathForScreen(id))}
            canManageUsers={canManageUsers}
          />
        </div>

        {/* Spotlight ticket search — global overlay, summoned by ⌘K from any screen */}
        <SpotlightSearch />
      </div>
    </CockpitCtx.Provider>
  );
}
