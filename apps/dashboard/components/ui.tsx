"use client";

// components/ui.tsx — Cockpit UI atoms shared across every screen.
// Ported from variations/cockpit-chrome.jsx (+ the Ticket/PR/Pagination helpers
// that lived in cockpit-screens.jsx). These are the design vocabulary; screens
// import from here and must not redefine them.

import React from "react";
import { Spark } from "@/components/charts";
import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, lineHeight: 1 }}>
      <svg width={w} height={size} viewBox="0 0 1168.768 1219.666" fill={color} aria-hidden="true">
        <path d="M 610.721 240.562 C 544.026 203.398 495.29 182.174 495.29 182.174 L 549.74 311.483 L 0 0 L 293.909 593.627 L 158.646 534.855 C 158.646 534.855 178.765 571.588 202.773 626.471 C 245.46 724.04 277.151 811.622 310.042 906.119 C 369.487 1076.721 531.542 1219.666 730.474 1219.666 C 972.525 1219.666 1168.768 1023.807 1168.768 782.188 C 1168.768 598.141 1054.873 440.599 893.586 376.017 C 796.449 337.124 702.096 291.556 610.673 240.61 L 610.721 240.61 Z" />
      </svg>
      {showWord && (
        <span
          style={{
            fontFamily: '"Rethink Sans", sans-serif',
            fontWeight: 700,
            fontSize: Math.round(size * 0.92),
            color: wordmarkColor,
            letterSpacing: "-0.01em",
            lineHeight: 1,
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
  const tones: Record<ChipTone, { bg: string; fg: string }> = {
    neutral: { bg: "#F2F4F6", fg: "#3E444C" },
    success: { bg: "#EAF7E0", fg: "#3F6B1E" },
    running: { bg: "#ECECFD", fg: "#3C43E7" },
    failed: { bg: "#FCE6E2", fg: "#A2351C" },
    warn: { bg: "#FFF4CC", fg: "#7A5A00" },
    blocked: { bg: "#F2F4F6", fg: "#5F666F" },
    awaiting: { bg: "#FFEFE9", fg: "#A2351C" },
    mariner: { bg: "#3C43E7", fg: "#fff" },
    orange: { bg: "#FD6027", fg: "#fff" },
    coal: { bg: "#181B20", fg: "#fff" },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 2,
        background: t.bg,
        color: t.fg,
        fontFamily: ckMono,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ── CkDot ───────────────────────────────────────────────────────────────── */
export function CkDot({ color = "#3C43E7", size = 6 }: { color?: string; size?: number }) {
  return (
    <span
      style={{ width: size, height: size, borderRadius: 999, background: color, display: "inline-block", flex: "0 0 auto" }}
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
    <section style={{ background: "#fff", border: ckBorder, borderRadius: 4, ...style }}>
      {hasHeader && (
        <header
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            padding: "18px 20px 14px",
            borderBottom: pad === 0 ? ckBorder : "none",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {eyebrow && (
              <div style={{ fontFamily: ckMono, fontSize: 10, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#5F666F" }}>
                {eyebrow}
              </div>
            )}
            {title && <h3 style={{ font: "500 16px/1.3 " + ckDisp, margin: 0, color: "#181B20" }}>{title}</h3>}
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
  return (
    <div style={{ background: "#fff", border: ckBorder, borderRadius: 4, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6, minHeight: 124 }}>
      <div style={{ fontFamily: ckMono, fontSize: 10, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#5F666F" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ font: "600 32px/1 " + ckDisp, letterSpacing: "-0.02em", color: "#181B20" }}>{value}</div>
        {sub && <div style={{ font: "500 14px/1 " + ckBody, color: "#5F666F" }}>{sub}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto" }}>
        {delta != null && (
          <div style={{ fontFamily: ckMono, fontSize: 11, color: deltaTone === "good" ? "#3F6B1E" : deltaTone === "bad" ? "#A2351C" : "#5F666F" }}>{delta}</div>
        )}
        {spark && (
          <div style={{ color: sparkColor, opacity: 0.85 }}>
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
    <div style={{ display: "inline-flex", gap: 2, padding: 3, background: "#F2F4F6", borderRadius: 4, border: ckBorder }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            appearance: "none",
            border: "none",
            cursor: "pointer",
            padding: "6px 12px",
            borderRadius: 3,
            background: active === t.id ? "#fff" : "transparent",
            boxShadow: active === t.id ? "0 1px 2px rgba(24,27,32,0.06)" : "none",
            color: active === t.id ? "#181B20" : "#5F666F",
            fontFamily: ckMono,
            fontWeight: 500,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "-0.01em",
            transition: "all 180ms cubic-bezier(.2,0,0,1)",
          }}
        >
          {t.label}
        </button>
      ))}
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
      <span style={{ position: "relative", width: 6, height: 6 }}>
        <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: m.dot }} />
        {(status === "running" || status === "awaiting") && (
          <span style={{ position: "absolute", inset: -3, borderRadius: 999, border: "1px solid " + m.dot, animation: "ckPulse 1.4s ease-in-out infinite" }} />
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
  const btn = (disabled: boolean): React.CSSProperties => ({
    appearance: "none",
    border: ckBorder,
    background: disabled ? "#F9FAFB" : "#fff",
    color: disabled ? "#C7CBD0" : "#181B20",
    padding: "5px 10px",
    borderRadius: 3,
    cursor: disabled ? "default" : "pointer",
    fontFamily: ckMono,
    fontSize: 11,
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    transition: "all 120ms",
  });
  const pages: (number | "…")[] = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== "…") pages.push("…");
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 20px", borderTop: ckBorder, background: "#FBFBFC" }}>
      <span style={{ fontFamily: ckMono, fontSize: 11, color: "#5F666F", letterSpacing: "0.02em" }}>
        {start + 1}–{start + shown} <span style={{ color: "#9EA3AA" }}>of</span> {total}
      </span>
      <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}>
        <button disabled={prevDisabled} onClick={() => !prevDisabled && onChange(page - 1)} style={btn(prevDisabled)}>
          ← Prev
        </button>
        <div style={{ display: "inline-flex", gap: 2, margin: "0 4px" }}>
          {pages.map((p, i) =>
            p === "…" ? (
              <span key={"e" + i} style={{ padding: "5px 6px", fontFamily: ckMono, fontSize: 11, color: "#9EA3AA" }}>…</span>
            ) : (
              <button
                key={p}
                onClick={() => onChange(p)}
                style={{
                  appearance: "none",
                  cursor: "pointer",
                  border: p === page ? "1px solid #181B20" : ckBorder,
                  background: p === page ? "#181B20" : "#fff",
                  color: p === page ? "#fff" : "#3E444C",
                  minWidth: 26,
                  padding: "5px 7px",
                  borderRadius: 3,
                  fontFamily: ckMono,
                  fontSize: 11,
                  fontWeight: 500,
                  transition: "all 120ms",
                }}
              >
                {p + 1}
              </button>
            ),
          )}
        </div>
        <button disabled={nextDisabled} onClick={() => !nextDisabled && onChange(page + 1)} style={btn(nextDisabled)}>
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: size === "sm" ? "2px 6px" : "3px 8px",
        border: ckBorder,
        borderRadius: 2,
        background: "#fff",
        color: "#3C43E7",
        textDecoration: "none",
        fontFamily: ckMono,
        fontSize: size === "sm" ? 10 : 11,
        fontWeight: 500,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        transition: "all 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#ECECFD";
        e.currentTarget.style.borderColor = "#3C43E7";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "#fff";
        e.currentTarget.style.borderColor = "#E6E8EB";
      }}
    >
      {ticket}
      <span style={{ fontSize: 9, opacity: 0.6 }}>↗</span>
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: size === "sm" ? "2px 6px" : "3px 8px",
        border: "1px solid " + "#E6E8EB",
        borderRadius: 2,
        background: "#181B20",
        color: "#fff",
        textDecoration: "none",
        fontFamily: ckMono,
        fontSize: size === "sm" ? 10 : 11,
        fontWeight: 500,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        transition: "all 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#3E444C";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "#181B20";
      }}
    >
      <span style={{ opacity: 0.6 }}>PR</span>#{num}
      <span style={{ fontSize: 9, opacity: 0.7 }}>↗</span>
    </a>
  );
}
