"use client";

import { useState } from "react";
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
      <div onClick={onClose} className="fixed inset-0 bg-[rgba(24,27,32,0.16)] z-50 animate-ck-pulse" />
      <aside className="fixed top-0 right-0 bottom-0 w-[420px] bg-panel border-l border-neutral-200 z-[51] flex flex-col animate-ck-slide shadow-[-12px_0_32px_rgba(24,27,32,0.08)]">
        <header className="flex-[0_0_auto] px-[18px] py-4 border-b border-neutral-200 flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] text-neutral-700 tracking-[0.08em] uppercase">Activity stream</span>
            <span className="font-display font-medium text-base leading-[1.2] text-neutral-900">Live events · all sources</span>
          </div>
          <button onClick={onClose} className="appearance-none border border-neutral-200 bg-panel w-7 h-7 rounded-[3px] cursor-pointer font-mono text-sm text-neutral-700">×</button>
        </header>

        <div className="flex-[0_0_auto] px-[18px] py-[10px] border-b border-neutral-200 flex gap-1.5 flex-wrap">
          {[
            { id: "all",    label: "All" },
            { id: "vercel", label: "Vercel" },
            { id: "arthur", label: "Arthur" },
            { id: "github", label: "GitHub" },
            { id: "linear", label: "Linear" },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`appearance-none cursor-pointer px-[10px] py-1 rounded-xs border font-mono text-[10px] font-medium tracking-[0.04em] uppercase ${
                filter === f.id
                  ? "bg-neutral-900 text-white border-neutral-900"
                  : "bg-panel text-neutral-700 border-neutral-200"
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-[#3F6B1E] tracking-[0.04em] uppercase">
            <span className="relative w-1.5 h-1.5">
              <span className="absolute inset-0 rounded-full bg-[#5BB04A]" />
              <span className="absolute -inset-[3px] rounded-full border border-[#5BB04A] animate-ck-pulse" />
            </span>
            Tailing
          </span>
        </div>

        <div className="flex-1 overflow-auto py-2">
          {list.map((e, i) => {
            const c = lvlColor(e.lvl);
            const s = srcLabel(e.src);
            return (
              <div
                key={e.id}
                className={`px-[18px] py-[10px] flex flex-col gap-1 border-l-2 ${i < list.length - 1 ? "border-b border-b-neutral-200" : ""}`}
                style={{ borderLeftColor: c }}
              >
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="text-neutral-500">{e.t}</span>
                  <span className="font-medium" style={{ color: s.fg }}>{s.label}</span>
                  <span className="text-[#D2D6DA]">·</span>
                  <span className="uppercase tracking-[0.06em] font-semibold" style={{ color: c }}>{e.lvl}</span>
                  <span className="ml-auto text-neutral-700">{e.scope}</span>
                </div>
                <div className="font-body text-[13px] text-neutral-900">{e.msg}</div>
                {e.ticket && (
                  <div className="flex gap-1.5 mt-0.5">
                    <span className="font-mono text-[10px] text-neutral-700 border border-neutral-200 px-1.5 py-px rounded-xs">{e.ticket}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <footer className="flex-[0_0_auto] px-[18px] py-3 border-t border-neutral-200 flex items-center justify-between font-mono text-[10px] text-neutral-500">
          <span>{list.length} events</span>
          <span>⌘. to close</span>
        </footer>
      </aside>
    </>
  );
}
