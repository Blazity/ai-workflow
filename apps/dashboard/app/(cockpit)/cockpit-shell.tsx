// apps/dashboard/app/(cockpit)/cockpit-shell.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useTweaks } from "@/lib/use-tweaks";
import { runHref } from "@/lib/run-href";
import { useLivePoll, LIVE_POLL_MS, IDLE_POLL_MS } from "@/lib/use-live-poll";
import type { Run } from "@/lib/types";
import type { DashboardSession } from "@/lib/auth/session";

import {
  CockpitCtx,
  TWEAK_DEFAULTS,
  type RunRefreshCadence,
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
import {
  DISCARD_UNSAVED_PROMPT,
  hasUnsavedRepositoryScripts,
} from "@/components/cockpit/screens/repository-scripts";
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

/** Drop one key, returning the same object when there is nothing to drop. */
function withoutKey(
  current: Readonly<Record<string, RunRefreshCadence>>,
  key: string,
): Readonly<Record<string, RunRefreshCadence>> {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

const TITLE_FOR_SCREEN: Record<string, string> = {
  overview: "Overview",
  runs: "Workflow runs",
  approvals: "Approvals",
  prompts: "Prompts",
  memory: "Agent memory",
  evals: "Arthur evals",
  cost: "Cost & usage",
  editor: "Workflow editor",
  profiles: "Harness profiles",
  scripts: "Repository scripts",
  health: "System health",
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
  const [runRefreshKeys, setRunRefreshKeys] = useState<
    Readonly<Record<string, RunRefreshCadence>>
  >({});
  const moreScreens = cockpitNavItems({ canManageUsers })
    .filter((item) => isMobileMoreNavItem(item.id))
    .map((item) => item.id);

  useEffect(() => {
    setActivityOpen(!!t.activityDrawerOpen);
  }, [t.activityDrawerOpen]);

  // Every navigation inside the cockpit is a router.push, which the browser's
  // own beforeunload guard never sees: a screen holding unsaved edits would be
  // unmounted without a word. Screens that can hold them say so through a
  // module-level flag (there is no provider boundary between the shell and its
  // `children`, which are a server component's rendered output).
  // Set once a discard has been agreed to, and cleared when the destination
  // actually arrives: a push is not instant, and asking twice for one departure
  // ("are you sure" on the nav item, then again on the tab bar underneath it)
  // reads as the app not having heard the first answer.
  const leaving = useRef(false);
  useEffect(() => {
    leaving.current = false;
  }, [pathname]);

  // Answers false when the navigation was called off, so a caller that also
  // tears down its own UI (the Spotlight overlay) can leave it standing.
  const navigate = useCallback(
    (href: string): boolean => {
      // Re-selecting the screen already on display leaves nothing behind, so
      // there is nothing to ask about.
      if (href === pathname) {
        router.push(href);
        return true;
      }
      if (hasUnsavedRepositoryScripts() && !leaving.current) {
        if (
          typeof window !== "undefined" &&
          typeof window.confirm === "function" &&
          !window.confirm(DISCARD_UNSAVED_PROMPT)
        ) {
          return false;
        }
        leaving.current = true;
      }
      router.push(href);
      return true;
    },
    [pathname, router],
  );

  const openRun = (r: Run) => {
    navigate(runHref(r));
  };

  // Mounted run surfaces declare their own cadence here; the loop below is the
  // only thing that calls router.refresh(), once for the whole cockpit. Plain
  // state (no ref mirror) so `enabled` can never disagree with the registry.
  const registerRunRefresh = useCallback(
    (key: string, cadence: RunRefreshCadence) => {
      setRunRefreshKeys((current) =>
        cadence === "off"
          ? withoutKey(current, key)
          : current[key] === cadence
            ? current
            : { ...current, [key]: cadence },
      );
      return () => setRunRefreshKeys((current) => withoutKey(current, key));
    },
    [],
  );

  const cadences = Object.values(runRefreshKeys);
  const runRefreshCadence: RunRefreshCadence = cadences.includes("live")
    ? "live"
    : cadences.length > 0
      ? "idle"
      : "off";
  // A surface with work in flight and the global Live toggle both mean the fast
  // cadence. A surface with nothing in flight still watches for new work, just
  // slowly — that is the AIW-266 criterion "polling stops or slows when no
  // active runs are present", and it is what lets a new run appear in the list.
  // Health probes hit every configured provider. They are intentionally
  // user-triggered so a persisted global Live preference cannot turn one open
  // health tab into a continuous fan-out of production requests.
  const globalPollingAllowed = screen !== "health";
  const livePollFast =
    globalPollingAllowed && (runRefreshCadence === "live" || !!t.livePolling);
  const livePollEnabled =
    globalPollingAllowed &&
    (livePollFast || runRefreshCadence === "idle");
  const liveCycleMs = livePollFast ? LIVE_POLL_MS : IDLE_POLL_MS;

  // Timestamp of the next scheduled refresh, surfaced via context so the
  // live-poll control can render a countdown ring in sync with the actual
  // refreshes.
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);

  const liveRunning = useLivePoll({
    enabled: livePollEnabled,
    intervalMs: liveCycleMs,
    onTick: () => {
      router.refresh();
      setNextRefreshAt(Date.now() + liveCycleMs);
    },
  });

  // Keyed off the loop's real state, not off the intent: while the tab is hidden
  // the loop is paused and there is no next refresh to count down to.
  useEffect(() => {
    setNextRefreshAt(liveRunning ? Date.now() + liveCycleMs : null);
  }, [liveRunning, liveCycleMs]);

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
        liveRunning,
        liveCycleMs,
        runRefreshCadence,
        registerRunRefresh,
      }}
    >
      <div className="h-dvh w-screen flex flex-col lg:flex-row overflow-hidden bg-app-bg relative">
        {/* Desktop sidebar — lg and up only */}
        <div className="hidden lg:flex">
          <CkSidebar
            active={screen}
            onNav={(id) => navigate(pathForScreen(id))}
            collapsed={!!t.sidebarCollapsed}
            onToggleCollapse={() => setTweak("sidebarCollapsed", !t.sidebarCollapsed)}
            canManageUsers={canManageUsers}
          />
        </div>

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Mobile header */}
          <div className="lg:hidden">
            <MobileHeader
              title={TITLE_FOR_SCREEN[screen] ?? "AI Workflow"}
              showLivePoll={globalPollingAllowed}
            />
          </div>

          {/* Desktop top bar — live polling is omitted for expensive health probes */}
          <div className="hidden lg:flex items-center justify-between flex-[0_0_44px] h-11 border-b border-neutral-200 bg-panel px-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
              {TITLE_FOR_SCREEN[screen] ?? "AI Workflow"}
            </span>
            <div className="flex items-center gap-4">
              {globalPollingAllowed && <LivePollControl />}
              <LogoutButton />
            </div>
          </div>

          <div className="flex-1 overflow-auto min-h-0">{children}</div>

          {/* Mobile bottom tab bar */}
          <div className="lg:hidden">
            <BottomTabBar
              active={screen}
              moreActive={moreScreens.includes(screen)}
              onNav={(id) => navigate(pathForScreen(id))}
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
            onNav={(id) => navigate(pathForScreen(id))}
            canManageUsers={canManageUsers}
          />
        </div>

        {/* Spotlight ticket search — global overlay, summoned by ⌘K from any screen.
            It navigates through the same guard as the sidebar: ⌘K is a way out
            of a screen holding unsaved edits like any other. */}
        <SpotlightSearch navigate={navigate} />
      </div>
    </CockpitCtx.Provider>
  );
}
