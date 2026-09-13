"use client";

import type { CSSProperties } from "react";
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WINDOWS, type TimeWindow, windowShort } from "@/lib/window";
import { useCockpit } from "@/components/cockpit/context";
import { Button } from "@/components/ui/button";
import { CkTabs } from "@/components/ui";

/** Replace the current URL's search params, preserving every key not given. */
function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, params],
  );
}

/**
 * Global time-window control. A segmented control in the cockpit's
 * established idiom (mirrors CkTabs); the selection lives in the URL so it is a
 * single source of truth the server reads to scope its SQL. The default window
 * ("24h") clears the param to keep canonical URLs clean.
 */
export function WindowSelector({
  value,
  size = "md",
}: {
  value: TimeWindow;
  size?: "md" | "sm";
}) {
  const write = useParamWriter();
  return (
    <div role="group" aria-label="Time window">
      <CkTabs
        active={value}
        onChange={(window) => write("window", window === "24h" ? null : window)}
        size={size}
        tabs={WINDOWS.map((window) => ({ id: window, label: windowShort(window) }))}
      />
    </div>
  );
}

/**
 * Live-poll indicator, sits beside the WindowSelector. It reports the refresh
 * loop's *actual* state (`liveRunning`, owned by CockpitShell), never the
 * intent: a badge reading "Live" over a stopped loop is worse than no badge,
 * because it takes away the user's only cue to reload (AIW-266).
 *
 * On a screen whose refreshing is driven by its own content (a runs list, a run
 * in flight) the badge is a read-only status, because the global toggle does not
 * govern it and a pressable control would imply otherwise. Everywhere else it
 * stays the toggle it always was.
 */
export function LivePollControl({ size = "md" }: { size?: "md" | "sm" }) {
  const {
    livePolling,
    toggleLive,
    nextRefreshAt,
    liveRunning,
    liveCycleMs,
    runRefreshCadence,
  } = useCockpit();
  const auto = runRefreshCadence !== "off";
  const watching = liveRunning && runRefreshCadence === "idle" && !livePolling;
  const label = liveRunning
    ? watching
      ? "Watching"
      : "Live"
    : auto || livePolling
      ? "Paused"
      : "Live off";
  const seconds = Math.round(liveCycleMs / 1000);
  const title = liveRunning
    ? watching
      ? `No run in flight \u2014 checking for new runs every ${seconds}s.`
      : `Refreshing every ${seconds}s.`
    : auto || livePolling
      ? "Paused while this tab is in the background. It resumes the moment you come back."
      : "Live updates off \u2014 click to enable";
  const pad = size === "sm" ? "px-2" : "px-2.5";
  const tone = liveRunning ? "text-mariner" : "text-neutral-700";
  const body = (
    <>
      <LiveRing
        on={liveRunning}
        nextRefreshAt={nextRefreshAt}
        cycleMs={liveCycleMs}
        dim={size === "sm" ? 12 : 13}
      />
      <span className="font-mono font-medium text-[11px] uppercase tracking-[-0.01em]">
        {label}
      </span>
    </>
  );

  if (auto) {
    return (
      <span
        role="status"
        title={title}
        className={`inline-flex items-center gap-1.5 rounded-sm border ${pad} ${tone}`}
      >
        {body}
      </span>
    );
  }

  return (
    <Button
      type="button"
      onClick={toggleLive}
      aria-pressed={livePolling}
      aria-label="Toggle live updates"
      title={title}
      variant={liveRunning ? "selected" : "secondary"}
      size={size}
      className={`${pad} ${tone} ${
        liveRunning ? "" : "hover:text-neutral-900"
      }`}
    >
      {body}
    </Button>
  );
}

/**
 * Ring that drains over one poll cycle. Re-keyed by `nextRefreshAt` so the
 * one-shot CSS drain restarts at full on every refresh (and on enable). When
 * the tab is hidden no refresh fires, so the ring simply completes and waits.
 */
function LiveRing({
  on,
  nextRefreshAt,
  cycleMs,
  dim,
}: {
  on: boolean;
  nextRefreshAt: number | null;
  cycleMs: number;
  dim: number;
}) {
  const sw = 1.5;
  const r = dim / 2 - sw;
  const circumference = 2 * Math.PI * r;
  const center = dim / 2;

  if (!on) {
    return (
      <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} aria-hidden="true">
        <circle cx={center} cy={center} r={r} fill="none" stroke="currentColor" strokeWidth={sw} opacity={0.45} />
      </svg>
    );
  }

  return (
    <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} aria-hidden="true" className="-rotate-90">
      {/* faint track */}
      <circle cx={center} cy={center} r={r} fill="none" stroke="currentColor" strokeWidth={sw} opacity={0.2} />
      {/* draining arc, remounts each cycle via key, restarting the animation */}
      <circle
        key={nextRefreshAt ?? 0}
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={circumference}
        style={
          {
            "--ck-dash": `${circumference}`,
            animation: `ck-drain ${cycleMs}ms linear forwards`,
          } as CSSProperties
        }
      />
    </svg>
  );
}
