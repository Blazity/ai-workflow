"use client";

import React from "react";
import { Spark } from "@/components/charts";
import type { RunStatus } from "@/lib/types";

/* ── BlazityLogo — inline SVG flame + wordmark ───────────────────────────── */
export function BlazityLogo({
  size = 28,
  color = "#FD6027",
  wordmarkColor = "#181B20",
  showWord = true,
}: {
  size?: number;
  color?: string;
  wordmarkColor?: string;
  showWord?: boolean;
}) {
  const w = Math.round(size * (1168.768 / 1219.666)); // preserve aspect
  return (
    <span className="inline-flex items-center gap-[10px] leading-none">
      <svg width={w} height={size} viewBox="0 0 1168.768 1219.666" fill={color} aria-hidden="true">
        <path d="M 610.721 240.562 C 544.026 203.398 495.29 182.174 495.29 182.174 L 549.74 311.483 L 0 0 L 293.909 593.627 L 158.646 534.855 C 158.646 534.855 178.765 571.588 202.773 626.471 C 245.46 724.04 277.151 811.622 310.042 906.119 C 369.487 1076.721 531.542 1219.666 730.474 1219.666 C 972.525 1219.666 1168.768 1023.807 1168.768 782.188 C 1168.768 598.141 1054.873 440.599 893.586 376.017 C 796.449 337.124 702.096 291.556 610.673 240.61 L 610.721 240.61 Z" />
      </svg>
      {showWord && (
        <span
          className="font-wordmark font-bold tracking-[-0.01em] leading-none"
          style={{
            fontSize: Math.round(size * 0.92),
            color: wordmarkColor,
          }}
        >
          blazity
        </span>
      )}
    </span>
  );
}

/* ── CkChip ───────────────────────────────────────────────────────────────── */
export type ChipTone =
  | "neutral"
  | "success"
  | "running"
  | "failed"
  | "warn"
  | "blocked"
  | "awaiting"
  | "mariner"
  | "orange"
  | "coal";

