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
import { spanColor } from "@/lib/theme";
import { AIWF_DATA } from "@/lib/data/mock";
import { sparkSeries } from "@/lib/rng";
import { useCockpit } from "@/components/cockpit/context";
import type { Run } from "@/lib/types";

const D = AIWF_DATA;

/* Eval health KPI — fits the hero KPI strip but shows a mini-donut + breakdown. */
function EvalHealthKPI() {
  return (
    <div className="bg-panel border border-neutral-200 rounded-sm px-[18px] py-4 flex flex-col gap-1.5 min-h-[124px]">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">
          Eval health
        </div>
        <a className="font-mono text-[10px] text-mariner no-underline tracking-[0.04em] uppercase cursor-pointer">
          Detail →
        </a>
      </div>
      <div className="flex items-center gap-3 mt-0.5">
        <Donut
          shares={[0.78, 0.14, 0.08]}
          colors={["#5BB04A", "#FFC800", "#D14343"]}
          size={64}
          thickness={10}
          centerLabel="92.3"
        />
        <div className="flex-1 flex flex-col gap-[3px]">
          <div className="flex items-center gap-1.5 font-body text-xs">
            <CkDot color="#5BB04A" />
            <span className="flex-1 text-neutral-800">Pass</span>
            <b className="font-mono text-neutral-900">7</b>
          </div>
          <div className="flex items-center gap-1.5 font-body text-xs">
            <CkDot color="#FFC800" />
            <span className="flex-1 text-neutral-800">Warn</span>
            <b className="font-mono text-neutral-900">2</b>
          </div>
          <div className="flex items-center gap-1.5 font-body text-xs">
            <CkDot color="#D14343" />
            <span className="flex-1 text-neutral-800">Fail</span>
            <b className="font-mono text-neutral-900">0</b>
          </div>
        </div>
      </div>
      <div className="mt-auto font-mono text-[10px] text-neutral-500 tracking-[0.04em]">
        12.4k spans graded · 24h
      </div>
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
      <div className="flex flex-col">
        {running.map((r, i) => {
          const elapsed = ((r.elapsed ?? 0) + tick).toFixed(1);
          const etaLeft = Math.max(0, (r.etaSec ?? 0) - tick);
          const progress = Math.min(0.99, (r.progress ?? 0) + tick * 0.02);
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
                <CkChip tone="blocked">{r.ticket}</CkChip>
                <span className="ml-auto inline-flex items-center gap-2.5 font-mono text-[11px] text-neutral-700">
                  <span>{elapsed}s</span>
                  <span className="text-neutral-500">· ETA {etaLeft}s</span>
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="flex-1 h-1.5 bg-app-bg rounded-[1px] relative overflow-hidden">
                  <div
                    className="h-full bg-mariner rounded-[1px] transition-[width] duration-1000 ease-linear relative"
                    style={{ width: progress * 100 + "%" }}
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
                  {r.spanIndex}/{r.spansTotal}
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
              <CkChip
                style={{
                  background: "#fff",
                  color: "#5F666F",
                  border: "1px solid #E6E8EB",
                }}
              >
                {r.ticket}
              </CkChip>
              <CkChip tone="warn">@{r.questionFor}</CkChip>
              <span className="ml-auto font-mono text-[11px] text-neutral-500 whitespace-nowrap">
                {r.askedAtMin}m ago
              </span>
            </div>
            <p className="font-body font-normal text-[13px] leading-[1.55] text-neutral-800 m-0 mb-2.5 border-l-2 border-burnt-orange pl-3">
              {r.question}
            </p>
            <div className="flex flex-wrap gap-1.5 items-center">
              {r.suggestedAnswers &&
                r.suggestedAnswers.map((a, j) => (
                  <button
                    key={j}
                    className="appearance-none border border-neutral-200 bg-panel px-2.5 py-[5px] rounded-[3px] cursor-pointer font-body text-xs text-neutral-900 transition-all duration-100 hover:bg-coal hover:text-white"
                  >
                    {a}
                  </button>
                ))}
              <button className="ml-auto appearance-none border border-coal bg-coal text-white px-3 py-[5px] rounded-[3px] cursor-pointer font-mono text-[11px] font-medium uppercase tracking-[0.04em]">
                Reply →
              </button>
            </div>
          </div>
        ))}
      </div>
    </CkCard>
  );
}

