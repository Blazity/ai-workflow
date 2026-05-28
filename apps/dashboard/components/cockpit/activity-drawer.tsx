"use client";

import { useState } from "react";
import { ckBorder, ckMono, ckBody, ckDisp } from "@/lib/theme";
import { AIWF_DATA } from "@/lib/data/mock";

const D = AIWF_DATA;

type ActLevel = "ok" | "info" | "warn" | "fail";

interface ActEvent {
  id: string;
  t: string;
  src: string;
  lvl: ActLevel;
  scope: string;
  msg: string;
  ticket?: string;
}

const ACT_EVENTS: ActEvent[] = [
  { id: "e1",  t: "14:32:08", src: "vercel.workflow", lvl: "ok",    scope: "wf_pr_review",     msg: "run_4a82b1 completed · 18.34s · $0.34 · eval 94",  ticket: "LIN-4521" },
  { id: "e2",  t: "14:32:01", src: "github",          lvl: "ok",    scope: "pulls.create",     msg: "PR #2147 opened · checkout: multi-currency support" },
  { id: "e3",  t: "14:31:58", src: "vercel.sandbox",  lvl: "ok",    scope: "exec",             msg: "pnpm test → 312 passed, 0 failed (4.12s)" },
  { id: "e4",  t: "14:31:54", src: "arthur",          lvl: "warn",  scope: "guardrail",        msg: "toxicity = 0.071 — flagged on output of span s08" },
  { id: "e5",  t: "14:31:48", src: "vercel.gateway",  lvl: "info",  scope: "claude-sonnet-4",  msg: "5.68s · 12,440 → 3,210 tokens · $0.182" },
  { id: "e6",  t: "14:30:12", src: "arthur",          lvl: "ok",    scope: "guardrail",        msg: "prompt_injection pass · 0.001 score" },
  { id: "e7",  t: "14:30:09", src: "linear",          lvl: "info",  scope: "issue.assigned",   msg: "ai-bot picked up LIN-4521 from sara.k" },
  { id: "e8",  t: "14:28:44", src: "vercel.workflow", lvl: "ok",    scope: "wf_triage",        msg: "run_d12a73 completed · 4.1s · $0.04 · eval 91" },
  { id: "e9",  t: "14:27:30", src: "vercel.gateway",  lvl: "warn",  scope: "budget",           msg: "wf_pr_review at 64% of monthly cap" },
  { id: "e10", t: "14:25:02", src: "arthur",          lvl: "fail",  scope: "guardrail",        msg: "toxicity flag rate up 38% on wf_release_notes" },
];

const lvlColor = (lvl: ActLevel): string => ({
  ok:   "#5BB04A",
  info: "#3C43E7",
  warn: "#FFC800",
  fail: "#D14343",
}[lvl] || "#5F666F");

const srcLabel = (src: string): { fg: string; label: string } => {
  if (src.startsWith("vercel"))   return { fg: "#181B20", label: src };
  if (src === "arthur")           return { fg: "#FD6027", label: "arthur.engine" };
  if (src === "github")           return { fg: "#5F666F", label: "github" };
  if (src === "linear")           return { fg: "#3C43E7", label: "linear" };
  return { fg: "#5F666F", label: src };
};

export function CkActivityDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState("all");
  const list = filter === "all" ? ACT_EVENTS : ACT_EVENTS.filter(e => e.src.startsWith(filter) || e.src === filter);

  if (!open) return null;
  return (
    <>
      {/* scrim */}
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(24,27,32,0.16)", zIndex: 50, animation: "ckPulse 200ms ease-out",
      }} />
      <aside style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 420,
        background: "#fff", borderLeft: ckBorder, zIndex: 51,
        display: "flex", flexDirection: "column",
        boxShadow: "-12px 0 32px rgba(24,27,32,0.08)",
        animation: "ckSlide 280ms cubic-bezier(.2,0,0,1) both",
      }}>
        <header style={{ flex: "0 0 auto", padding: "16px 18px", borderBottom: ckBorder, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.08em", textTransform: "uppercase" }}>Activity stream</span>
            <span style={{ font: "500 16px/1.2 " + ckDisp, color: "#181B20" }}>Live events · all sources</span>
          </div>
          <button onClick={onClose} style={{ appearance: "none", border: ckBorder, background: "#fff", width: 28, height: 28, borderRadius: 3, cursor: "pointer", fontFamily: ckMono, fontSize: 14, color: "#5F666F" }}>×</button>
        </header>

        <div style={{ flex: "0 0 auto", padding: "10px 18px", borderBottom: ckBorder, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { id: "all",    label: "All" },
            { id: "vercel", label: "Vercel" },
            { id: "arthur", label: "Arthur" },
            { id: "github", label: "GitHub" },
            { id: "linear", label: "Linear" },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              appearance: "none", cursor: "pointer",
              padding: "4px 10px", borderRadius: 2,
              border: "1px solid " + (filter === f.id ? "#181B20" : "#E6E8EB"),
              background: filter === f.id ? "#181B20" : "#fff",
              color: filter === f.id ? "#fff" : "#5F666F",
              fontFamily: ckMono, fontSize: 10, fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase",
            }}>{f.label}</button>
          ))}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontFamily: ckMono, fontSize: 10, color: "#3F6B1E", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            <span style={{ position: "relative", width: 6, height: 6 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: "#5BB04A" }} />
              <span style={{ position: "absolute", inset: -3, borderRadius: 999, border: "1px solid #5BB04A", animation: "ckPulse 1.6s infinite" }} />
            </span>
            Tailing
          </span>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
          {list.map((e, i) => {
            const c = lvlColor(e.lvl);
            const s = srcLabel(e.src);
            return (
              <div key={e.id} style={{
                padding: "10px 18px",
                borderLeft: "2px solid " + c,
                borderBottom: i < list.length - 1 ? ckBorder : "none",
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: ckMono, fontSize: 10 }}>
                  <span style={{ color: "#9EA3AA" }}>{e.t}</span>
                  <span style={{ color: s.fg, fontWeight: 500 }}>{s.label}</span>
                  <span style={{ color: "#D2D6DA" }}>·</span>
                  <span style={{ color: c, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{e.lvl}</span>
                  <span style={{ marginLeft: "auto", color: "#5F666F" }}>{e.scope}</span>
                </div>
                <div style={{ fontFamily: ckBody, fontSize: 13, color: "#181B20" }}>{e.msg}</div>
                {e.ticket && (
                  <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                    <span style={{ fontFamily: ckMono, fontSize: 10, color: "#5F666F", border: "1px solid #E6E8EB", padding: "1px 6px", borderRadius: 2 }}>{e.ticket}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <footer style={{ flex: "0 0 auto", padding: "12px 18px", borderTop: ckBorder, display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: ckMono, fontSize: 10, color: "#9EA3AA" }}>
          <span>{list.length} events</span>
          <span>⌘. to close</span>
        </footer>
      </aside>
    </>
  );
}