export function CkChip({
  children,
  tone = "neutral",
  style,
}: {
  children: React.ReactNode;
  tone?: ChipTone;
  style?: React.CSSProperties;
}) {
  const tones: Record<ChipTone, string> = {
    neutral: "bg-app-bg text-neutral-800",
    success: "bg-success-bg text-success-fg",
    running: "bg-mariner-100 text-mariner",
    failed: "bg-fail-bg text-fail-fg",
    warn: "bg-[#FFF4CC] text-[#7A5A00]",
    blocked: "bg-app-bg text-neutral-700",
    awaiting: "bg-[#FFEFE9] text-fail-fg",
    mariner: "bg-mariner text-white",
    orange: "bg-burnt-orange text-white",
    coal: "bg-coal text-white",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-[3px] rounded-xs font-mono text-[10px] font-medium tracking-[0.02em] uppercase ${tones[tone] || tones.neutral}`}
      style={style}
    >
      {children}
    </span>
  );
}

/* ── CkDot ───────────────────────────────────────────────────────────────── */
export function CkDot({ color = "#3C43E7", size = 6 }: { color?: string; size?: number }) {
  return (
    <span
      className="inline-block rounded-full flex-none"
      style={{ width: size, height: size, background: color }}
    />
  );
}

/* ── CkCard ──────────────────────────────────────────────────────────────── */
export function CkCard({
  title,
  eyebrow,
  action,
  children,
  style,
  pad = 20,
}: {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
  pad?: number;
}) {
  const hasHeader = title || eyebrow || action;
  return (
    <section className="bg-panel border border-neutral-200 rounded-sm" style={style}>
      {hasHeader && (
        <header
          className={`flex items-baseline justify-between gap-3 px-5 pt-[18px] pb-[14px] ${pad === 0 ? "border-b border-neutral-200" : ""}`}
        >
          <div className="flex flex-col gap-0.5">
            {eyebrow && (
              <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">
                {eyebrow}
              </div>
            )}
            {title && <h3 className="font-display font-medium text-base leading-[1.3] m-0 text-coal">{title}</h3>}
          </div>
          {action}
        </header>
      )}
      <div style={{ padding: hasHeader ? `0 ${pad}px ${pad}px` : `${pad}px` }}>{children}</div>
    </section>
  );
}

/* ── CkKPI ───────────────────────────────────────────────────────────────── */
export function CkKPI({
  label,
  value,
  sub,
  delta,
  deltaTone = "good",
  spark,
  sparkColor = "#3C43E7",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: "good" | "bad" | "neutral";
  spark?: number[];
  sparkColor?: string;
}) {
  const deltaToneClass =
    deltaTone === "good" ? "text-success-fg" : deltaTone === "bad" ? "text-fail-fg" : "text-neutral-700";
  return (
    <div className="bg-panel border border-neutral-200 rounded-sm py-4 px-[18px] flex flex-col gap-1.5 min-h-[124px]">
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="font-display font-semibold text-[32px] leading-none tracking-[-0.02em] text-coal">{value}</div>
        {sub && <div className="font-body font-medium text-sm leading-none text-neutral-700">{sub}</div>}
      </div>
      <div className="flex items-center justify-between mt-auto">
        {delta != null && (
          <div className={`font-mono text-[11px] ${deltaToneClass}`}>{delta}</div>
        )}
        {spark && (
          <div className="opacity-85" style={{ color: sparkColor }}>
            <Spark data={spark} stroke={sparkColor} fill={sparkColor} w={96} h={28} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── CkTabs ──────────────────────────────────────────────────────────────── */
export function CkTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="inline-flex gap-0.5 p-[3px] bg-app-bg rounded-sm border border-neutral-200">
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`appearance-none border-none cursor-pointer py-1.5 px-3 rounded-[3px] font-mono font-medium text-[11px] uppercase tracking-[-0.01em] transition-all duration-[180ms] ease-[cubic-bezier(.2,0,0,1)] ${
              isActive ? "bg-panel shadow-[0_1px_2px_rgba(24,27,32,0.06)] text-coal" : "bg-transparent text-neutral-700"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── CkStatusPill ────────────────────────────────────────────────────────── */
export function CkStatusPill({ status }: { status: RunStatus | "warn" }) {
  const map: Record<string, { tone: ChipTone; label: string; dot: string }> = {
    success: { tone: "success", label: "Success", dot: "#5BB04A" },
    running: { tone: "running", label: "Running", dot: "#3C43E7" },
    failed: { tone: "failed", label: "Failed", dot: "#D14343" },
    blocked: { tone: "blocked", label: "Blocked", dot: "#9EA3AA" },
    awaiting: { tone: "awaiting", label: "Awaiting input", dot: "#FD6027" },
    warn: { tone: "warn", label: "Warn", dot: "#FFC800" },
  };
  const m = map[status] || map.success;
  return (
    <CkChip tone={m.tone}>
      <span className="relative w-1.5 h-1.5">
        <span className="absolute inset-0 rounded-full" style={{ background: m.dot }} />
        {(status === "running" || status === "awaiting") && (
          <span
            className="absolute -inset-[3px] rounded-full border animate-ck-pulse"
            style={{ borderColor: m.dot }}
          />
        )}
      </span>
      {m.label}
    </CkChip>
  );
}

/* ── CkPagination — table footer (prev/next + numbered pages) ─────────────── */
export function CkPagination({
  page,
  totalPages,
  total,
  start,
  shown,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  start: number;
  shown: number;
  onChange: (page: number) => void;
}) {
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;
  const btnClass = (disabled: boolean) =>
    `appearance-none border border-neutral-200 py-[5px] px-2.5 rounded-[3px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] inline-flex items-center gap-1 transition-all duration-[120ms] ${
      disabled ? "bg-off-white text-[#C7CBD0] cursor-default" : "bg-panel text-coal cursor-pointer"
    }`;
  const pages: (number | "…")[] = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }
  return (
    <div className="flex items-center gap-2 py-3 px-5 border-t border-neutral-200 bg-[#FBFBFC]">
      <span className="font-mono text-[11px] text-neutral-700 tracking-[0.02em]">
        {start + 1}–{start + shown} <span className="text-neutral-500">of</span> {total}
      </span>
      <div className="ml-auto inline-flex items-center gap-1">
        <button disabled={prevDisabled} onClick={() => !prevDisabled && onChange(page - 1)} className={btnClass(prevDisabled)}>
          ← Prev
        </button>
        <div className="inline-flex gap-0.5 mx-1">
          {pages.map((p, i) =>
            p === "…" ? (
              <span key={"e" + i} className="py-[5px] px-1.5 font-mono text-[11px] text-neutral-500">…</span>
            ) : (
              <button
                key={p}
                onClick={() => onChange(p)}
                className={`appearance-none cursor-pointer min-w-[26px] py-[5px] px-[7px] rounded-[3px] font-mono text-[11px] font-medium transition-all duration-[120ms] border ${
                  p === page ? "border-coal bg-coal text-white" : "border-neutral-200 bg-panel text-neutral-800"
                }`}
              >
                {p + 1}
              </button>
            ),
          )}
        </div>
        <button disabled={nextDisabled} onClick={() => !nextDisabled && onChange(page + 1)} className={btnClass(nextDisabled)}>
          Next →
        </button>
      </div>
    </div>
  );
}

/* ── TicketLink / PRLink — clickable Linear/Jira & GitHub refs ────────────── */
export function TicketLink({ ticket, url, size = "sm" }: { ticket: string; url: string; size?: "sm" | "lg" }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 border border-neutral-200 rounded-xs bg-panel text-mariner no-underline font-mono font-medium tracking-[0.02em] whitespace-nowrap transition-all duration-[120ms] hover:bg-mariner-100 hover:border-mariner ${
        size === "sm" ? "py-0.5 px-1.5 text-[10px]" : "py-[3px] px-2 text-[11px]"
      }`}
    >
      {ticket}
      <span className="text-[9px] opacity-60">↗</span>
    </a>
  );
}

export function PRLink({ num, url, size = "sm" }: { num: number; url: string; size?: "sm" | "lg" }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 border border-neutral-200 rounded-xs bg-coal text-white no-underline font-mono font-medium tracking-[0.02em] whitespace-nowrap transition-all duration-[120ms] hover:bg-neutral-800 ${
        size === "sm" ? "py-0.5 px-1.5 text-[10px]" : "py-[3px] px-2 text-[11px]"
      }`}
    >
      <span className="opacity-60">PR</span>#{num}
      <span className="text-[9px] opacity-70">↗</span>
    </a>
  );
}
