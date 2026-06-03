"use client";

import React from "react";
import { useRouter } from "next/navigation";

import { CkCard, CkKPI, CkChip, CkStatusPill } from "@/components/ui";
import type { RunDetailResponse, RunStep, StepStatus } from "@shared/contracts";

/* ───────────────────── RUN TRACE ───────────────────── */

const STEP_COLOR: Record<StepStatus, string> = {
  completed: "#5BB04A",
  running: "#3C43E7",
  pending: "#9EA3AA",
  failed: "#D14343",
  cancelled: "#7A8089",
};

const STEP_LABEL: Record<StepStatus, string> = {
  completed: "ok",
  running: "running",
  pending: "pending",
  failed: "failed",
  cancelled: "cancelled",
};

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  // Locale-stable, second precision — avoids hydration drift from toLocaleString.
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function TraceScreen({
  runId,
  data,
}: {
  runId: string;
  data: RunDetailResponse;
}) {
  const router = useRouter();
  const { run, steps } = data;

  const [selectedId, setSelectedId] = React.useState<string | null>(
    steps[0]?.stepId ?? null,
  );
  const selected =
    steps.find((s) => s.stepId === selectedId) ?? steps[0] ?? null;

  const onBack = () => router.push("/runs");

  if (!data.available || !run) {
    return (
      <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
        <Breadcrumb runId={runId} onBack={onBack} />
        <CkCard eyebrow="Run trace" title="Run unavailable">
          <div className="py-6 text-center text-neutral-500 font-body text-[13px]">
            No trace data for <span className="font-mono">{runId}</span>. The run
            may have expired, or the workflow runtime is unavailable.
          </div>
        </CkCard>
      </div>
    );
  }

  // Wall-clock offset of "now" from the run start, used to size bars for steps
  // that are still running (no completedAt yet).
  const runStartMs = Date.parse(run.startedAt ?? run.createdAt);
  const nowOffsetMs = Math.max(0, Date.parse(data.generatedAt) - runStartMs);
  const barMs = (s: RunStep): number =>
    s.durationMs ?? Math.max(0, nowOffsetMs - s.startOffsetMs);
  const total = Math.max(
    1,
    nowOffsetMs,
    ...steps.map((s) => s.startOffsetMs + barMs(s)),
  );

  const completed = steps.filter((s) => s.status === "completed").length;
  const failedSteps = steps.filter((s) => s.status === "failed").length;
  const retries = steps.reduce((n, s) => n + Math.max(0, s.attempt - 1), 0);

  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      <Breadcrumb runId={run.id} onBack={onBack} />

      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <CkStatusPill status={run.status} />
            <CkChip tone="mariner">{run.workflowName}</CkChip>
            <span className="font-mono text-[11px] text-neutral-700">
              {[run.ticket, run.model].filter(Boolean).join(" · ")}
            </span>
          </div>
          <h2 className="font-display font-medium text-2xl leading-[1.2] m-0 text-neutral-900">
            {run.ticketTitle || run.id}
          </h2>
        </div>
        {run.ticketUrl && (
          <a
            href={run.ticketUrl}
            target="_blank"
            rel="noreferrer"
            className="appearance-none border border-neutral-200 bg-panel px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer no-underline"
          >
            Open ticket ↗
          </a>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2">
        <CkKPI
          label="Duration"
          value={run.durationSec === null ? "—" : `${run.durationSec}s`}
          sub={run.status === "running" ? "in progress" : "elapsed"}
        />
        <CkKPI label="Steps" value={steps.length} sub={`${completed} completed`} />
        <CkKPI label="Retries" value={retries} sub="step re-attempts" />
        <CkKPI label="Failed" value={failedSteps} sub="failed steps" />
      </div>

      {run.error && (
        <CkCard eyebrow="Workflow error" title={run.error.code ?? "Run failed"}>
          <div className="font-mono text-xs text-fail-fg break-all">
            {run.error.message}
          </div>
          {run.error.stack && (
            <pre className="mt-2 bg-[#0E1014] text-neutral-300 rounded-[3px] p-3 font-mono text-[11px] leading-[1.6] max-h-48 overflow-auto whitespace-pre-wrap">
              {run.error.stack}
            </pre>
          )}
        </CkCard>
      )}

      <CkCard
        eyebrow="Vercel Workflow · steps.list"
        title="Step timeline"
        action={
          <div className="flex gap-3 font-body text-xs text-neutral-700">
            {(["completed", "running", "failed"] as StepStatus[]).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-[1px]"
                  style={{ background: STEP_COLOR[s] }}
                />
                {STEP_LABEL[s]}
              </span>
            ))}
          </div>
        }
      >
        {steps.length === 0 ? (
          <div className="py-6 text-center text-neutral-500 font-body text-[13px]">
            No steps recorded for this run yet.
          </div>
        ) : (
          <StepWaterfall
            steps={steps}
            total={total}
            barMs={barMs}
            selectedId={selected?.stepId ?? null}
            onSelect={setSelectedId}
          />
        )}
      </CkCard>

      {selected && (
        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          <CkCard eyebrow={STEP_LABEL[selected.status]} title={selected.name}>
            <div className="grid grid-cols-[auto_1fr] gap-y-2 gap-x-6 font-mono text-xs">
              <span className="text-neutral-500">step_id</span>
              <span className="text-neutral-900 break-all">{selected.stepId}</span>
              <span className="text-neutral-500">step_name</span>
              <span className="text-neutral-900 break-all">{selected.rawName}</span>
              <span className="text-neutral-500">status</span>
              <span>
                {selected.status === "failed" ? (
                  <CkChip tone="failed">failed</CkChip>
                ) : selected.status === "completed" ? (
                  <CkChip tone="success">ok</CkChip>
                ) : (
                  <CkChip>{selected.status}</CkChip>
                )}
              </span>
              <span className="text-neutral-500">attempt</span>
              <span className="text-neutral-900">
                {selected.attempt}
                {selected.attempt > 1 && (
                  <span className="text-burnt-orange"> · retried</span>
                )}
              </span>
              <span className="text-neutral-500">started_at</span>
              <span className="text-neutral-900">
                +{(selected.startOffsetMs / 1000).toFixed(2)}s
              </span>
              <span className="text-neutral-500">duration</span>
              <span className="text-neutral-900">{fmtMs(selected.durationMs)}</span>
              <span className="text-neutral-500">created</span>
              <span className="text-neutral-900">{fmtClock(selected.createdAt)}</span>
              <span className="text-neutral-500">completed</span>
              <span className="text-neutral-900">
                {fmtClock(selected.completedAt)}
              </span>
              {selected.error && (
                <>
                  <span className="text-neutral-500">error</span>
                  <span className="text-fail-fg break-all">
                    {selected.error.message}
                  </span>
                </>
              )}
            </div>
          </CkCard>

          <CkCard eyebrow="Vercel Workflow" title="Step I/O">
            <div className="py-5 text-center text-neutral-500 font-body text-[13px]">
              Step input &amp; output are encrypted at rest by the Workflow
              runtime and are not viewable here.
            </div>
            <div className="mt-4 pt-3 border-t border-neutral-200 font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase">
              Source: world.steps.list · resolveData=none
            </div>
          </CkCard>
        </div>
      )}
    </div>
  );
}

