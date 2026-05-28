"use client";

import React, { useState, useEffect } from "react";
import { CkCard, CkKPI, CkChip } from "@/components/ui";
import { AIWF_DATA } from "@/lib/data/mock";
import type { Prompt, PromptVersion, PromptTag } from "@/lib/types";

const D = AIWF_DATA;

const PROMPT_STATUS_COLOR: Record<string, { bg: string; fg: string; dot: string }> = {
  production: { bg: "#EAF7E0", fg: "#3F6B1E", dot: "#5BB04A" },
  staging:    { bg: "#ECECFD", fg: "#3C43E7", dot: "#3C43E7" },
  draft:      { bg: "#FFF4CC", fg: "#7A5A00", dot: "#FFC800" },
  archived:   { bg: "#F2F4F6", fg: "#5F666F", dot: "#9EA3AA" },
  locked:     { bg: "#181B20", fg: "#fff",    dot: "#fff"    },
  "ab-test":  { bg: "#FFEFE9", fg: "#A2351C", dot: "#FD6027" },
};

function PromptStatusChip({ status }: { status: string }) {
  const c = PROMPT_STATUS_COLOR[status] || PROMPT_STATUS_COLOR.archived;
  return (
    <span
      className="inline-flex items-center gap-[5px] px-[7px] py-0.5 rounded-xs font-mono text-[9px] font-medium tracking-[0.04em] uppercase"
      style={{ background: c.bg, color: c.fg }}
    >
      <span className="w-[5px] h-[5px] rounded-full" style={{ background: c.dot }} />
      {status}
    </span>
  );
}

