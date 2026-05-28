"use client";

import React, { useState, useEffect } from "react";
import { CkCard, CkKPI, CkChip } from "@/components/ui";
import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
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
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 7px", borderRadius: 2,
      background: c.bg, color: c.fg,
      fontFamily: ckMono, fontSize: 9, fontWeight: 500,
      letterSpacing: "0.04em", textTransform: "uppercase",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 999, background: c.dot }} />
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
        <input placeholder="Search…" style={{
          height: 24, padding: "0 8px", border: ckBorder, borderRadius: 2,
          fontFamily: ckMono, fontSize: 11, color: "#181B20", outline: "none",
          background: "#F9FAFB", width: 120,
        }} />
      }
      pad={0}
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
    >
      <div style={{ padding: "8px 14px", borderBottom: ckBorder, display: "flex", gap: 4, flexWrap: "wrap" }}>
        {["all","production","staging","draft","locked"].map(t => (
          <button key={t} onClick={() => setFilter(t)} style={{
            appearance: "none", cursor: "pointer",
            padding: "4px 8px", borderRadius: 2,
            border: "1px solid " + (filter === t ? "#181B20" : "#E6E8EB"),
            background: filter === t ? "#181B20" : "#fff",
            color: filter === t ? "#fff" : "#5F666F",
            fontFamily: ckMono, fontSize: 9, fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase",
          }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {list.map((p, i) => {
          const on = active === p.id;
          return (
            <div key={p.id} onClick={() => onSelect(p.id)} style={{
              padding: "14px 16px",
              borderBottom: i < list.length - 1 ? ckBorder : "none",
              borderLeft: on ? "3px solid #3C43E7" : "3px solid transparent",
              background: on ? "#F9FAFB" : "#fff",
              cursor: "pointer", transition: "all 120ms",
            }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "#FAFBFC"; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "#fff"; }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontFamily: ckMono, fontSize: 13, fontWeight: 600, color: "#181B20" }}>{p.name}</span>
                <span style={{ fontFamily: ckMono, fontSize: 10, color: "#3C43E7", fontWeight: 600 }}>{p.current}</span>
              </div>
              <div style={{ fontSize: 11, color: "#9EA3AA", marginTop: 3 }}>{p.workflowName}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                {p.tags.map(t => <PromptStatusChip key={t} status={t} />)}
                <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontFamily: ckMono, fontSize: 10, color: p.evalDelta > 0 ? "#3F6B1E" : p.evalDelta < 0 ? "#A2351C" : "#9EA3AA" }}>
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
        <div style={{ padding: 40, textAlign: "center", color: "#9EA3AA", fontFamily: ckBody }}>Select a prompt to inspect.</div>
      </CkCard>
    );
  }

  if (!versions.length) {
    return (
      <CkCard
        eyebrow={`Arthur · ${p.workflowName} → ${p.span}`}
        title={p.name}
        action={
          <div style={{ display: "flex", gap: 6 }}>
            {p.tags.map(t => <PromptStatusChip key={t} status={t} />)}
          </div>
        }
        style={{ height: "100%" }}
      >
        <div style={{ padding: "40px 0", textAlign: "center", color: "#9EA3AA", fontFamily: ckBody }}>
          Detailed version history not yet captured for this prompt.<br/>
          <span style={{ fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>Current: {p.current} · {p.versionCount} versions total</span>
        </div>
      </CkCard>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <CkCard
        eyebrow={`Arthur · ${p.workflowName} → ${p.span}`}
        title={p.name}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {p.tags.map(t => <PromptStatusChip key={t} status={t} />)}
            <span style={{ width: 1, height: 16, background: "#E6E8EB" }} />
            <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "6px 12px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>+ New version</button>
            <button style={{ appearance: "none", border: "1px solid #181B20", background: "#181B20", color: "#fff", padding: "6px 12px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>Deploy</button>
          </div>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          <Stat label="Current version" value={p.current} sub={`by ${p.lastEditedBy} · ${(p.lastEditedAtMin/60).toFixed(0)}h ago`} />
          <Stat label="Versions"        value={p.versionCount} sub="lifetime" />
          <Stat label="Eval score"      value={(p.evalScore*100).toFixed(0)} sub={`${p.evalDelta > 0 ? "↗" : "↘"} ${Math.abs(p.evalDelta).toFixed(3)} vs prev`} tone={p.evalDelta > 0 ? "good" : "bad"} />
          <Stat label="Traffic split"   value={Object.keys(p.trafficSplit).length + "-way"} sub={Object.entries(p.trafficSplit).map(([v,s]) => v + " " + (s*100).toFixed(0) + "%").join(" / ")} />
        </div>
      </CkCard>

      {/* Version timeline */}
      <CkCard eyebrow="Version timeline" title="History"
        action={
          <span style={{ fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Click to inspect · ⇧-click to compare
          </span>
        }
      >
        <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
          {versions.map((v, i) => {
            const isA = selA === v.v;
            const isB = selB === v.v;
            return (
              <button key={v.v} onClick={(e) => {
                if (e.shiftKey) setSelB(v.v); else setSelA(v.v);
              }} style={{
                flex: 1, appearance: "none", cursor: "pointer", textAlign: "left",
                padding: "14px 16px",
                background: isA ? "#ECECFD" : isB ? "#FFEFE9" : "#fff",
                border: "1px solid " + (isA ? "#3C43E7" : isB ? "#FD6027" : ckBorder),
                borderRight: i < versions.length - 1 && !isA && !isB ? "none" : "1px solid " + (isA ? "#3C43E7" : isB ? "#FD6027" : ckBorder),
                position: "relative",
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontFamily: ckMono, fontSize: 14, fontWeight: 600, color: "#181B20" }}>{v.v}</span>
                  <PromptStatusChip status={v.status} />
                </div>
                <div style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", marginBottom: 8 }}>{v.deployedAt} · {v.by}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontFamily: ckMono, fontSize: 10 }}>
                  <span style={{ color: "#5F666F" }}>eval</span><span style={{ color: "#181B20", fontWeight: 600, textAlign: "right" }}>{(v.evalScore*100).toFixed(0)}</span>
                  <span style={{ color: "#5F666F" }}>halluc</span><span style={{ color: "#181B20", textAlign: "right" }}>{v.halluc.toFixed(3)}</span>
                  <span style={{ color: "#5F666F" }}>p95</span><span style={{ color: "#181B20", textAlign: "right" }}>{v.p95}s</span>
                  <span style={{ color: "#5F666F" }}>$/run</span><span style={{ color: "#181B20", textAlign: "right" }}>${v.costAvg.toFixed(3)}</span>
                </div>
                {v.traffic > 0 && (
                  <div style={{ marginTop: 8, height: 4, background: "#F2F4F6", borderRadius: 1 }}>
                    <div style={{ width: (v.traffic*100) + "%", height: "100%", background: v.status === "production" ? "#5BB04A" : "#3C43E7", borderRadius: 1 }} />
                  </div>
                )}
                {(isA || isB) && (
                  <span style={{ position: "absolute", top: -8, left: 12, padding: "1px 6px", borderRadius: 999, background: isA ? "#3C43E7" : "#FD6027", color: "#fff", fontFamily: ckMono, fontSize: 9, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    {isA ? "A" : "B"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CkCard>

      {/* Diff + metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 12 }}>
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
      <div style={{ fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ font: '500 26px/1.1 ' + ckDisp, letterSpacing: "-0.02em", color: "#181B20", marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontFamily: ckMono, fontSize: 11, color: tone === "good" ? "#3F6B1E" : tone === "bad" ? "#A2351C" : "#9EA3AA", marginTop: 2 }}>{sub}</div>}
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
        <div style={{ display: "flex", gap: 8 }}>
          <CkChip style={{ background: "#FFEFE9", color: "#A2351C" }}>−{linesB.length} from {b}</CkChip>
          <CkChip style={{ background: "#EAF7E0", color: "#3F6B1E" }}>+{linesA.length} into {a}</CkChip>
        </div>
      }
    >
      <div style={{ border: ckBorder, borderRadius: 2, overflow: "hidden", maxHeight: 340 }}>
        <div style={{ overflow: "auto", maxHeight: 340, fontFamily: ckMono, fontSize: 11, lineHeight: 1.55 }}>
          {Array.from({ length: max }).map((_, i) => {
            const la = linesA[i] ?? "";
            const lb = linesB[i] ?? "";
            const same = la === lb;
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
                <div style={{ display: "flex", background: same ? "#fff" : (lb ? "#FCE6E2" : "#F9FAFB"), color: same ? "#5F666F" : "#80261C", borderRight: ckBorder }}>
                  <span style={{ flex: "0 0 36px", textAlign: "right", padding: "1px 8px", color: "#D2D6DA", userSelect: "none" }}>{lb ? (i + 1) : ""}</span>
                  <span style={{ flex: "0 0 14px", textAlign: "center", color: same ? "#D2D6DA" : "#A2351C", fontWeight: 600 }}>{same ? " " : (lb ? "−" : " ")}</span>
                  <span style={{ flex: 1, padding: "1px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{lb}</span>
                </div>
                <div style={{ display: "flex", background: same ? "#fff" : (la ? "#EAF7E0" : "#F9FAFB"), color: same ? "#181B20" : "#1C4A0E" }}>
                  <span style={{ flex: "0 0 36px", textAlign: "right", padding: "1px 8px", color: "#D2D6DA", userSelect: "none" }}>{la ? (i + 1) : ""}</span>
                  <span style={{ flex: "0 0 14px", textAlign: "center", color: same ? "#D2D6DA" : "#3F6B1E", fontWeight: 600 }}>{same ? " " : (la ? "+" : " ")}</span>
                  <span style={{ flex: 1, padding: "1px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{la}</span>
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
    { k: "runs",       l: "Runs (lifetime)",  fmt: (v) => v.toLocaleString(),  better: null     },
  ];
  return (
    <CkCard eyebrow="Side-by-side" title="Metrics">
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", rowGap: 12, columnGap: 16, alignItems: "center" }}>
        <span />
        <span style={{ fontFamily: ckMono, fontSize: 10, color: "#3C43E7", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>A · {selA}</span>
        <span style={{ fontFamily: ckMono, fontSize: 10, color: "#FD6027", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>B · {selB}</span>
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
              <span style={{ font: '500 13px/1 ' + ckBody, color: "#3E444C" }}>{r.l}</span>
              <span style={{ fontFamily: ckMono, fontSize: 14, fontWeight: 600, color: aWins ? "#3F6B1E" : "#181B20", textAlign: "right" }}>
                {av != null ? r.fmt(av) : "—"}
                {aWins && <span style={{ marginLeft: 4, color: "#3F6B1E", fontSize: 11 }}>✓</span>}
              </span>
              <span style={{ fontFamily: ckMono, fontSize: 14, fontWeight: 600, color: bWins ? "#3F6B1E" : "#9EA3AA", textAlign: "right" }}>
                {bv != null ? r.fmt(bv) : "—"}
                {bWins && <span style={{ marginLeft: 4, color: "#3F6B1E", fontSize: 11 }}>✓</span>}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: ckBorder, fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.04em", textTransform: "uppercase" }}>
        Sample size: {a?.runs.toLocaleString()} vs {b?.runs.toLocaleString()} runs
      </div>
    </CkCard>
  );
}

/* ───── Top-level screen ───── */
export function PromptsScreen() {
  const [active, setActive] = useState(D.PROMPTS[0].id);
  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Arthur engine · prompt versioning</div>
          <h2 style={{ font: '500 24px/1.2 ' + ckDisp, margin: 0, color: "#181B20" }}>Prompt registry</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "8px 14px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>Import from prod</button>
          <button style={{ appearance: "none", border: "1px solid #181B20", background: "#181B20", color: "#fff", padding: "8px 14px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>+ New prompt</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <CkKPI label="Prompts"         value={D.PROMPTS.length.toString()}                                    sub="across 6 workflows" />
        <CkKPI label="In production"   value={D.PROMPTS.filter(p => p.tags.includes("production")).length.toString()} sub="serving traffic" />
        <CkKPI label="A/B tests"       value={D.PROMPTS.filter(p => p.tags.includes("ab-test")).length.toString()}    sub="live experiments" />
        <CkKPI label="Avg eval Δ · 7d" value="+0.4%"                                                          sub="across all prompts" delta="↗ improving" deltaTone="good" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 12, minHeight: 720 }}>
        <PromptList active={active} onSelect={setActive} />
        <PromptDetail promptId={active} />
      </div>
    </div>
  );
}
