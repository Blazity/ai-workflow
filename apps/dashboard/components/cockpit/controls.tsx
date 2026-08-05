"use client";

import type { CSSProperties } from "react";
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WINDOWS, type TimeWindow, windowShort } from "@/lib/window";
import { useCockpit } from "@/components/cockpit/context";
import { LIVE_POLL_MS } from "@/lib/use-live-poll";

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
  const pad = size === "sm" ? "py-1 px-2" : "py-1.5 px-2.5";
  return (
    <div
      role="group"
      aria-label="Time window"
      className="inline-flex gap-0.5 p-[3px] bg-app-bg rounded-sm border border-neutral-200"
    >
      {WINDOWS.map((w) => {
        const on = w === value;
        return (
          <button
            key={w}
            type="button"
            aria-pressed={on}
            onClick={() => write("window", w === "24h" ? null : w)}
            className={`appearance-none border-none cursor-pointer ${pad} rounded-[3px] font-mono font-medium text-[11px] uppercase tracking-[-0.01em] transition-all duration-[180ms] ease-[cubic-bezier(.2,0,0,1)] ${
              on
                ? "bg-panel shadow-[0_1px_2px_rgba(24,27,32,0.06)] text-mariner"
                : "bg-transparent text-neutral-700 hover:text-neutral-900"
            }`}
          >
            {windowShort(w)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Live-polling control — sits beside the WindowSelector. Toggles the global
 * `livePolling` state (read from cockpit context, persisted via tweaks); while
 * on, a ring drains over each refresh cycle. The actual `router.refresh()` loop
 * runs once in CockpitShell — this only reflects it.
 */
export function LivePollControl({ size = "md" }: { size?: "md" | "sm" }) {
  const { livePolling, toggleLive, nextRefreshAt } = useCockpit();
  return (
    <button
      type="button"
      onClick={toggleLive}
      aria-pressed={livePolling}
      aria-label="Toggle live updates"
      title={
        livePolling
          ? "Live updates on — refreshing every 5s. Click to pause."
          : "Live updates off — click to enable"
      }
      className={`appearance-none cursor-pointer inline-flex items-center gap-1.5 rounded-sm border transition-colors duration-[180ms] ease-[cubic-bezier(.2,0,0,1)] ${
        size === "sm" ? "py-1 px-2" : "py-1.5 px-2.5"
      } ${
        livePolling
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-neutral-200 bg-app-bg text-neutral-700 hover:text-neutral-900"
      }`}
    >
      <LiveRing on={livePolling} nextRefreshAt={nextRefreshAt} dim={size === "sm" ? 12 : 13} />
      <span className="font-mono font-medium text-[11px] uppercase tracking-[-0.01em]">
        {livePolling ? "Live" : "Live off"}
      </span>
    </button>
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
  dim,
}: {
  on: boolean;
  nextRefreshAt: number | null;
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
      {/* draining arc — remounts each cycle via key, restarting the animation */}
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
            animation: `ck-drain ${LIVE_POLL_MS}ms linear forwards`,
          } as CSSProperties
        }
      />
    </svg>
  );
}
