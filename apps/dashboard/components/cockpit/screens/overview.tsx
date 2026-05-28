"use client";

import React, { useState, useEffect } from "react";
import {
  CkCard,
  CkKPI,
  CkChip,
  CkStatusPill,
  CkDot,
  TicketLink,
  PRLink,
  CkPagination,
} from "@/components/ui";
import { Spark, Donut } from "@/components/charts";
import { ckBorder, ckMono, ckDisp, ckBody, spanColor } from "@/lib/theme";
import { AIWF_DATA } from "@/lib/data/mock";
import { useCockpit } from "@/components/cockpit/context";
import type { Run } from "@/lib/types";

const D = AIWF_DATA;

/* Eval health KPI — fits the hero KPI strip but shows a mini-donut + breakdown. */
function EvalHealthKPI() {
  return (
    <div style={{ background: "#fff", border: ckBorder, borderRadius: 4, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6, minHeight: 124 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: ckMono, fontSize: 10, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#5F666F" }}>Eval health</div>
        <a style={{ fontFamily: ckMono, fontSize: 10, color: "#3C43E7", textDecoration: "none", letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>Detail →</a>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 2 }}>
        <Donut shares={[0.78, 0.14, 0.08]} colors={["#5BB04A", "#FFC800", "#D14343"]} size={64} thickness={10} centerLabel="92.3" />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: ckBody, fontSize: 12 }}>
            <CkDot color="#5BB04A" /><span style={{ flex: 1, color: "#3E444C" }}>Pass</span><b style={{ fontFamily: ckMono, color: "#181B20" }}>7</b>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: ckBody, fontSize: 12 }}>
            <CkDot color="#FFC800" /><span style={{ flex: 1, color: "#3E444C" }}>Warn</span><b style={{ fontFamily: ckMono, color: "#181B20" }}>2</b>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: ckBody, fontSize: 12 }}>
            <CkDot color="#D14343" /><span style={{ flex: 1, color: "#3E444C" }}>Fail</span><b style={{ fontFamily: ckMono, color: "#181B20" }}>0</b>
          </div>
        </div>
      </div>
      <div style={{ marginTop: "auto", fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.04em" }}>12.4k spans graded · 24h</div>
    </div>
  );
}

/* Live "Now running" panel — currently executing runs only. */
function NowRunningPanel({ onOpenRun }: { onOpenRun: (run: Run) => void }) {
  const running = D.LIVE_RUNS.filter((r) => r.status === "running");

  // 1s ticker drives the elapsed counters and progress bars on running rows.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <CkCard
      eyebrow="Vercel workflow · live"
      title="Now running"
      action={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: ckMono, fontSize: 10, color: "#3C43E7", letterSpacing: "0.04em", textTransform: "uppercase" }}>
          <span style={{ position: "relative", width: 6, height: 6 }}>
            <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: "#3C43E7" }} />
            <span style={{ position: "absolute", inset: -3, borderRadius: 999, border: "1px solid #3C43E7", animation: "ckPulse 1.6s infinite" }} />
          </span>
          {running.length} executing
        </span>
      }
      pad={0}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {running.map((r, i) => {
          const elapsed = ((r.elapsed ?? 0) + tick).toFixed(1);
          const etaLeft = Math.max(0, (r.etaSec ?? 0) - tick);
          const progress = Math.min(0.99, (r.progress ?? 0) + tick * 0.02);
          return (
            <div key={r.id} onClick={() => onOpenRun(r)} style={{
              padding: "14px 20px",
              borderBottom: i < running.length - 1 ? ckBorder : "none",
              cursor: "pointer", transition: "background 120ms"
            }}
              onMouseEnter={(e) => e.currentTarget.style.background = "#F9FAFB"}
              onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <CkStatusPill status="running" />
                <span style={{ fontFamily: ckBody, fontSize: 14, fontWeight: 600, color: "#181B20" }}>{r.workflowName}</span>
                <CkChip style={{ background: "#F2F4F6", color: "#5F666F" }}>{r.ticket}</CkChip>
                <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10, fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>
                  <span>{elapsed}s</span>
                  <span style={{ color: "#9EA3AA" }}>· ETA {etaLeft}s</span>
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, height: 6, background: "#F2F4F6", borderRadius: 1, position: "relative", overflow: "hidden" }}>
                  <div style={{ width: progress * 100 + "%", height: "100%", background: "#3C43E7", borderRadius: 1, transition: "width 1s linear", position: "relative" }}>
                    <span style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)", animation: "ckShimmer 1.4s infinite" }} />
                  </div>
                </div>
                <span style={{ fontFamily: ckMono, fontSize: 11, color: "#9EA3AA", width: 58, textAlign: "right" }}>{r.spanIndex}/{r.spansTotal}</span>
              </div>
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, fontFamily: ckMono, fontSize: 11 }}>
                <span style={{ width: 8, height: 8, borderRadius: 1, background: spanColor(r.currentSpanKind) }} />
                <span style={{ color: "#181B20", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.currentSpan}</span>
                <span style={{ marginLeft: "auto", color: "#9EA3AA", whiteSpace: "nowrap" }}>{r.model}</span>
              </div>
            </div>
          );
        })}
      </div>
    </CkCard>
  );
}

