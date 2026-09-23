"use client";

import React from "react";
import { Spark } from "@/components/charts";
import { pullRequestRepoLabels } from "@shared/contracts";
import type { RunPullRequest } from "@shared/contracts";
import { changeRequestNaming } from "@integrations/registry";
import { runPullRequests } from "@/lib/run-prs";
import type { RunStatus } from "@/lib/types";
import { Button } from "./ui/button";

export * from "./ui/button";
export * from "./ui/checkbox";
export * from "./ui/field";
export * from "./ui/icon-button";
export * from "./ui/input";
export * from "./ui/modal";
export * from "./ui/nav-item";
export * from "./ui/radio";
export * from "./ui/route-tabs";
export * from "./ui/select";
export * from "./ui/skeleton";
export * from "./ui/switch";
export * from "./ui/textarea";

/* BlazityLogo, inline SVG flame and wordmark. */
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

/* ── CkCard ──────────────────────────────────────────────────────────────── */
export function CkCard({
  title,
  eyebrow,
  action,
  children,
  style,
  className,
  pad = 20,
}: {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  pad?: number;
}) {
  const hasHeader = title || eyebrow || action;
  return (
    <section className={`bg-panel border border-neutral-200 rounded-sm${className ? " " + className : ""}`} style={style}>
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
  disabled = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: "good" | "bad" | "neutral";
  spark?: number[];
  sparkColor?: string;
  disabled?: boolean;
}) {
  const deltaToneClass =
    deltaTone === "good" ? "text-success-fg" : deltaTone === "bad" ? "text-fail-fg" : "text-neutral-700";
  return (
    <div className="bg-panel border border-neutral-200 rounded-sm py-4 px-[18px] flex flex-col gap-1.5 min-h-[124px]">
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">{label}</div>
      <div className="flex items-baseline gap-2">
        {disabled ? (
          <div className="font-display font-semibold text-[32px] leading-none tracking-[-0.02em] text-neutral-400">N/A</div>
        ) : (
          <div className="font-display font-semibold text-[32px] leading-none tracking-[-0.02em] text-coal">{value}</div>
        )}
        {!disabled && sub && (
          <div className="font-body font-medium text-sm leading-none text-neutral-700">{sub}</div>
        )}
      </div>
      <div className="flex items-center justify-between mt-auto">
        {!disabled && delta != null && (
          <div className={`font-mono text-[11px] ${deltaToneClass}`}>{delta}</div>
        )}
        {!disabled && spark && (
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
  size = "md",
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "py-1 px-2" : "py-1.5 px-3";
  return (
    <div className="inline-flex gap-0.5 p-[3px] bg-app-bg rounded-sm border border-neutral-200" data-size={size}>
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <Button
            key={t.id}
            type="button"
            variant="text"
            size={size}
            aria-pressed={isActive}
            onClick={() => onChange(t.id)}
            className={`border-none cursor-pointer ${pad} rounded-[3px] font-mono font-medium text-[11px] uppercase tracking-[-0.01em] transition-[color,background-color,box-shadow] duration-[var(--motion-base)] ease-[cubic-bezier(.2,0,0,1)] ${
              isActive ? "bg-panel shadow-[0_1px_2px_rgba(24,27,32,0.06)] text-coal" : "bg-transparent text-neutral-700"
            }`}
          >
            {t.label}
          </Button>
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

/* CkPagination, table footer with previous, next, and numbered pages. */
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
  const labelStart = total === 0 ? 0 : Math.min(start + 1, total);
  const labelEnd = total === 0 ? 0 : Math.min(start + shown, total);
  const btnClass = (disabled: boolean) =>
    `border border-neutral-200 py-[5px] px-2.5 rounded-[3px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] inline-flex items-center gap-1 transition-[color,background-color,border-color,opacity,transform] duration-[var(--motion-fast)] ${
      disabled ? "bg-off-white text-[#C7CBD0] cursor-default" : "bg-panel text-coal cursor-pointer"
    }`;
  const pages: (number | "…")[] = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 1) pages.push(i);
    else if (pages.at(-1) !== "…") pages.push("…");
  }
  return (
    <div className="flex items-center gap-2 py-3 px-5 border-t border-neutral-200 bg-[#FBFBFC]">
      <span className="font-mono text-[11px] text-neutral-700 tracking-[0.02em]">
        {labelStart} to {labelEnd} <span className="text-neutral-500">of</span> {total}
      </span>
      <div className="ml-auto inline-flex items-center gap-1">
        <Button variant="text" disabled={prevDisabled} onClick={() => !prevDisabled && onChange(page - 1)} className={btnClass(prevDisabled)}>
          ← Prev
        </Button>
        <div className="inline-flex gap-0.5 mx-1">
          {pages.map((p, i) =>
            p === "…" ? (
              <span key={"e" + i} className="py-[5px] px-1.5 font-mono text-[11px] text-neutral-500">…</span>
            ) : (
              <Button
                key={p}
                type="button"
                variant="text"
                aria-pressed={p === page}
                onClick={() => onChange(p)}
                className={`cursor-pointer min-w-[26px] py-[5px] px-[7px] rounded-[3px] font-mono text-[11px] font-medium transition-[color,background-color,border-color,transform] duration-[var(--motion-fast)] border ${
                  p === page ? "border-coal bg-coal text-white" : "border-neutral-200 bg-panel text-neutral-800"
                }`}
              >
                {p + 1}
              </Button>
            ),
          )}
        </div>
        <Button variant="text" disabled={nextDisabled} onClick={() => !nextDisabled && onChange(page + 1)} className={btnClass(nextDisabled)}>
          Next →
        </Button>
      </div>
    </div>
  );
}

/* TicketLink and PRLink, clickable Linear, Jira, and GitHub refs. */
export function TicketLink({ ticket, url, size = "sm" }: { ticket: string; url: string; size?: "sm" | "lg" }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 border border-neutral-200 rounded-xs bg-panel text-mariner no-underline font-mono font-medium tracking-[0.02em] whitespace-nowrap transition-[color,background-color,border-color,transform] duration-[var(--motion-fast)] hover:bg-mariner-100 hover:border-mariner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1 ${
        size === "sm" ? "py-0.5 px-1.5 text-[10px]" : "py-[3px] px-2 text-[11px]"
      }`}
    >
      {ticket}
      <span className="text-[9px] opacity-60">↗</span>
    </a>
  );
}

function PRLink({
  pr,
  repoLabel,
  size = "sm",
}: {
  pr: RunPullRequest;
  /** Shown before the reference to tell one run's PRs apart. Omitted for a
   *  single-PR run, where there is nothing to disambiguate. */
  repoLabel?: string;
  size?: "sm" | "lg";
}) {
  const naming = changeRequestNaming(pr);
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      title={pr.repoPath || undefined}
      className={`inline-flex items-center gap-1 border border-neutral-200 rounded-xs bg-coal text-white no-underline font-mono font-medium tracking-[0.02em] whitespace-nowrap transition-[color,background-color,border-color,transform] duration-[var(--motion-fast)] hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1 ${
        size === "sm" ? "py-0.5 px-1.5 text-[10px]" : "py-[3px] px-2 text-[11px]"
      }`}
    >
      {repoLabel && (
        // An unusually long name is ellipsized rather than allowed to push the
        // sibling chips out of the row; the full path stays in the title.
        <span className={`opacity-60 truncate ${size === "sm" ? "max-w-[104px]" : "max-w-[140px]"}`}>
          {repoLabel}
        </span>
      )}
      <span className="opacity-60">{naming.noun}</span>
      {naming.reference}
      <span className="text-[9px] opacity-70">↗</span>
    </a>
  );
}

/**
 * All of a run's PR/MR chips. A multi-repo run opens one per changed repository,
 * so each chip is qualified by repo name; a single-PR run keeps the bare ref it
 * has always shown. Renders nothing when the run opened none.
 */
export function PRLinks({
  run,
  size = "sm",
}: {
  run: { prs: RunPullRequest[] | null; prUrl: string | null; prNumber: number | null };
  size?: "sm" | "lg";
}) {
  const prs = runPullRequests(run);
  const repoLabels = prs.length > 1 ? pullRequestRepoLabels(prs) : [];
  return (
    <>
      {prs.map((pr, i) => (
        <PRLink
          key={`${pr.provider}:${pr.repoPath}:${pr.id}`}
          pr={pr}
          repoLabel={repoLabels[i]}
          size={size}
        />
      ))}
    </>
  );
}
