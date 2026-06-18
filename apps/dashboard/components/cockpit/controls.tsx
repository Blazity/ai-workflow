"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WINDOWS, type TimeWindow, windowShort } from "@/lib/window";

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
 * Ticket search. Debounces into the URL's `q`, which the worker turns into a
 * bound, wildcard-escaped ILIKE over ticket key + title across all history —
 * not a client-side filter of the loaded page.
 */
export function SearchBox({
  initial,
  className = "",
}: {
  initial: string;
  className?: string;
}) {
  const write = useParamWriter();
  const [value, setValue] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keep in sync when the URL changes from elsewhere (e.g. window switch reload).
  useEffect(() => setValue(initial), [initial]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (v: string) => write("q", v.trim() || null);
  const onChange = (v: string) => {
    setValue(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(v), 350);
  };

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <svg
        className="absolute left-2.5 text-neutral-500 pointer-events-none"
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            clearTimeout(timer.current);
            commit(value);
          }
        }}
        placeholder="Search ticket key or title"
        aria-label="Search runs by ticket key or title"
        className="appearance-none border border-neutral-200 bg-panel rounded-[3px] h-[34px] pl-8 pr-2.5 w-full sm:w-[240px] font-body text-[12px] text-neutral-900 placeholder:text-neutral-500 focus:outline-none focus:border-mariner focus:ring-2 focus:ring-mariner/20 transition-colors"
      />
    </div>
  );
}