/* Awaiting input panel — workflows paused on a clarification question. */
function AwaitingInputPanel({ onOpenRun }: { onOpenRun: (run: Run) => void }) {
  const awaiting = D.LIVE_RUNS.filter((r) => r.status === "awaiting");
  return (
    <CkCard
      eyebrow="Human-in-the-loop"
      title="Input needed"
      action={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: ckMono, fontSize: 10, color: "#A2351C", letterSpacing: "0.04em", textTransform: "uppercase" }}>
          <span style={{ position: "relative", width: 6, height: 6 }}>
            <span style={{ position: "absolute", inset: 0, borderRadius: 999, background: "#FD6027" }} />
            <span style={{ position: "absolute", inset: -3, borderRadius: 999, border: "1px solid #FD6027", animation: "ckPulse 1.6s infinite" }} />
          </span>
          {awaiting.length} paused
        </span>
      }
      pad={0}
      style={{ background: "#FFFCFA", borderColor: "#FFE4D6" }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {awaiting.map((r, i) =>
          <div key={r.id} style={{
            padding: "14px 20px",
            borderBottom: i < awaiting.length - 1 ? "1px solid #FFE4D6" : "none"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <CkStatusPill status="awaiting" />
              <span onClick={() => onOpenRun(r)} style={{ fontFamily: ckBody, fontSize: 14, fontWeight: 600, color: "#181B20", cursor: "pointer" }}>{r.workflowName}</span>
              <CkChip style={{ background: "#fff", color: "#5F666F", border: "1px solid #E6E8EB" }}>{r.ticket}</CkChip>
              <CkChip tone="warn">@{r.questionFor}</CkChip>
              <span style={{ marginLeft: "auto", fontFamily: ckMono, fontSize: 11, color: "#9EA3AA", whiteSpace: "nowrap" }}>{r.askedAtMin}m ago</span>
            </div>
            <p style={{ font: '400 13px/1.55 ' + ckBody, color: "#3E444C", margin: "0 0 10px", borderLeft: "2px solid #FD6027", paddingLeft: 12 }}>
              {r.question}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {r.suggestedAnswers && r.suggestedAnswers.map((a, j) =>
                <button key={j} style={{
                  appearance: "none", border: ckBorder, background: "#fff",
                  padding: "5px 10px", borderRadius: 3, cursor: "pointer",
                  fontFamily: ckBody, fontSize: 12, color: "#181B20",
                  transition: "all 120ms"
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#181B20"; e.currentTarget.style.color = "#fff"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.color = "#181B20"; }}>
                  {a}
                </button>
              )}
              <button style={{
                marginLeft: "auto",
                appearance: "none", border: "1px solid #181B20", background: "#181B20", color: "#fff",
                padding: "5px 12px", borderRadius: 3, cursor: "pointer",
                fontFamily: ckMono, fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em"
              }}>Reply →</button>
            </div>
          </div>
        )}
      </div>
    </CkCard>
  );
}

export function OverviewScreen({ onOpenRun }: { onOpenRun: (run: Run) => void }) {
  const { t } = useCockpit();
  const totalRuns = D.WORKFLOWS.reduce((a, w) => a + w.runs24h, 0);
  const totalCost = D.WORKFLOWS.reduce((a, w) => a + w.costToday, 0);
  const totalErrors = D.WORKFLOWS.reduce((a, w) => a + Math.round(w.runs24h * w.errRate), 0);
  const sparkRuns = D.HOURS24.map((h) => h.runs);
  const sparkP95 = D.HOURS24.map((h) => h.p95);
  const sparkErr = D.HOURS24.map((h) => h.errors);

  // Recent runs pagination
  const PAGE_SIZE = 7;
  const [runsPage, setRunsPage] = useState(0);
  const runsTotalPages = Math.max(1, Math.ceil(D.RUNS.length / PAGE_SIZE));
  const runsPageStart = runsPage * PAGE_SIZE;
  const runsPageRows = D.RUNS.slice(runsPageStart, runsPageStart + PAGE_SIZE);

  // Workflows pagination
  const WF_PAGE_SIZE = 5;
  const [wfPage, setWfPage] = useState(0);
  const wfTotalPages = Math.max(1, Math.ceil(D.WORKFLOWS.length / WF_PAGE_SIZE));
  const wfPageStart = wfPage * WF_PAGE_SIZE;
  const wfPageRows = D.WORKFLOWS.slice(wfPageStart, wfPageStart + WF_PAGE_SIZE);

  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Editorial hero (toggle from tweaks) */}
      {t.showEditorialHero &&
        <div style={{ background: "#181B20", color: "#fff", borderRadius: 4, padding: 28, display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 32, position: "relative", overflow: "hidden" }}>
          <svg style={{ position: "absolute", right: -60, top: -60, opacity: 0.07 }} width="320" height="320" viewBox="0 0 320 320">
            {Array.from({ length: 8 }, (_, i) => <circle key={i} cx="160" cy="160" r={16 + i * 18} fill="none" stroke="#fff" strokeWidth="1" />)}
          </svg>
          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontFamily: ckMono, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Tuesday, 26 May · last 24 hours</div>
            <div style={{ font: '500 36px/1.15 ' + ckDisp, letterSpacing: "-0.025em", margin: 0, textWrap: "balance" }}>
              <span style={{ color: "#BBED80" }}>{totalRuns.toLocaleString()}</span> runs shipped <span style={{ color: "#FD6027" }}>147 PRs</span> for <span style={{ fontFamily: ckMono, fontSize: 28 }}>${totalCost.toFixed(0)}</span>.
            </div>
            <div style={{ font: '400 14px/1.55 ' + ckBody, color: "rgba(255,255,255,0.7)", maxWidth: 540 }}>
              All six workflows green. Arthur evals stable at 92.3. One advisory: toxicity flag rate on Release Notes ticked up — under review.
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <CkChip tone="success">All systems operational</CkChip>
              <CkChip style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)" }}>1 advisory open</CkChip>
              <CkChip style={{ background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)" }}>29% of monthly cap</CkChip>
            </div>
          </div>
          <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignContent: "center" }}>
            {[
              { l: "Runs · 24h", v: totalRuns.toLocaleString() },
              { l: "Cost today", v: "$" + totalCost.toFixed(0) },
              { l: "p95 latency", v: "23.1s" },
              { l: "Eval score", v: "92.3" }].
              map((k) =>
                <div key={k.l}>
                  <div style={{ fontFamily: ckMono, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{k.l}</div>
                  <div style={{ font: '500 32px/1 ' + ckDisp, letterSpacing: "-0.02em", marginTop: 4 }}>{k.v}</div>
                </div>
              )}
          </div>
        </div>
      }

      {/* Hero KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <CkKPI label="Runs · 24h" value={totalRuns.toLocaleString()} delta="↗ +12.4% vs 24h ago" deltaTone="good" spark={sparkRuns} sparkColor="#3C43E7" />
        <EvalHealthKPI />
        <CkKPI label="p95 latency" value={"23.1s"} delta="↘ −1.4s vs 24h ago" deltaTone="good" spark={sparkP95} sparkColor="#181B20" />
        <CkKPI label="Errors · 24h" value={totalErrors.toString()} delta="↘ −18% vs 24h ago" deltaTone="good" spark={sparkErr} sparkColor="#D14343" />
      </div>

      {/* Row 2: Now running + Awaiting input, same level */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <NowRunningPanel onOpenRun={onOpenRun} />
        <AwaitingInputPanel onOpenRun={onOpenRun} />
      </div>

      {/* Row 3: Recent runs (full width, proper table) */}
      <CkCard
        eyebrow="Run timeline · last 24h"
        title="Recent runs"
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CkChip tone="success">{D.RUNS.filter((r) => r.status === "success").length} shipped</CkChip>
            <CkChip tone="running">{D.RUNS.filter((r) => r.status === "running").length} running</CkChip>
            <CkChip tone="awaiting">{D.RUNS.filter((r) => r.status === "awaiting").length} awaiting</CkChip>
            <a onClick={() => onOpenRun(D.RUNS[0])} style={{ fontFamily: ckMono, fontSize: 11, color: "#3C43E7", textDecoration: "none", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer", marginLeft: 4 }}>All runs →</a>
          </div>
        }
        pad={0}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: ckBody, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F9FAFB", color: "#5F666F", fontFamily: ckMono, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {["Status", "Ticket · title", "Workflow", "Model", "Started", "Duration", "Cost", "Eval"].map((h, i) =>
                <th key={i} style={{ padding: "10px 16px", textAlign: i >= 4 ? "right" : "left", fontWeight: 500, borderBottom: ckBorder, whiteSpace: "nowrap" }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {runsPageRows.map((r, i) =>
              <tr key={r.id} onClick={() => onOpenRun(r)} style={{ borderBottom: i < runsPageRows.length - 1 ? ckBorder : "none", cursor: "pointer", transition: "background 120ms" }}
                onMouseEnter={(e) => e.currentTarget.style.background = "#F9FAFB"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                <td style={{ padding: "12px 16px" }}><CkStatusPill status={r.status} /></td>
                <td style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontWeight: 600, color: "#181B20", maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{r.ticketTitle}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                      {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
                      <span style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA" }}>{r.actor}</span>
                    </div>
                  </div>
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <CkChip style={{ background: "#F2F4F6", color: "#3E444C" }}>{r.workflowName}</CkChip>
                </td>
                <td style={{ padding: "12px 16px", fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>{r.model}</td>
                <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono, fontSize: 11, color: "#9EA3AA" }}>{r.startedAtMin}m ago</td>
                <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono, fontWeight: 500 }}>{r.duration ? r.duration + "s" : "—"}</td>
                <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono, fontWeight: 500 }}>${r.cost.toFixed(2)}</td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  {r.evalScore ?
                    <span style={{ fontFamily: ckMono, fontSize: 12, color: r.evalScore > 0.9 ? "#3F6B1E" : r.evalScore > 0.85 ? "#7A5A00" : "#A2351C", fontWeight: 600 }}>{(r.evalScore * 100).toFixed(0)}</span> :
                    <span style={{ fontFamily: ckMono, fontSize: 11, color: "#D2D6DA" }}>—</span>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <CkPagination
          page={runsPage}
          totalPages={runsTotalPages}
          total={D.RUNS.length}
          start={runsPageStart}
          shown={runsPageRows.length}
          onChange={setRunsPage} />
      </CkCard>

      {/* Row 4: Workflows (full width, table with sparkline trend) */}
      <CkCard
        eyebrow="Vercel workflow registry"
        title="Workflows"
        action={<a style={{ fontFamily: ckMono, fontSize: 11, color: "#3C43E7", textDecoration: "none", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>+ New workflow</a>}
        pad={0}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: ckBody, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F9FAFB", color: "#5F666F", fontFamily: ckMono, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 500, borderBottom: ckBorder }}>Workflow · latest ticket</th>
              <th style={{ padding: "10px 8px", textAlign: "right", fontWeight: 500, borderBottom: ckBorder }}>Runs 24h</th>
              <th style={{ padding: "10px 8px", textAlign: "right", fontWeight: 500, borderBottom: ckBorder }}>p95</th>
              <th style={{ padding: "10px 8px", textAlign: "right", fontWeight: 500, borderBottom: ckBorder }}>Err</th>
              <th style={{ padding: "10px 8px", textAlign: "right", fontWeight: 500, borderBottom: ckBorder }}>Cost</th>
              <th style={{ padding: "10px 16px", textAlign: "right", fontWeight: 500, borderBottom: ckBorder }}>24h trend</th>
            </tr>
          </thead>
          <tbody>
            {wfPageRows.map((w, i) => {
              const latest = D.RUNS.find((r) => r.workflow === w.id);
              return (
                <tr key={w.id} style={{ borderBottom: i < wfPageRows.length - 1 ? ckBorder : "none", transition: "background 120ms" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#F9FAFB"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontWeight: 600, color: "#181B20" }}>{w.name}</span>
                        {w.primary && <CkChip tone="mariner">primary</CkChip>}
                        <span style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA" }}>· {w.gateway}</span>
                      </div>
                      {latest ?
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#5F666F" }}>
                          <TicketLink ticket={latest.ticket} url={latest.ticketUrl} />
                          <span style={{ color: "#181B20", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 560 }}>{latest.ticketTitle}</span>
                          {latest.prNumber && latest.prUrl && <PRLink num={latest.prNumber} url={latest.prUrl} />}
                        </div> :

                        <div style={{ fontSize: 11, color: "#9EA3AA" }}>No recent tickets</div>
                      }
                    </div>
                  </td>
                  <td style={{ padding: "12px 8px", textAlign: "right", fontFamily: ckMono, fontWeight: 500 }}>{w.runs24h.toLocaleString()}</td>
                  <td style={{ padding: "12px 8px", textAlign: "right", fontFamily: ckMono, color: "#5F666F" }}>{w.p95}s</td>
                  <td style={{ padding: "12px 8px", textAlign: "right", fontFamily: ckMono, color: w.errRate > 0.02 ? "#A2351C" : "#5F666F" }}>{(w.errRate * 100).toFixed(2)}%</td>
                  <td style={{ padding: "12px 8px", textAlign: "right", fontFamily: ckMono, fontWeight: 500 }}>${w.costToday.toFixed(2)}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    <div style={{ display: "inline-block" }}>
                      <Spark data={Array.from({ length: 18 }, (_, j) => 0.4 + Math.sin(j * 0.5 + i) * 0.3 + Math.random() * 0.4)} w={120} h={24} stroke="#3C43E7" fill="#3C43E7" />
                    </div>
                  </td>
                </tr>);

            })}
          </tbody>
        </table>
        <CkPagination
          page={wfPage}
          totalPages={wfTotalPages}
          total={D.WORKFLOWS.length}
          start={wfPageStart}
          shown={wfPageRows.length}
          onChange={setWfPage} />
      </CkCard>
    </div>
  );
}
