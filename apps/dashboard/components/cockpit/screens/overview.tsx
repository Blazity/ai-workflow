"use client";

import React, { useState } from "react";
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
import { spanColor } from "@/lib/theme";
import { useCockpit } from "@/components/cockpit/context";
import type { Run } from "@/lib/types";
import type {
  KpisResponse,
  EvalHealthResponse,
  LiveRunsResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";

/** Bundle of the five server-fetched responses passed into the presentational Overview. */
export interface OverviewScreenData {
  kpis: KpisResponse;
  evalHealth: EvalHealthResponse;
  liveRuns: LiveRunsResponse;
  recentRuns: RunsResponse;
  workflows: WorkflowsResponse;
}

/* Eval health KPI — fits the hero KPI strip but shows a mini-donut + breakdown. */
function EvalHealthKPI({ data }: { data: EvalHealthResponse | undefined }) {
  if (data?.available === true) {
    const total = data.pass + data.warn + data.fail || 1;
    return (
      <div className="bg-panel border border-neutral-200 rounded-sm px-[18px] py-4 flex flex-col gap-1.5 min-h-[124px]">
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">
            Eval health
          </div>
          <button
            type="button"
            className="appearance-none border-0 bg-transparent p-0 font-mono text-[10px] text-mariner tracking-[0.04em] uppercase cursor-pointer"
          >
            Detail →
          </button>
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <Donut
            shares={[data.pass / total, data.warn / total, data.fail / total]}
            colors={["#5BB04A", "#FFC800", "#D14343"]}
            size={64}
            thickness={10}
            centerLabel={data.score.toFixed(1)}
          />
          <div className="flex-1 flex flex-col gap-[3px]">
            <div className="flex items-center gap-1.5 font-body text-xs">
              <CkDot color="#5BB04A" />
              <span className="flex-1 text-neutral-800">Pass</span>
              <b className="font-mono text-neutral-900">{data.pass}</b>
            </div>
            <div className="flex items-center gap-1.5 font-body text-xs">
              <CkDot color="#FFC800" />
              <span className="flex-1 text-neutral-800">Warn</span>
              <b className="font-mono text-neutral-900">{data.warn}</b>
            </div>
            <div className="flex items-center gap-1.5 font-body text-xs">
              <CkDot color="#D14343" />
              <span className="flex-1 text-neutral-800">Fail</span>
              <b className="font-mono text-neutral-900">{data.fail}</b>
            </div>
          </div>
        </div>
        <div className="mt-auto font-mono text-[10px] text-neutral-500 tracking-[0.04em]">
          {data.spansGraded.toLocaleString("en-US")} spans graded · {data.windowHours}h
        </div>
      </div>
    );
  }

  const reason = data?.available === false ? data.reason : "Loading…";

  return (
    <div className="bg-panel border border-neutral-200 rounded-sm px-[18px] py-4 flex flex-col gap-1.5 min-h-[124px]">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">
          Eval health
        </div>
      </div>
      <div className="flex items-center gap-3 mt-0.5">
        <Donut
          shares={[1, 0, 0]}
          colors={["#E6E8EB", "#E6E8EB", "#E6E8EB"]}
          size={64}
          thickness={10}
          centerLabel="—"
        />
        <div className="flex-1 font-body text-xs text-neutral-500 leading-snug">
          {reason}
        </div>
      </div>
      <div className="mt-auto font-mono text-[10px] text-neutral-500 tracking-[0.04em]">
        —
      </div>
    </div>
  );
}

/* Live "Now running" panel — currently executing runs only. */
function NowRunningPanel({
  rows,
  onOpenRun,
}: {
  rows: Run[];
  onOpenRun: (run: Run) => void;
}) {
  const running = rows.filter((r) => r.status === "running");

  return (
    <CkCard
      eyebrow="Vercel workflow · live"
      title="Now running"
      action={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-mariner tracking-[0.04em] uppercase">
          <span className="relative w-1.5 h-1.5">
            <span className="absolute inset-0 rounded-full bg-mariner" />
            <span className="absolute -inset-[3px] rounded-full border border-mariner animate-ck-pulse" />
          </span>
          {running.length} executing
        </span>
      }
      pad={0}
    >
      {running.length === 0 ? (
        <div className="px-5 py-8 text-center text-neutral-500 text-sm">No runs in flight</div>
      ) : (
        <div className="flex flex-col">
          {running.map((r, i) => {
            return (
              <div
                key={r.id}
                onClick={() => onOpenRun(r)}
                className={`px-5 py-[14px] cursor-pointer transition-colors duration-100 hover:bg-off-white ${i < running.length - 1 ? "border-b border-neutral-200" : ""}`}
              >
                <div className="flex items-center gap-2.5 mb-2 flex-wrap">
                  <CkStatusPill status="running" />
                  <span className="font-body text-sm font-semibold text-neutral-900">
                    {r.workflowName}
                  </span>
                  {r.ticket && r.ticketUrl ? (
                    <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                  ) : null}
                  <span className="ml-auto inline-flex items-center gap-2.5 font-mono text-[11px] text-neutral-700">
                    {r.elapsed != null && <span>{(r.elapsed ?? 0).toFixed(1)}s</span>}
                    {r.etaSec != null && <span className="text-neutral-500">· ETA {r.etaSec}s</span>}
                  </span>
                </div>
                {r.currentSpan && (
                  <>
                    <div className="flex items-center gap-2.5">
                      <div className="flex-1 h-1.5 bg-app-bg rounded-[1px] relative overflow-hidden">
                        <div
                          className="h-full bg-mariner rounded-[1px] transition-[width] duration-1000 ease-linear relative"
                          style={{ width: (r.progress ?? 0) * 100 + "%" }}
                        >
                          <span
                            className="absolute inset-0 animate-ck-shimmer"
                            style={{
                              background:
                                "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
                            }}
                          />
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-neutral-500 w-[58px] text-right">
                        {r.spanIndex ?? "—"}/{r.spansTotal ?? "—"}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px]">
                      <span
                        className="w-2 h-2 rounded-[1px]"
                        style={{ background: spanColor(r.currentSpanKind) }}
                      />
                      <span className="text-neutral-900 font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                        {r.currentSpan}
                      </span>
                      <span className="ml-auto text-neutral-500 whitespace-nowrap">
                        {r.model}
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CkCard>
  );
}

/* Awaiting input panel — workflows paused on a clarification question. */
function AwaitingInputPanel({
  rows,
  onOpenRun,
}: {
  rows: Run[];
  onOpenRun: (run: Run) => void;
}) {
  const awaiting = rows.filter((r) => r.status === "awaiting");
  return (
    <CkCard
      eyebrow="Human-in-the-loop"
      title="Input needed"
      action={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-[#A2351C] tracking-[0.04em] uppercase">
          <span className="relative w-1.5 h-1.5">
            <span className="absolute inset-0 rounded-full bg-burnt-orange" />
            <span className="absolute -inset-[3px] rounded-full border border-burnt-orange animate-ck-pulse" />
          </span>
          {awaiting.length} paused
        </span>
      }
      pad={0}
      style={{ background: "#FFFCFA", borderColor: "#FFE4D6" }}
    >
      {awaiting.length === 0 ? (
        <div className="px-5 py-8 text-center text-neutral-500 text-sm">No clarifications pending</div>
      ) : (
        <div className="flex flex-col">
          {awaiting.map((r, i) => (
            <div
              key={r.id}
              className={`px-5 py-[14px] ${i < awaiting.length - 1 ? "border-b border-[#FFE4D6]" : ""}`}
            >
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <CkStatusPill status="awaiting" />
                <span
                  onClick={() => onOpenRun(r)}
                  className="font-body text-sm font-semibold text-neutral-900 cursor-pointer"
                >
                  {r.workflowName}
                </span>
                {r.ticket && r.ticketUrl ? (
                  <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                ) : null}
                {r.questionFor && <CkChip tone="warn">@{r.questionFor}</CkChip>}
                {typeof r.askedAtMin === "number" && (
                  <span className="ml-auto font-mono text-[11px] text-neutral-500 whitespace-nowrap">
                    {r.askedAtMin}m ago
                  </span>
                )}
              </div>
              {r.question && (
                <p className="font-body font-normal text-[13px] leading-[1.55] text-neutral-800 m-0 mb-2.5 border-l-2 border-burnt-orange pl-3">
                  {r.question}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5 items-center">
                {r.suggestedAnswers?.map((a, j) => (
                  <button
                    key={j}
                    className="appearance-none border border-neutral-200 bg-panel px-2.5 py-[5px] rounded-[3px] cursor-pointer font-body text-xs text-neutral-900 transition-all duration-100 hover:bg-coal hover:text-white"
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </CkCard>
  );
}

export function OverviewScreen({ data }: { data: OverviewScreenData }) {
  const { t, openRun } = useCockpit();

  const PAGE_SIZE = 7;
  const [runsPage, setRunsPage] = useState(0);
  const WF_PAGE_SIZE = 5;
  const [wfPage, setWfPage] = useState(0);

  const liveRows = data.liveRuns.rows;
  const recentData = data.recentRuns;
  const wfData = data.workflows;

  // Client-side pagination over the rows fetched once on the server (no refetch).
  const recentRows = recentData.rows.slice(
    runsPage * PAGE_SIZE,
    runsPage * PAGE_SIZE + PAGE_SIZE,
  );
  const runsTotalPages = Math.max(
    1,
    Math.ceil(recentData.rows.length / PAGE_SIZE),
  );
  const wfRows = wfData.rows.slice(
    wfPage * WF_PAGE_SIZE,
    wfPage * WF_PAGE_SIZE + WF_PAGE_SIZE,
  );
  const wfTotalPages = Math.max(
    1,
    Math.ceil(wfData.rows.length / WF_PAGE_SIZE),
  );

  const heroRuns = data.kpis.runs24h;
  const heroCost = data.kpis.cost24h;
  const heroP95 = data.kpis.p95;
  const heroErrors = data.kpis.errors24h;
  const evalData = data.evalHealth;
  const heroEval: Extract<EvalHealthResponse, { available: true }> | null =
    evalData.available === true ? evalData : null;

  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-5">
      {/* Editorial hero — chrome preserved; data cells degrade to N/A */}
      {t.showEditorialHero && (
        <div className="bg-coal text-white rounded-sm p-7 grid grid-cols-[1.5fr_1fr] gap-8 relative overflow-hidden">
          <svg
            className="absolute -right-[60px] -top-[60px] opacity-[0.07]"
            width="320"
            height="320"
            viewBox="0 0 320 320"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <circle
                key={i}
                cx="160"
                cy="160"
                r={16 + i * 18}
                fill="none"
                stroke="#fff"
                strokeWidth="1"
              />
            ))}
          </svg>
          <div className="relative z-[1] flex flex-col gap-3">
            <div className="font-mono text-[10px] text-white/50 tracking-[0.08em] uppercase">
              Last 24 hours
            </div>
            <div className="font-display font-medium text-[36px] leading-[1.15] tracking-[-0.025em] m-0 text-balance">
              Overview · {data.kpis.generatedAt ? new Date(data.kpis.generatedAt).toLocaleTimeString() : "—"}
            </div>
            <div className="font-body font-normal text-sm leading-[1.55] text-white/70 max-w-[540px]">
              Historical aggregates are not wired up yet. The Now-running and Workflows panels reflect the worker's live state.
            </div>
          </div>
          <div className="relative z-1 grid grid-cols-2 gap-4 content-center">
            {[
              { l: "Runs · 24h", v: heroRuns ? heroRuns.value.toLocaleString("en-US") : "N/A" },
              { l: "Cost today", v: heroCost ? "$" + heroCost.value.toFixed(0) : "N/A" },
              { l: "p95 latency", v: heroP95 ? heroP95.valueSec + "s" : "N/A" },
              { l: "Eval score", v: heroEval ? heroEval.score.toFixed(1) : "N/A" },
            ].map((k) => (
              <div key={k.l}>
                <div className="font-mono text-[10px] text-white/50 tracking-[0.06em] uppercase">
                  {k.l}
                </div>
                <div className="font-display font-medium text-[32px] leading-none tracking-[-0.02em] mt-1">
                  {k.v}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hero KPIs */}
      <div className="grid grid-cols-4 gap-3">
        <CkKPI
          label="Runs · 24h"
          value={heroRuns ? heroRuns.value.toLocaleString("en-US") : ""}
          delta={
            heroRuns
              ? `${heroRuns.deltaPct >= 0 ? "↗" : "↘"} ${Math.abs(heroRuns.deltaPct).toFixed(1)}% vs 24h ago`
              : ""
          }
          deltaTone={heroRuns && heroRuns.deltaPct >= 0 ? "good" : "bad"}
          spark={heroRuns?.spark ?? []}
          sparkColor="#3C43E7"
          disabled={!heroRuns}
        />
        <EvalHealthKPI data={data.evalHealth} />
        <CkKPI
          label="p95 latency"
          value={heroP95 ? heroP95.valueSec + "s" : ""}
          delta={
            heroP95
              ? `${heroP95.deltaSec >= 0 ? "↗" : "↘"} ${Math.abs(heroP95.deltaSec).toFixed(1)}s vs 24h ago`
              : ""
          }
          deltaTone={heroP95 && heroP95.deltaSec <= 0 ? "good" : "bad"}
          spark={heroP95?.spark ?? []}
          sparkColor="#181B20"
          disabled={!heroP95}
        />
        <CkKPI
          label="Errors · 24h"
          value={heroErrors ? heroErrors.value.toString() : ""}
          delta={
            heroErrors
              ? `${heroErrors.deltaPct >= 0 ? "↗" : "↘"} ${Math.abs(heroErrors.deltaPct).toFixed(1)}% vs 24h ago`
              : ""
          }
          deltaTone={heroErrors && heroErrors.deltaPct <= 0 ? "good" : "bad"}
          spark={heroErrors?.spark ?? []}
          sparkColor="#D14343"
          disabled={!heroErrors}
        />
      </div>

      {/* Live row */}
      <div className="grid grid-cols-2 gap-3">
        <NowRunningPanel rows={liveRows} onOpenRun={openRun} />
        <AwaitingInputPanel rows={liveRows} onOpenRun={openRun} />
      </div>

      {/* Recent runs */}
      <CkCard
        eyebrow="Run timeline · last 24h"
        title="Recent runs"
        action={
          recentData.available ? (
            <div className="flex items-center gap-2">
              <CkChip tone="success">{recentData.counts.success} shipped</CkChip>
              <CkChip tone="running">{recentData.counts.running} running</CkChip>
              <CkChip tone="awaiting">{recentData.counts.awaiting} awaiting</CkChip>
            </div>
          ) : null
        }
        pad={0}
      >
        {recentData.available === false ? (
          <div className="px-5 py-10 text-center text-neutral-500 text-sm">
            Run history coming soon
          </div>
        ) : (
          <>
            <table className="w-full border-collapse font-body text-[13px]">
              <thead>
                <tr className="bg-off-white text-neutral-700 font-mono text-[10px] tracking-[0.06em] uppercase">
                  {[
                    "Status",
                    "Ticket · title",
                    "Workflow",
                    "Model",
                    "Started",
                    "Duration",
                    "Cost",
                    "Eval",
                  ].map((h, i) => (
                    <th
                      key={i}
                      className={`px-4 py-2.5 font-medium border-b border-neutral-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentRows.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => openRun(r)}
                    className={`cursor-pointer transition-colors duration-100 hover:bg-off-white ${i < recentRows.length - 1 ? "border-b border-neutral-200" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <CkStatusPill status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-semibold text-neutral-900 max-w-[480px] overflow-hidden text-ellipsis whitespace-nowrap block">
                          {r.ticketTitle}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {r.ticket && r.ticketUrl && (
                            <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                          )}
                          {r.prNumber && r.prUrl && (
                            <PRLink num={r.prNumber} url={r.prUrl} />
                          )}
                          <span className="font-mono text-[10px] text-neutral-500">
                            {r.actor}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <CkChip style={{ background: "#F2F4F6", color: "#3E444C" }}>
                        {r.workflowName}
                      </CkChip>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-neutral-700">
                      {r.model}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[11px] text-neutral-500">
                      {r.startedAtMin}m ago
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      {r.duration === null ? "—" : `${r.duration}s`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      {r.cost === null ? "—" : `$${r.cost.toFixed(2)}`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.evalScore === null ? (
                        <span className="font-mono text-[11px] text-[#D2D6DA]">
                          —
                        </span>
                      ) : (
                        <span
                          className="font-mono text-xs font-semibold"
                          style={{
                            color:
                              r.evalScore > 0.9
                                ? "#3F6B1E"
                                : r.evalScore > 0.85
                                  ? "#7A5A00"
                                  : "#A2351C",
                          }}
                        >
                          {(r.evalScore * 100).toFixed(0)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <CkPagination
              page={runsPage}
              totalPages={runsTotalPages}
              total={recentData.rows.length}
              start={runsPage * PAGE_SIZE}
              shown={recentRows.length}
              onChange={setRunsPage}
            />
          </>
        )}
      </CkCard>

      {/* Workflows */}
      <CkCard
        eyebrow="Vercel workflow registry"
        title="Workflows"
        action={null}
        pad={0}
      >
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-off-white text-neutral-700 font-mono text-[10px] tracking-[0.06em] uppercase">
              <th className="px-4 py-2.5 text-left font-medium border-b border-neutral-200">
                Workflow · latest ticket
              </th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">Runs 24h</th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">p95</th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">Err</th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">Cost</th>
              <th className="px-4 py-2.5 text-right font-medium border-b border-neutral-200">24h trend</th>
            </tr>
          </thead>
          <tbody>
            {wfRows.map((w, i) => {
              const latest = w.latestRun;
              return (
                <tr
                  key={w.id}
                  className={`transition-colors duration-100 hover:bg-off-white ${i < wfRows.length - 1 ? "border-b border-neutral-200" : ""}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900">{w.name}</span>
                        {w.primary && <CkChip tone="mariner">primary</CkChip>}
                        <span className="font-mono text-[10px] text-neutral-500">· {w.gateway}</span>
                      </div>
                      {latest ? (
                        <div className="flex items-center gap-2 text-xs text-neutral-700">
                          {latest.ticket && latest.ticketUrl && (
                            <TicketLink ticket={latest.ticket} url={latest.ticketUrl} />
                          )}
                          <span className="text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap max-w-[560px]">
                            {latest.ticketTitle}
                          </span>
                          {latest.prNumber && latest.prUrl && (
                            <PRLink num={latest.prNumber} url={latest.prUrl} />
                          )}
                        </div>
                      ) : (
                        <div className="text-[11px] text-neutral-500">No recent tickets</div>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 text-right font-mono font-medium">
                    {w.runs24h === null ? "—" : w.runs24h.toLocaleString("en-US")}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-neutral-700">
                    {w.p95 === null ? "—" : `${w.p95}s`}
                  </td>
                  <td
                    className={`px-2 py-3 text-right font-mono ${w.errRate !== null && w.errRate > 0.02 ? "text-[#A2351C]" : "text-neutral-700"}`}
                  >
                    {w.errRate === null ? "—" : `${(w.errRate * 100).toFixed(2)}%`}
                  </td>
                  <td className="px-2 py-3 text-right font-mono font-medium">
                    {w.costToday === null ? "—" : `$${w.costToday.toFixed(2)}`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {w.trend24h && w.trend24h.length > 0 ? (
                      <div className="inline-block">
                        <Spark data={w.trend24h} w={120} h={24} stroke="#3C43E7" fill="#3C43E7" />
                      </div>
                    ) : (
                      <div className="inline-block w-[120px] h-[24px] bg-app-bg rounded-[1px]" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <CkPagination
          page={wfPage}
          totalPages={wfTotalPages}
          total={wfData.rows.length}
          start={wfPage * WF_PAGE_SIZE}
          shown={wfRows.length}
          onChange={setWfPage}
        />
      </CkCard>
    </div>
  );
}