function Breadcrumb({ runId, onBack }: { runId: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-3 font-body text-[13px]">
      <a
        onClick={onBack}
        className="font-mono text-[11px] text-mariner cursor-pointer uppercase tracking-[0.04em]"
      >
        ← Runs
      </a>
      <span className="text-[#D2D6DA]">/</span>
      <span className="font-mono text-neutral-700">{runId}</span>
    </div>
  );
}

/* ── Step waterfall (one row per step, positioned by real timing) ── */

function StepWaterfall({
  steps,
  total,
  barMs,
  selectedId,
  onSelect,
}: {
  steps: RunStep[];
  total: number;
  barMs: (s: RunStep) => number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-col">
      {steps.map((s) => {
        const left = (s.startOffsetMs / total) * 100;
        const width = Math.max(0.6, (barMs(s) / total) * 100);
        const isSel = selectedId === s.stepId;
        return (
          <div
            key={s.stepId}
            onClick={() => onSelect(s.stepId)}
            className={`grid grid-cols-[220px_1fr] items-center gap-3 px-2 py-1 rounded-xs cursor-pointer ${isSel ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: STEP_COLOR[s.status] }}
              />
              <span className="font-mono text-[11px] text-neutral-900 truncate">
                {s.name}
              </span>
              {s.attempt > 1 && (
                <span className="font-mono text-[10px] text-burnt-orange shrink-0">
                  ×{s.attempt}
                </span>
              )}
            </div>
            <div className="relative h-4">
              <div
                className="absolute top-0 h-4 rounded-xs"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  background: STEP_COLOR[s.status],
                  opacity: isSel ? 1 : 0.9,
                }}
                title={`${s.name} · ${fmtMs(s.durationMs)}`}
              />
              <span
                className="absolute top-0 h-4 flex items-center font-mono text-[10px] text-neutral-500"
                style={{ left: `calc(${Math.min(left + width, 99)}% + 6px)` }}
              >
                {fmtMs(s.durationMs)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
