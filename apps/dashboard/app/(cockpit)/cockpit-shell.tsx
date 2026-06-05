// apps/dashboard/app/(cockpit)/cockpit-shell.tsx
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useTweaks } from "@/lib/use-tweaks";
import type { Run } from "@/lib/types";

import {
  CockpitCtx,
  TWEAK_DEFAULTS,
  type Tweaks,
} from "@/components/cockpit/context";
import { CkSidebar, CkTopbar } from "@/components/cockpit/chrome";
import { CkActivityDrawer } from "@/components/cockpit/activity-drawer";

/** Overview lives at `/`; every other screen is `/<id>` (matches the nav ids). */
const pathForScreen = (id: string) => (id === "overview" ? "/" : `/${id}`);
const screenForPath = (path: string) => {
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg === "" ? "overview" : seg;
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
  const [persona, setPersona] = useState("swe");
  const [range, setRange] = useState("24h");
  const [env, setEnv] = useState("prod");
  const [activityOpen, setActivityOpen] = useState<boolean>(
    !!t.activityDrawerOpen,
  );

  useEffect(() => {
    setActivityOpen(!!t.activityDrawerOpen);
  }, [t.activityDrawerOpen]);

  const openRun = (r: Run) => {
    router.push(`/trace/${encodeURIComponent(r.id)}`);
  };

  return (
    <CockpitCtx.Provider
      value={{ t, setTweak, persona, range, env, openRun }}
    >
      <div className="h-screen w-screen flex overflow-hidden bg-app-bg relative">
        <CkSidebar
          active={screen}
          onNav={(id) => router.push(pathForScreen(id))}
          collapsed={!!t.sidebarCollapsed}
          onToggleCollapse={() =>
            setTweak("sidebarCollapsed", !t.sidebarCollapsed)
          }
        />
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <CkTopbar
            persona={persona}
            setPersona={setPersona}
            range={range}
            setRange={setRange}
            env={env}
            setEnv={setEnv}
          />
          <div className="flex-1 overflow-auto min-h-0">{children}</div>
        </main>

        <CkActivityDrawer
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
        />
      </div>
    </CockpitCtx.Provider>
  );
}