export function OverviewScreen({
  onOpenRun,
}: {
  onOpenRun: (run: Run) => void;
}) {
  const { t } = useCockpit();
  const totalRuns = D.WORKFLOWS.reduce((a, w) => a + w.runs24h, 0);
  const totalCost = D.WORKFLOWS.reduce((a, w) => a + w.costToday, 0);
  const totalErrors = D.WORKFLOWS.reduce(
    (a, w) => a + Math.round(w.runs24h * w.errRate),
    0,
  );
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
  const wfTotalPages = Math.max(
    1,
    Math.ceil(D.WORKFLOWS.length / WF_PAGE_SIZE),
  );
  const wfPageStart = wfPage * WF_PAGE_SIZE;
  const wfPageRows = D.WORKFLOWS.slice(wfPageStart, wfPageStart + WF_PAGE_SIZE);

  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-5">
      {/* Editorial hero (toggle from tweaks) */}
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
              Tuesday, 26 May · last 24 hours
            </div>
            <div className="font-display font-medium text-[36px] leading-[1.15] tracking-[-0.025em] m-0 text-balance">
              <span className="text-sulu">{totalRuns.toLocaleString("en-US")}</span>{" "}
              runs shipped <span className="text-burnt-orange">147 PRs</span>{" "}
              for{" "}
              <span className="font-mono text-[28px]">
                ${totalCost.toFixed(0)}
              </span>
              .
            </div>
            <div className="font-body font-normal text-sm leading-[1.55] text-white/70 max-w-[540px]">
              All six workflows green. Arthur evals stable at 92.3. One
              advisory: toxicity flag rate on Release Notes ticked up — under
              review.
            </div>
            <div className="flex gap-1.5 mt-1">
              <CkChip tone="success">All systems operational</CkChip>
              <CkChip
                style={{
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.2)",
                }}
              >
                1 advisory open
              </CkChip>
              <CkChip
                style={{
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.2)",
                }}
              >
                29% of monthly cap
              </CkChip>
            </div>
          </div>
          <div className="relative z-1 grid grid-cols-2 gap-4 content-center">
            {[
              { l: "Runs · 24h", v: totalRuns.toLocaleString("en-US") },
              { l: "Cost today", v: "$" + totalCost.toFixed(0) },
              { l: "p95 latency", v: "23.1s" },
              { l: "Eval score", v: "92.3" },
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
          value={totalRuns.toLocaleString("en-US")}
          delta="↗ +12.4% vs 24h ago"
          deltaTone="good"
          spark={sparkRuns}
          sparkColor="#3C43E7"
        />
        <EvalHealthKPI />
        <CkKPI
          label="p95 latency"
          value={"23.1s"}
          delta="↘ −1.4s vs 24h ago"
          deltaTone="good"
          spark={sparkP95}
          sparkColor="#181B20"
        />
        <CkKPI
          label="Errors · 24h"
          value={totalErrors.toString()}
          delta="↘ −18% vs 24h ago"
          deltaTone="good"
          spark={sparkErr}
          sparkColor="#D14343"
        />
      </div>

      {/* Row 2: Now running + Awaiting input, same level */}
      <div className="grid grid-cols-2 gap-3">
        <NowRunningPanel onOpenRun={onOpenRun} />
        <AwaitingInputPanel onOpenRun={onOpenRun} />
      </div>

      {/* Row 3: Recent runs (full width, proper table) */}
      <CkCard
        eyebrow="Run timeline · last 24h"
        title="Recent runs"
        action={
          <div className="flex items-center gap-2">
            <CkChip tone="success">
              {D.RUNS.filter((r) => r.status === "success").length} shipped
            </CkChip>
            <CkChip tone="running">
              {D.RUNS.filter((r) => r.status === "running").length} running
            </CkChip>
            <CkChip tone="awaiting">
              {D.RUNS.filter((r) => r.status === "awaiting").length} awaiting
            </CkChip>
            <a
              onClick={() => onOpenRun(D.RUNS[0])}
              className="font-mono text-[11px] text-mariner no-underline uppercase tracking-[0.04em] cursor-pointer ml-1"
            >
              All runs →
            </a>
          </div>
        }
        pad={0}
      >
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
            {runsPageRows.map((r, i) => (
              <tr
                key={r.id}
                onClick={() => onOpenRun(r)}
                className={`cursor-pointer transition-colors duration-100 hover:bg-off-white ${i < runsPageRows.length - 1 ? "border-b border-neutral-200" : ""}`}
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
                      <TicketLink ticket={r.ticket} url={r.ticketUrl} />
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
                  {r.duration ? r.duration + "s" : "—"}
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium">
                  ${r.cost.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.evalScore ? (
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
                  ) : (
                    <span className="font-mono text-[11px] text-[#D2D6DA]">
                      —
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
          total={D.RUNS.length}
          start={runsPageStart}
          shown={runsPageRows.length}
          onChange={setRunsPage}
        />
      </CkCard>

      {/* Row 4: Workflows (full width, table with sparkline trend) */}
      <CkCard
        eyebrow="Vercel workflow registry"
        title="Workflows"
        action={
          <a className="font-mono text-[11px] text-mariner no-underline uppercase tracking-[0.04em] cursor-pointer">
            + New workflow
          </a>
        }
        pad={0}
      >
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-off-white text-neutral-700 font-mono text-[10px] tracking-[0.06em] uppercase">
              <th className="px-4 py-2.5 text-left font-medium border-b border-neutral-200">
                Workflow · latest ticket
              </th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">
                Runs 24h
              </th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">
                p95
              </th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">
                Err
              </th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">
                Cost
              </th>
              <th className="px-4 py-2.5 text-right font-medium border-b border-neutral-200">
                24h trend
              </th>
            </tr>
          </thead>
          <tbody>
            {wfPageRows.map((w, i) => {
              const latest = D.RUNS.find((r) => r.workflow === w.id);
              return (
                <tr
                  key={w.id}
                  className={`transition-colors duration-100 hover:bg-off-white ${i < wfPageRows.length - 1 ? "border-b border-neutral-200" : ""}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900">
                          {w.name}
                        </span>
                        {w.primary && <CkChip tone="mariner">primary</CkChip>}
                        <span className="font-mono text-[10px] text-neutral-500">
                          · {w.gateway}
                        </span>
                      </div>
                      {latest ? (
                        <div className="flex items-center gap-2 text-xs text-neutral-700">
                          <TicketLink
                            ticket={latest.ticket}
                            url={latest.ticketUrl}
                          />
                          <span className="text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap max-w-[560px]">
                            {latest.ticketTitle}
                          </span>
                          {latest.prNumber && latest.prUrl && (
                            <PRLink num={latest.prNumber} url={latest.prUrl} />
                          )}
                        </div>
                      ) : (
                        <div className="text-[11px] text-neutral-500">
                          No recent tickets
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 text-right font-mono font-medium">
                    {w.runs24h.toLocaleString("en-US")}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-neutral-700">
                    {w.p95}s
                  </td>
                  <td
                    className={`px-2 py-3 text-right font-mono ${w.errRate > 0.02 ? "text-[#A2351C]" : "text-neutral-700"}`}
                  >
                    {(w.errRate * 100).toFixed(2)}%
                  </td>
                  <td className="px-2 py-3 text-right font-mono font-medium">
                    ${w.costToday.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-block">
                      <Spark
                        data={sparkSeries(i + 1, 18, 0.4, 0.7)}
                        w={120}
                        h={24}
                        stroke="#3C43E7"
                        fill="#3C43E7"
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <CkPagination
          page={wfPage}
          totalPages={wfTotalPages}
          total={D.WORKFLOWS.length}
          start={wfPageStart}
          shown={wfPageRows.length}
          onChange={setWfPage}
        />
      </CkCard>
    </div>
  );
}