/* ───── Prompts list (left rail) ───── */
function PromptList({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState("all");
  const list = filter === "all" ? D.PROMPTS : D.PROMPTS.filter(p => p.tags.includes(filter as PromptTag));
  return (
    <CkCard
      eyebrow={`Arthur · ${D.PROMPTS.length} prompts`}
      title="Registry"
      action={
        <input
          placeholder="Search…"
          className="h-6 px-2 border border-neutral-200 rounded-xs font-mono text-[11px] text-neutral-900 outline-none bg-off-white w-[120px]"
        />
      }
      pad={0}
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
    >
      <div className="px-3.5 py-2 border-b border-neutral-200 flex gap-1 flex-wrap">
        {["all","production","staging","draft","locked"].map(t => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`appearance-none cursor-pointer px-2 py-1 rounded-xs font-mono text-[9px] font-medium tracking-[0.04em] uppercase border ${filter === t ? "border-coal bg-coal text-white" : "border-neutral-200 bg-panel text-neutral-700"}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {list.map((p, i) => {
          const on = active === p.id;
          return (
            <div
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={`px-4 py-[14px] cursor-pointer transition-all duration-100 border-l-[3px] ${i < list.length - 1 ? "border-b border-b-neutral-200" : ""} ${on ? "border-l-mariner bg-off-white" : "border-l-transparent bg-panel hover:bg-[#FAFBFC]"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[13px] font-semibold text-neutral-900">{p.name}</span>
                <span className="font-mono text-[10px] text-mariner font-semibold">{p.current}</span>
              </div>
              <div className="text-[11px] text-neutral-500 mt-[3px]">{p.workflowName}</div>
              <div className="flex items-center gap-1.5 mt-1.5">
                {p.tags.map(t => <PromptStatusChip key={t} status={t} />)}
                <span className={`ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] ${p.evalDelta > 0 ? "text-[#3F6B1E]" : p.evalDelta < 0 ? "text-[#A2351C]" : "text-neutral-500"}`}>
                  {(p.evalScore * 100).toFixed(0)}
                  <span>{p.evalDelta > 0 ? "↗" : p.evalDelta < 0 ? "↘" : "→"}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </CkCard>
  );
}

/* ───── Selected-prompt detail (right pane) ───── */
function PromptDetail({ promptId }: { promptId: string }) {
  const p = D.PROMPTS.find((x: Prompt) => x.id === promptId);
  const versions: PromptVersion[] = D.PROMPT_VERSIONS[promptId] || [];
  const [selA, setSelA] = useState<string | null>(versions[0]?.v || null);
  const [selB, setSelB] = useState<string | null>(versions[1]?.v || null);
  useEffect(() => {
    setSelA(versions[0]?.v || null);
    setSelB(versions[1]?.v || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId]);

  if (!p) {
    return (
      <CkCard style={{ height: "100%" }}>
        <div className="p-10 text-center text-neutral-500 font-body">Select a prompt to inspect.</div>
      </CkCard>
    );
  }

  if (!versions.length) {
    return (
      <CkCard
        eyebrow={`Arthur · ${p.workflowName} → ${p.span}`}
        title={p.name}
        action={
          <div className="flex gap-1.5">
            {p.tags.map(t => <PromptStatusChip key={t} status={t} />)}
          </div>
        }
        style={{ height: "100%" }}
      >
        <div className="py-10 text-center text-neutral-500 font-body">
          Detailed version history not yet captured for this prompt.<br/>
          <span className="font-mono text-[11px] text-neutral-700">Current: {p.current} · {p.versionCount} versions total</span>
        </div>
      </CkCard>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <CkCard
        eyebrow={`Arthur · ${p.workflowName} → ${p.span}`}
        title={p.name}
        action={
          <div className="flex items-center gap-2">
            {p.tags.map(t => <PromptStatusChip key={t} status={t} />)}
            <span className="w-px h-4 bg-neutral-200" />
            <button className="appearance-none border border-neutral-200 bg-panel px-3 py-1.5 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">+ New version</button>
            <button className="appearance-none border border-coal bg-coal text-white px-3 py-1.5 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] cursor-pointer">Deploy</button>
          </div>
        }
      >
        <div className="grid grid-cols-4 gap-4">
          <Stat label="Current version" value={p.current} sub={`by ${p.lastEditedBy} · ${(p.lastEditedAtMin/60).toFixed(0)}h ago`} />
          <Stat label="Versions"        value={p.versionCount} sub="lifetime" />
          <Stat label="Eval score"      value={(p.evalScore*100).toFixed(0)} sub={`${p.evalDelta > 0 ? "↗" : "↘"} ${Math.abs(p.evalDelta).toFixed(3)} vs prev`} tone={p.evalDelta > 0 ? "good" : "bad"} />
          <Stat label="Traffic split"   value={Object.keys(p.trafficSplit).length + "-way"} sub={Object.entries(p.trafficSplit).map(([v,s]) => v + " " + (s*100).toFixed(0) + "%").join(" / ")} />
        </div>
      </CkCard>

      {/* Version timeline */}
      <CkCard eyebrow="Version timeline" title="History"
        action={
          <span className="font-mono text-[10px] text-neutral-700 tracking-[0.04em] uppercase">
            Click to inspect · ⇧-click to compare
          </span>
        }
      >
        <div className="flex items-stretch gap-0">
          {versions.map((v, i) => {
            const isA = selA === v.v;
            const isB = selB === v.v;
            const borderColor = isA ? "#3C43E7" : isB ? "#FD6027" : "#E6E8EB";
            const dropRightBorder = i < versions.length - 1 && !isA && !isB;
            return (
              <button
                key={v.v}
                onClick={(e) => { if (e.shiftKey) setSelB(v.v); else setSelA(v.v); }}
                className={`flex-1 appearance-none cursor-pointer text-left px-4 py-[14px] relative ${isA ? "bg-mariner-100" : isB ? "bg-[#FFEFE9]" : "bg-panel"}`}
                style={{
                  border: "1px solid " + borderColor,
                  borderRight: dropRightBorder ? "none" : "1px solid " + borderColor,
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-sm font-semibold text-neutral-900">{v.v}</span>
                  <PromptStatusChip status={v.status} />
                </div>
                <div className="font-mono text-[10px] text-neutral-500 mb-2">{v.deployedAt} · {v.by}</div>
                <div className="grid grid-cols-2 gap-1 font-mono text-[10px]">
                  <span className="text-neutral-700">eval</span><span className="text-neutral-900 font-semibold text-right">{(v.evalScore*100).toFixed(0)}</span>
                  <span className="text-neutral-700">halluc</span><span className="text-neutral-900 text-right">{v.halluc.toFixed(3)}</span>
                  <span className="text-neutral-700">p95</span><span className="text-neutral-900 text-right">{v.p95}s</span>
                  <span className="text-neutral-700">$/run</span><span className="text-neutral-900 text-right">${v.costAvg.toFixed(3)}</span>
                </div>
                {v.traffic > 0 && (
                  <div className="mt-2 h-1 bg-app-bg rounded-[1px]">
                    <div className={`h-full rounded-[1px] ${v.status === "production" ? "bg-[#5BB04A]" : "bg-mariner"}`} style={{ width: (v.traffic*100) + "%" }} />
                  </div>
                )}
                {(isA || isB) && (
                  <span className={`absolute -top-2 left-3 px-1.5 py-px rounded-full text-white font-mono text-[9px] tracking-[0.04em] uppercase ${isA ? "bg-mariner" : "bg-burnt-orange"}`}>
                    {isA ? "A" : "B"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CkCard>

      {/* Diff + metrics */}
      <div className="grid grid-cols-[1.6fr_1fr] gap-3">
        <PromptDiff a={selA} b={selB} versions={versions} />
        <PromptMetrics versions={versions} selA={selA} selB={selB} />
      </div>
    </div>
  );
}

/* ───── Mini stat (used in prompt header) ───── */
function Stat({ label, value, sub, tone }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; tone?: "good" | "bad" }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase">{label}</div>
      <div className="font-display font-medium text-[26px] leading-[1.1] tracking-[-0.02em] text-neutral-900 mt-1">{value}</div>
      {sub && <div className={`font-mono text-[11px] mt-0.5 ${tone === "good" ? "text-[#3F6B1E]" : tone === "bad" ? "text-[#A2351C]" : "text-neutral-500"}`}>{sub}</div>}
    </div>
  );
}

/* ───── Diff viewer ───── */
function PromptDiff({ a, b, versions }: { a: string | null; b: string | null; versions: PromptVersion[] }) {
  const bodyA = (a && D.PROMPT_BODIES[a]) || `# ${a}\n(prompt body not captured in mock)`;
  const bodyB = (b && D.PROMPT_BODIES[b]) || `# ${b}\n(prompt body not captured in mock)`;
  // Naive line-diff: pair lines by index, mark added/removed/equal.
  const linesA = bodyA.split("\n");
  const linesB = bodyB.split("\n");
  const max = Math.max(linesA.length, linesB.length);
  return (
    <CkCard
      eyebrow="Prompt diff · text"
      title={`${b} → ${a}`}
      action={
        <div className="flex gap-2">
          <CkChip style={{ background: "#FFEFE9", color: "#A2351C" }}>−{linesB.length} from {b}</CkChip>
          <CkChip style={{ background: "#EAF7E0", color: "#3F6B1E" }}>+{linesA.length} into {a}</CkChip>
        </div>
      }
    >
      <div className="border border-neutral-200 rounded-xs overflow-hidden max-h-[340px]">
        <div className="overflow-auto max-h-[340px] font-mono text-[11px] leading-[1.55]">
          {Array.from({ length: max }).map((_, i) => {
            const la = linesA[i] ?? "";
            const lb = linesB[i] ?? "";
            const same = la === lb;
            return (
              <div key={i} className="grid grid-cols-2">
                <div className={`flex border-r border-neutral-200 ${same ? "bg-panel text-neutral-700" : (lb ? "bg-[#FCE6E2] text-[#80261C]" : "bg-off-white text-neutral-700")}`}>
                  <span className="flex-[0_0_36px] text-right px-2 py-px text-[#D2D6DA] select-none">{lb ? (i + 1) : ""}</span>
                  <span className={`flex-[0_0_14px] text-center font-semibold ${same ? "text-[#D2D6DA]" : "text-[#A2351C]"}`}>{same ? " " : (lb ? "−" : " ")}</span>
                  <span className="flex-1 px-1.5 py-px whitespace-pre-wrap break-words">{lb}</span>
                </div>
                <div className={`flex ${same ? "bg-panel text-neutral-900" : (la ? "bg-[#EAF7E0] text-[#1C4A0E]" : "bg-off-white text-neutral-900")}`}>
                  <span className="flex-[0_0_36px] text-right px-2 py-px text-[#D2D6DA] select-none">{la ? (i + 1) : ""}</span>
                  <span className={`flex-[0_0_14px] text-center font-semibold ${same ? "text-[#D2D6DA]" : "text-[#3F6B1E]"}`}>{same ? " " : (la ? "+" : " ")}</span>
                  <span className="flex-1 px-1.5 py-px whitespace-pre-wrap break-words">{la}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </CkCard>
  );
}

/* ───── Metrics comparison ───── */
function PromptMetrics({ versions, selA, selB }: { versions: PromptVersion[]; selA: string | null; selB: string | null }) {
  const a = versions.find(v => v.v === selA);
  const b = versions.find(v => v.v === selB);
  const rows: { k: keyof PromptVersion; l: string; fmt: (v: number) => string; better: "higher" | "lower" | null }[] = [
    { k: "evalScore",  l: "Eval score",       fmt: (v) => (v*100).toFixed(0), better: "higher" },
    { k: "halluc",     l: "Hallucination",    fmt: (v) => v.toFixed(3),        better: "lower"  },
    { k: "p95",        l: "p95 latency",      fmt: (v) => v.toFixed(1) + "s",  better: "lower"  },
    { k: "costAvg",    l: "Cost / run",       fmt: (v) => "$" + v.toFixed(3),  better: "lower"  },
    { k: "runs",       l: "Runs (lifetime)",  fmt: (v) => v.toLocaleString("en-US"),  better: null     },
  ];
  return (
    <CkCard eyebrow="Side-by-side" title="Metrics">
      <div className="grid grid-cols-[1fr_auto_auto] gap-y-3 gap-x-4 items-center">
        <span />
        <span className="font-mono text-[10px] text-mariner font-semibold tracking-[0.06em] uppercase">A · {selA}</span>
        <span className="font-mono text-[10px] text-burnt-orange font-semibold tracking-[0.06em] uppercase">B · {selB}</span>
        {rows.map(r => {
          const av = a ? (a[r.k] as number) : null;
          const bv = b ? (b[r.k] as number) : null;
          let aWins = false, bWins = false;
          if (av !== null && bv !== null && r.better) {
            if (r.better === "higher") aWins = av > bv;
            if (r.better === "lower")  aWins = av < bv;
            bWins = !aWins;
          }
          return (
            <React.Fragment key={r.k}>
              <span className="font-body font-medium text-[13px] leading-none text-neutral-800">{r.l}</span>
              <span className={`font-mono text-sm font-semibold text-right ${aWins ? "text-[#3F6B1E]" : "text-neutral-900"}`}>
                {av != null ? r.fmt(av) : "—"}
                {aWins && <span className="ml-1 text-[#3F6B1E] text-[11px]">✓</span>}
              </span>
              <span className={`font-mono text-sm font-semibold text-right ${bWins ? "text-[#3F6B1E]" : "text-neutral-500"}`}>
                {bv != null ? r.fmt(bv) : "—"}
                {bWins && <span className="ml-1 text-[#3F6B1E] text-[11px]">✓</span>}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-neutral-200 font-mono text-[10px] text-neutral-700 tracking-[0.04em] uppercase">
        Sample size: {a?.runs.toLocaleString("en-US")} vs {b?.runs.toLocaleString("en-US")} runs
      </div>
    </CkCard>
  );
}

/* ───── Top-level screen ───── */
export function PromptsScreen() {
  const [active, setActive] = useState(D.PROMPTS[0].id);
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">Arthur engine · prompt versioning</div>
          <h2 className="font-display font-medium text-2xl leading-[1.2] m-0 text-neutral-900">Prompt registry</h2>
        </div>
        <div className="flex gap-2">
          <button className="appearance-none border border-neutral-200 bg-panel px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">Import from prod</button>
          <button className="appearance-none border border-coal bg-coal text-white px-3.5 py-2 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] cursor-pointer">+ New prompt</button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <CkKPI label="Prompts"         value={D.PROMPTS.length.toString()}                                    sub="across 6 workflows" />
        <CkKPI label="In production"   value={D.PROMPTS.filter(p => p.tags.includes("production")).length.toString()} sub="serving traffic" />
        <CkKPI label="A/B tests"       value={D.PROMPTS.filter(p => p.tags.includes("ab-test")).length.toString()}    sub="live experiments" />
        <CkKPI label="Avg eval Δ · 7d" value="+0.4%"                                                          sub="across all prompts" delta="↗ improving" deltaTone="good" />
      </div>

      <div className="grid grid-cols-[340px_1fr] gap-3 min-h-[720px]">
        <PromptList active={active} onSelect={setActive} />
        <PromptDetail promptId={active} />
      </div>
    </div>
  );
}
