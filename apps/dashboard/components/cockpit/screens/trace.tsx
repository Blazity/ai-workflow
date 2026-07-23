"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { FlameGraph } from "@/components/flame-graph";
import { CkCard, CkKPI, CkChip, CkStatusPill } from "@/components/ui";
import {
  WorkflowReplay,
  countReplayRetries,
} from "./workflow-replay";
import { answerPanelMode } from "@/lib/answer-panel-mode";
import { readErrorMessage } from "@/lib/api/error-message";
import { runHref } from "@/lib/run-href";
import { SPAN_KIND_COLOR } from "@/lib/theme";
import type { Span, SpanKind, SpanStatus } from "@/lib/types";
import type {
  ClarificationAnswerResponse,
  ClarificationRequest,
  RunDetailResponse,
  RunStatus,
  RunStep,
  StepStatus,
  WorkflowRunReplayResponse,
} from "@shared/contracts";

/* ───────────────────── RUN TRACE ───────────────────── */

type PhaseName =
  | "Setup"
  | "Research"
  | "Implementation"
  | "Review"
  | "Finalize"
  | "Run";

/** Each phase borrows a span "kind" so the FlameGraph colors it distinctly. */
const PHASE_KIND: Record<PhaseName, SpanKind> = {
  Setup: "workflow",
  Research: "retrieval",
  Implementation: "llm",
  Review: "guardrail",
  Finalize: "tool",
  Run: "workflow",
};

const PHASE_ORDER: PhaseName[] = [
  "Setup",
  "Research",
  "Implementation",
  "Review",
  "Finalize",
  "Run",
];

const SEQ: PhaseName[] = ["Research", "Implementation", "Review"];
/** Unique, once-per-phase terminal steps — the reliable phase boundaries. */
const TERMINAL: Record<string, PhaseName> = {
  parseResearchStep: "Research",
  parseAgentOutputStep: "Implementation",
  parseReviewStep: "Review",
};

/**
 * Assign each step its workflow phase. The phase-running steps repeat
 * (`planPhaseStep`, `collectPhase`…), so we anchor on `planPhaseStep` — called
 * exactly once per phase, always in Research → Implementation → Review order —
 * and only fall through to "Finalize" once a phase's unique terminal step has
 * run. Steps started but not yet terminated (running/cancelled mid-phase) stay
 * in their phase rather than leaking into Finalize. Steps are pre-sorted by
 * start time, so index order is execution order.
 */
function derivePhases(steps: RunStep[]): PhaseName[] {
  const names = steps.map((s) => s.name);
  const starts: { idx: number; phase: PhaseName }[] = [];
  names.forEach((n, i) => {
    if (n === "planPhaseStep" && starts.length < SEQ.length) {
      starts.push({ idx: i, phase: SEQ[starts.length] });
    }
  });
  const terminalIdx: Partial<Record<PhaseName, number>> = {};
  names.forEach((n, i) => {
    const p = TERMINAL[n];
    if (p && terminalIdx[p] == null) terminalIdx[p] = i;
  });

  if (starts.length === 0) return names.map(() => "Run");

  return names.map((_, i) => {
    if (i < starts[0].idx) return "Setup";
    let k = 0;
    for (let j = 0; j < starts.length; j++) if (starts[j].idx <= i) k = j;
    const term = terminalIdx[starts[k].phase];
    if (term != null && i > term) {
      return starts[k + 1] ? starts[k + 1].phase : "Finalize";
    }
    return starts[k].phase;
  });
}

interface PhaseGroup {
  name: PhaseName;
  kind: SpanKind;
  color: string;
  steps: RunStep[];
  start: number;
  end: number;
  failed: boolean;
}

const STEP_SPAN_STATUS: Record<StepStatus, SpanStatus> = {
  completed: "ok",
  running: "ok",
  pending: "ok",
  failed: "error",
  cancelled: "error",
};

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function TraceScreen({
  runId,
  data,
  replay,
}: {
  runId: string;
  data: RunDetailResponse;
  replay: WorkflowRunReplayResponse;
}) {
  const router = useRouter();
  const onBack = () => router.push("/runs");
  const onTicket = (key: string) => router.push(`/ticket/${encodeURIComponent(key)}`);
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-6 lg:px-6 lg:pt-5 lg:pb-8">
      <Breadcrumb
        runId={runId}
        ticket={data.run?.ticket ?? ""}
        onBack={onBack}
        onTicket={onTicket}
      />
      <TraceDetail runId={runId} data={data} replay={replay} />
    </div>
  );
}

export function replayForRunLifecycle(
  candidate: WorkflowRunReplayResponse,
  runMayAdvance: boolean,
): WorkflowRunReplayResponse {
  const mayAdvance =
    candidate.availability !== "expired" && runMayAdvance;
  return candidate.mayAdvance === mayAdvance
    ? candidate
    : { ...candidate, mayAdvance };
}

export function TraceDetail({
  runId,
  data,
  replay,
}: {
  runId: string;
  data: RunDetailResponse;
  replay: WorkflowRunReplayResponse;
}) {
  const { run, steps } = data;
  const runMayAdvance =
    !!run &&
    !["success", "failed", "blocked"].includes(run.status);
  const normalizeReplay = React.useCallback(
    (candidate: WorkflowRunReplayResponse): WorkflowRunReplayResponse =>
      replayForRunLifecycle(candidate, runMayAdvance),
    [runMayAdvance],
  );
  const [currentReplay, setCurrentReplay] = React.useState(() =>
    normalizeReplay(replay),
  );
  React.useEffect(() => {
    setCurrentReplay(normalizeReplay(replay));
  }, [normalizeReplay, replay, runId]);
  const handleReplayResponse = React.useCallback(
    (candidate: WorkflowRunReplayResponse) => {
      setCurrentReplay(normalizeReplay(candidate));
    },
    [normalizeReplay],
  );

  // Whether the run is still in flight — drives the "Running" indicator only. The
  // auto-refresh is owned globally by CockpitShell's live-poll control (the
  // topbar Live toggle), which calls router.refresh() for the active screen;
  // this screen no longer polls on its own.
  const isRunning =
    !run ||
    (run.status !== "success" &&
      run.status !== "failed" &&
      run.status !== "blocked" &&
      run.status !== "awaiting");

  // Wall-clock offset of "now" from run start — sizes bars for running steps.
  const runStartMs = run ? Date.parse(run.startedAt ?? run.createdAt) : 0;
  const nowOffsetMs = Math.max(0, Date.parse(data.generatedAt) - runStartMs);
  const barMs = React.useCallback(
    (s: RunStep): number =>
      s.durationMs ?? Math.max(0, nowOffsetMs - s.startOffsetMs),
    [nowOffsetMs],
  );

  const { phaseOf, groups, spans } = React.useMemo(() => {
    const names = derivePhases(steps);
    const phaseOf = new Map<string, PhaseName>();
    steps.forEach((s, i) => phaseOf.set(s.stepId, names[i]));

    const byName = new Map<PhaseName, PhaseGroup>();
    steps.forEach((s) => {
      const name = phaseOf.get(s.stepId)!;
      const end = s.startOffsetMs + barMs(s);
      const g = byName.get(name);
      if (!g) {
        byName.set(name, {
          name,
          kind: PHASE_KIND[name],
          color: SPAN_KIND_COLOR[PHASE_KIND[name]],
          steps: [s],
          start: s.startOffsetMs,
          end,
          failed: s.status === "failed" || s.status === "cancelled",
        });
      } else {
        g.steps.push(s);
        g.start = Math.min(g.start, s.startOffsetMs);
        g.end = Math.max(g.end, end);
        g.failed ||= s.status === "failed" || s.status === "cancelled";
      }
    });
    const groups = PHASE_ORDER.filter((p) => byName.has(p)).map(
      (p) => byName.get(p)!,
    );

    const phaseSpans: Span[] = groups.map((g) => ({
      id: `phase:${g.name}`,
      parent: null,
      name: g.name,
      kind: g.kind,
      start: g.start,
      duration: Math.max(1, g.end - g.start),
      status: g.failed ? "error" : "ok",
    }));
    const stepSpans: Span[] = steps.map((s) => {
      const name = phaseOf.get(s.stepId)!;
      return {
        id: s.stepId,
        name: s.name,
        kind: PHASE_KIND[name],
        start: s.startOffsetMs,
        duration: Math.max(1, barMs(s)),
        status: STEP_SPAN_STATUS[s.status],
        parent: `phase:${name}`,
      };
    });
    return { phaseOf, groups, spans: [...phaseSpans, ...stepSpans] };
  }, [steps, barMs]);

  const [selectedId, setSelectedId] = React.useState<string | null>(
    steps[0]?.stepId ?? null,
  );
  const selected =
    steps.find((s) => s.stepId === selectedId) ?? steps[0] ?? null;
  const selectedPhase = selected ? phaseOf.get(selected.stepId) : undefined;
  const selectedGroup = groups.find((g) => g.name === selectedPhase);

  const onSelect = (id: string) => {
    if (id.startsWith("phase:")) {
      const name = id.slice("phase:".length);
      const first = groups.find((g) => g.name === name)?.steps[0];
      if (first) setSelectedId(first.stepId);
      return;
    }
    setSelectedId(id);
  };

  if (!data.available || !run) {
    return (
      <CkCard eyebrow="Run trace" title="Run unavailable">
        <div className="py-6 text-center text-neutral-500 font-body text-[13px]">
          No trace data for <span className="font-mono">{runId}</span>. The run
          may have expired, or the workflow runtime is unavailable.
        </div>
      </CkCard>
    );
  }

  const failedSteps = steps.filter((s) => s.status === "failed").length;
  const retries = steps.reduce((n, s) => n + Math.max(0, s.attempt - 1), 0);
  const hasReplay =
    currentReplay.availability === "available" &&
    currentReplay.snapshot !== null;
  const replayPending =
    currentReplay.availability === "not_captured" &&
    currentReplay.mayAdvance;
  const replayFailed = currentReplay.attempts.filter(
    (attempt) => attempt.state === "failed",
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap lg:flex-nowrap">
            <CkStatusPill status={run.status} />
            <CkChip tone="mariner">{run.workflowName}</CkChip>
            <span className="font-mono text-[11px] text-neutral-700">
              {[run.ticket, run.model].filter(Boolean).join(" · ")}
            </span>
            {isRunning && (
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-mariner tracking-[0.04em] uppercase">
                <span className="relative w-1.5 h-1.5">
                  <span className="absolute inset-0 rounded-full bg-mariner" />
                  <span className="absolute -inset-[3px] rounded-full border border-mariner animate-ck-pulse" />
                </span>
                Running
              </span>
            )}
          </div>
          <h2 className="font-display font-medium text-2xl leading-[1.2] m-0 text-neutral-900">
            {run.ticketTitle || run.id}
          </h2>
        </div>
        {(run.ticketUrl || run.prUrl) && (
          <div className="flex items-center gap-2 self-start lg:self-auto">
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
            {run.prUrl && (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
                className="appearance-none border border-neutral-200 bg-coal px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-white uppercase tracking-[0.04em] cursor-pointer no-underline hover:bg-neutral-800"
              >
                {run.prNumber ? `PR #${run.prNumber}` : "Open PR"} ↗
              </a>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <CkKPI
          label="Duration"
          value={run.durationSec === null ? "—" : `${run.durationSec}s`}
          sub={run.status === "running" ? "in progress" : "elapsed"}
        />
        <CkKPI
          label={hasReplay ? "Blocks" : "Phases"}
          value={
            hasReplay
              ? currentReplay.snapshot?.graph.nodes.length ?? 0
              : groups.length
          }
          sub={hasReplay ? "captured" : "detected"}
        />
        <CkKPI
          label={hasReplay ? "Attempts" : "Steps"}
          value={hasReplay ? currentReplay.attempts.length : steps.length}
          sub={hasReplay ? "observed" : "durable"}
        />
        <CkKPI
          label="Retries"
          value={
            hasReplay
              ? countReplayRetries(currentReplay.attempts)
              : retries
          }
          sub={hasReplay ? "block re-attempts" : "step re-attempts"}
        />
        <CkKPI
          label="Failed"
          value={hasReplay ? replayFailed : failedSteps}
          sub={hasReplay ? "failed attempts" : "failed steps"}
        />
      </div>

      {run.error && (
        <CkCard eyebrow="Workflow error" title={run.error.code ?? "Run failed"}>
          <div className="font-mono text-xs text-fail-fg break-all">
            {run.error.message}
          </div>
        </CkCard>
      )}

      {data.clarification && (
        <AnswerPanel
          clarification={data.clarification}
          ticket={run.ticket}
          runStatus={run.status}
        />
      )}

      {hasReplay || replayPending ? (
        <WorkflowReplay
          runId={runId}
          initialResponse={currentReplay}
          onResponse={handleReplayResponse}
        />
      ) : (
        <>
          <div
            role="status"
            className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-700"
          >
            {currentReplay.availability === "expired"
              ? "The replay observation expired. Showing the legacy step trace."
              : "Visual replay was not captured for this run. Showing the legacy step trace."}
          </div>
          <CkCard
            eyebrow="Vercel Workflow · steps.list"
            title="Step timeline · phases"
            action={
              <div className="flex flex-wrap gap-3 font-body text-xs text-neutral-700">
                {groups.map((g) => (
                  <span key={g.name} className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-[1px]"
                      style={{ background: g.color }}
                    />
                    {g.name}
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
              <div className="mt-[18px] overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0">
                <div className="min-w-[640px] lg:min-w-0">
                  <FlameGraph
                    spans={spans}
                    width={1040}
                    rowH={30}
                    gap={4}
                    selectedId={selected?.stepId ?? undefined}
                    onSelect={onSelect}
                  />
                </div>
              </div>
            )}
          </CkCard>

          {selected && (
            <div className="flex flex-col lg:grid lg:grid-cols-[1.4fr_1fr] gap-3">
              <CkCard
                eyebrow={selectedPhase ?? "step"}
                title={selected.name}
              >
                <div className="grid grid-cols-[auto_1fr] gap-y-2 gap-x-6 font-mono text-xs">
                  <span className="text-neutral-500">step_id</span>
                  <span className="text-neutral-900 break-all">
                    {selected.stepId}
                  </span>
                  <span className="text-neutral-500">step_name</span>
                  <span className="text-neutral-900 break-all">
                    {selected.rawName}
                  </span>
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
                  <span className="text-neutral-900">
                    {fmtMs(selected.durationMs)}
                  </span>
                  <span className="text-neutral-500">created</span>
                  <span className="text-neutral-900">
                    {fmtClock(selected.createdAt)}
                  </span>
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

              <CkCard
                eyebrow="Phase"
                title={selectedPhase ?? "—"}
                action={
                  selectedGroup && (
                    <CkChip
                      tone={selectedGroup.failed ? "failed" : "success"}
                    >
                      {selectedGroup.failed ? "had failures" : "ok"}
                    </CkChip>
                  )
                }
              >
                {selectedGroup && (
                  <div className="grid grid-cols-[auto_1fr] gap-y-2 gap-x-6 font-mono text-xs">
                    <span className="text-neutral-500">steps</span>
                    <span className="text-neutral-900">
                      {selectedGroup.steps.length}
                    </span>
                    <span className="text-neutral-500">started</span>
                    <span className="text-neutral-900">
                      +{(selectedGroup.start / 1000).toFixed(2)}s
                    </span>
                    <span className="text-neutral-500">duration</span>
                    <span className="text-neutral-900">
                      {fmtMs(selectedGroup.end - selectedGroup.start)}
                    </span>
                  </div>
                )}
                <div className="mt-4 pt-3 border-t border-neutral-200 font-body text-[12px] text-neutral-500 leading-snug">
                  Step input &amp; output are encrypted at rest by the Workflow
                  runtime and are not viewable here.
                </div>
              </CkCard>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Answer panel for a run parked on a clarification question. Under the
 * hook-resume design the answer resumes the SAME run in place, so the run's
 * live status (not the deprecated `dispatchedRunId`) tells whether the answer
 * took: any status but "awaiting" means the run woke up. The state decision
 * lives in `answerPanelMode`; a fresh in-page submit result stands in for the
 * server props until the next poll catches up.
 */
function AnswerPanel({
  clarification,
  ticket,
  runStatus,
}: {
  clarification: ClarificationRequest;
  ticket: string;
  runStatus: RunStatus;
}) {
  const router = useRouter();
  const [answer, setAnswer] = React.useState(clarification.answer ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ClarificationAnswerResponse | null>(
    null,
  );

  // A fresh submit response is newer than the server props; render from it.
  const view = result?.clarification ?? clarification;
  // Legacy rows only: the old design dispatched a separate resume run, so the
  // asking run stays "awaiting" forever; never offer a retry for those.
  const legacyRunId = clarification.dispatchedRunId;
  const mode =
    legacyRunId !== null
      ? "resumed"
      : answerPanelMode(view.status, runStatus, result !== null);

  if (mode === "hidden") return null;

  const answered = view.status === "answered";
  const retry = mode === "retry";
  const showForm = mode === "form" || retry;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // The worker's retry path deliberately skips the answer CAS (it only
      // re-verifies and re-sends the wake-up), so any edit would be silently
      // dropped. Send the SAVED answer on retry; the pending path sends the
      // typed one.
      const answerToSend = retry
        ? (clarification.answer ?? "").trim()
        : answer.trim();
      const res = await fetch(
        `/api/clarifications/${encodeURIComponent(clarification.id)}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: answerToSend }),
        },
      );
      if (!res.ok) {
        setError(await readErrorMessage(res));
        if (res.status === 409 || res.status === 410) router.refresh();
        return;
      }
      setResult((await res.json()) as ClarificationAnswerResponse);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit answer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CkCard
      eyebrow="Human-in-the-loop"
      title="Input needed"
      style={{ background: "#FFFCFA", borderColor: "#FFE4D6" }}
    >
      <div className="flex flex-col gap-4">
        <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 font-body text-[13px] leading-[1.55] text-neutral-800">
          {clarification.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>

        {answered && (
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
              Answer
            </span>
            <p className="m-0 whitespace-pre-wrap break-words rounded-[3px] border border-neutral-200 bg-off-white p-3 font-body text-[13px] leading-[1.5] text-coal">
              {view.answer}
            </p>
            {view.answeredAt && (
              <span className="font-mono text-[11px] text-neutral-500">
                Answered by{" "}
                {view.answeredByLabel ?? view.answeredById ?? "unknown"} ·{" "}
                {fmtClock(view.answeredAt)}
              </span>
            )}
          </div>
        )}

        {legacyRunId ? (
          <div className="font-mono text-[11px] text-success-fg">
            Resumed as{" "}
            <Link
              href={runHref({ id: legacyRunId, ticket })}
              className="text-mariner underline-offset-2 hover:underline"
            >
              run {legacyRunId}
            </Link>
          </div>
        ) : mode === "resumed" ? (
          <div className="font-mono text-[11px] text-success-fg">
            The run resumed with this answer.
          </div>
        ) : null}

        {showForm && (
          <>
            {retry && (
              <div className="font-body text-[12px] leading-snug text-neutral-700">
                The answer is saved but the run has not resumed yet. It
                normally resumes automatically within a minute; you can also
                retry now with the saved answer.
              </div>
            )}

            {/* Retry state edits nothing: the worker re-uses the saved answer,
                so no chips or textarea here - only the read-only Q&A above. */}
            {!retry && (
              <>
                {clarification.suggestedAnswers &&
                clarification.suggestedAnswers.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {clarification.suggestedAnswers.map((a, j) => (
                      <button
                        key={j}
                        type="button"
                        disabled={busy}
                        onClick={() => setAnswer(a)}
                        className="appearance-none border border-neutral-200 bg-panel px-2.5 py-[5px] rounded-[3px] cursor-pointer font-body text-xs text-neutral-900 transition-all duration-100 hover:bg-coal hover:text-white disabled:cursor-default disabled:opacity-40"
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                ) : null}

                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  disabled={busy}
                  rows={4}
                  aria-label="Answer"
                  placeholder="Type your answer…"
                  className="w-full resize-y rounded-[3px] border border-neutral-200 bg-panel p-3 font-body text-[13px] leading-[1.5] text-coal placeholder:text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-1px] disabled:opacity-60"
                />
              </>
            )}

            {error ? <InlineError>{error}</InlineError> : null}

            <div className="flex items-center gap-2">
              <DarkButton
                type="button"
                disabled={busy || (!retry && answer.trim().length === 0)}
                onClick={submit}
              >
                {busy
                  ? "Submitting…"
                  : retry
                    ? "Retry resume run"
                    : "Submit answer"}
              </DarkButton>
            </div>
          </>
        )}
      </div>
    </CkCard>
  );
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[3px] border border-fail-bg bg-fail-bg px-3 py-2 text-[13px] text-fail-fg">
      {children}
    </div>
  );
}

function DarkButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="inline-flex items-center justify-center whitespace-nowrap rounded-[3px] border border-neutral-900 bg-neutral-900 px-3.5 py-[5px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white transition hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Breadcrumb({
  runId,
  ticket,
  onBack,
  onTicket,
}: {
  runId: string;
  ticket: string;
  onBack: () => void;
  onTicket: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 font-body text-[13px] min-w-0">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to runs"
        className="appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-mariner cursor-pointer uppercase tracking-[0.04em] shrink-0"
      >
        ← Runs
      </button>
      {ticket && (
        <>
          <span className="text-[#D2D6DA] shrink-0">/</span>
          <button
            type="button"
            onClick={() => onTicket(ticket)}
            aria-label={`All runs for ${ticket}`}
            className="appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-mariner cursor-pointer tracking-[0.04em] shrink-0"
          >
            {ticket}
          </button>
        </>
      )}
      <span className="text-[#D2D6DA] shrink-0">/</span>
      <span className="font-mono text-neutral-700 truncate">{runId}</span>
    </div>
  );
}
