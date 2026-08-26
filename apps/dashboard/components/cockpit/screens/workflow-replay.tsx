"use client";

import React from "react";

import { CkCard, CkChip, CkTabs } from "@/components/ui";
import {
  LIVE_POLL_MS,
  useLivePoll,
} from "@/lib/use-live-poll";
import { edgeBezierPath } from "@/lib/workflow-editor/layout-geometry";
import type {
  JsonValue,
  ReplayAttemptState,
  ReplaySanitizedEnvelope,
  WorkflowBlockType,
  WorkflowReplayGraphEdge,
  WorkflowReplayGraphNode,
  WorkflowReplayAttemptDetail,
  WorkflowReplayAttemptSummary,
  WorkflowRunReplayResponse,
} from "@shared/contracts";

const NODE_WIDTH = 184;
const NODE_HEIGHT = 72;
const CANVAS_PADDING = 56;
export const REPLAY_GRAPH_HISTORY_MAX_PAGES = 10;

type ReplayTab = "input" | "output" | "logs" | "metadata" | "attempts";
type ReplayEdge = WorkflowReplayGraphEdge;
type ReplayNode = WorkflowReplayGraphNode;

interface ReplayTransition {
  port: string;
  edgeIds: string[];
}

const STATE_STYLE: Record<
  ReplayAttemptState | "pending" | "loading_history",
  { border: string; background: string; dot: string; label: string }
> = {
  loading_history: {
    border: "#D9DDE2",
    background: "#F8F9FB",
    dot: "#3C43E7",
    label: "Loading history",
  },
  pending: {
    border: "#D9DDE2",
    background: "#FFFFFF",
    dot: "#9EA3AA",
    label: "Not reached",
  },
  running: {
    border: "#3C43E7",
    background: "#F2F3FF",
    dot: "#3C43E7",
    label: "Running",
  },
  waiting_loop: {
    border: "#FD6027",
    background: "#FFF7F3",
    dot: "#FD6027",
    label: "Waiting for loop",
  },
  waiting_for_clarification: {
    border: "#FD6027",
    background: "#FFF7F3",
    dot: "#FD6027",
    label: "Awaiting input",
  },
  completed: {
    border: "#5BB04A",
    background: "#F4FBF2",
    dot: "#5BB04A",
    label: "Completed",
  },
  failed: {
    border: "#D14343",
    background: "#FFF4F4",
    dot: "#D14343",
    label: "Failed",
  },
  cancelled: {
    border: "#9EA3AA",
    background: "#F6F7F8",
    dot: "#737981",
    label: "Cancelled",
  },
  skipped: {
    border: "#B7BBC1",
    background: "#F6F7F8",
    dot: "#B7BBC1",
    label: "Skipped",
  },
};

function labelForType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function transitionOf(
  attempt: WorkflowReplayAttemptSummary,
): ReplayTransition | null {
  return attempt.selectedTransition;
}

function edgeId(edge: ReplayEdge): string {
  return edge.id;
}

export function latestReplayAttempts(
  attempts: WorkflowReplayAttemptSummary[],
): Map<string, WorkflowReplayAttemptSummary> {
  const latest = new Map<string, WorkflowReplayAttemptSummary>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.nodeId);
    if (
      !current ||
      compareReplayAttemptActivity(attempt, current) > 0
    ) {
      latest.set(attempt.nodeId, attempt);
    }
  }
  return latest;
}

export function compareReplayAttemptActivity(
  left: WorkflowReplayAttemptSummary,
  right: WorkflowReplayAttemptSummary,
): number {
  const leftLive = isLiveReplayAttempt(left);
  const rightLive = isLiveReplayAttempt(right);
  if (leftLive !== rightLive) return leftLive ? 1 : -1;

  const activity =
    (left.completedAt ?? left.startedAt).localeCompare(
      right.completedAt ?? right.startedAt,
    );
  if (activity !== 0) return activity;
  if (left.attempt !== right.attempt) {
    return left.attempt - right.attempt;
  }
  return left.id - right.id;
}

export function selectReplayAttempt(
  attempts: WorkflowReplayAttemptSummary[],
  selectedAttemptId: number | null,
  followLatest: boolean,
): WorkflowReplayAttemptSummary | null {
  if (followLatest) return attempts[0] ?? null;
  return (
    attempts.find((attempt) => attempt.id === selectedAttemptId) ??
    attempts[0] ??
    null
  );
}

export function mergeReplayAttempts(
  current: WorkflowReplayAttemptSummary[],
  incoming: WorkflowReplayAttemptSummary[],
): WorkflowReplayAttemptSummary[] {
  const incomingById = new Map(
    incoming.map((attempt) => [attempt.id, attempt]),
  );
  const seen = new Set(current.map((attempt) => attempt.id));
  return [
    ...current.map(
      (attempt) => incomingById.get(attempt.id) ?? attempt,
    ),
    ...incoming.filter((attempt) => {
      if (seen.has(attempt.id)) return false;
      seen.add(attempt.id);
      return true;
    }),
  ];
}

interface ReplayPageFetchResult {
  ok: boolean;
  json(): Promise<unknown>;
}

type ReplayPageFetcher = (
  input: string,
  init: { cache: "no-store"; signal?: AbortSignal },
) => Promise<ReplayPageFetchResult>;

export async function loadReplayAttemptSummaryTail({
  runId,
  cursor,
  signal,
  maxPages = REPLAY_GRAPH_HISTORY_MAX_PAGES,
  fetchPage = fetch,
}: {
  runId: string;
  cursor: string;
  signal?: AbortSignal;
  maxPages?: number;
  fetchPage?: ReplayPageFetcher;
}): Promise<{
  attempts: WorkflowReplayAttemptSummary[];
  remainingCursor: string | null;
}> {
  const attempts: WorkflowReplayAttemptSummary[] = [];
  const seenAttemptIds = new Set<number>();
  const seenCursors = new Set<string>();
  let nextCursor: string | null = cursor;
  let loadedPages = 0;

  while (
    nextCursor &&
    !signal?.aborted &&
    loadedPages < Math.max(1, maxPages)
  ) {
    if (seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    const result = await fetchPage(
      `/api/runs/${encodeURIComponent(runId)}/replay?limit=200&cursor=${encodeURIComponent(nextCursor)}`,
      { cache: "no-store", signal },
    );
    if (!result.ok) {
      throw new Error("Replay attempt summaries are unavailable.");
    }
    const page = (await result.json()) as WorkflowRunReplayResponse;
    attempts.push(
      ...page.attempts.filter((candidate) => {
        if (seenAttemptIds.has(candidate.id)) return false;
        seenAttemptIds.add(candidate.id);
        return true;
      }),
    );
    nextCursor = page.nextCursor;
    loadedPages += 1;
  }

  return { attempts, remainingCursor: nextCursor };
}

export function countReplayRetries(
  attempts: WorkflowReplayAttemptSummary[],
): number {
  const attemptsByInvocation = new Map<string, number>();
  for (const attempt of attempts) {
    const key = `${attempt.nodeId}\u0000${attempt.activationScopeId}`;
    attemptsByInvocation.set(
      key,
      (attemptsByInvocation.get(key) ?? 0) + 1,
    );
  }
  return [...attemptsByInvocation.values()].reduce(
    (count, attemptCount) => count + Math.max(0, attemptCount - 1),
    0,
  );
}

export function isLiveReplayAttempt(
  attempt: WorkflowReplayAttemptSummary,
): boolean {
  return (
    attempt.state === "running" ||
    attempt.state === "waiting_loop" ||
    attempt.state === "waiting_for_clarification"
  );
}

export function shouldPollReplay(
  response: WorkflowRunReplayResponse,
): boolean {
  return response.mayAdvance && response.availability !== "expired";
}

export function initialReplayNodeId(
  response: WorkflowRunReplayResponse,
): string | null {
  const latest = [...latestReplayAttempts(response.attempts).values()];
  return (
    latest.find((attempt) => isLiveReplayAttempt(attempt))?.nodeId ??
    latest.find((attempt) => attempt.state === "failed")?.nodeId ??
    latest.find((attempt) => attempt.state === "completed")?.nodeId ??
    response.snapshot?.graph.nodes[0]?.id ??
    null
  );
}

export function replaySelectionForRun(
  response: WorkflowRunReplayResponse,
): { nodeId: string | null; attemptId: number | null } {
  const nodeId = initialReplayNodeId(response);
  const attemptId =
    nodeId === null
      ? null
      : [...response.attempts]
          .filter((attempt) => attempt.nodeId === nodeId)
          .sort((left, right) =>
            compareReplayAttemptActivity(right, left),
          )[0]?.id ?? null;
  return { nodeId, attemptId };
}

function displayDuration(attempt: WorkflowReplayAttemptSummary): string {
  if (attempt.durationMs === null) return "in progress";
  if (attempt.durationMs < 1000) return `${Math.round(attempt.durationMs)}ms`;
  return `${(attempt.durationMs / 1000).toFixed(2)}s`;
}

function displayAttempt(attempt: WorkflowReplayAttemptSummary): string {
  return `Attempt ${attempt.attempt} · ${attempt.activationScopeId}`;
}

/** The worker route returns the flat attempt detail and the dashboard proxy
 * forwards that body verbatim, so the payload is validated as it arrives. Its
 * own `attempt` field is the attempt number, never a nested envelope. */
export function asDetail(
  value: unknown,
): WorkflowReplayAttemptDetail | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "number"
  ) {
    return null;
  }
  return value as WorkflowReplayAttemptDetail;
}

/** Distinguishes a transport or parse failure, which deserves an alert, from a
 * detail the run never persisted, which is an ordinary empty state. */
export function replayAttemptDetailResult(
  status: number,
  body: unknown,
): { detail: WorkflowReplayAttemptDetail | null; error: string | null } {
  if (status === 404) return { detail: null, error: null };
  if (status < 200 || status >= 300) {
    return {
      detail: null,
      error: `Attempt detail is unavailable (${status}).`,
    };
  }
  const detail = asDetail(body);
  return detail
    ? { detail, error: null }
    : { detail: null, error: "Attempt detail is unavailable." };
}

/** Outcome and diagnostic id of a failed attempt, so the panel always states
 * what failed even when no sanitized agent artifact was captured. Deliberately
 * omits `outcome.details`, which is free-form and not envelope-sanitized. */
export function replayAttemptFailureCause(
  attempt: WorkflowReplayAttemptSummary,
): string | null {
  if (attempt.state !== "failed") return null;
  const cause = attempt.outcome
    ? `${attempt.outcome.kind}: ${attempt.outcome.status}`
    : "cause not recorded";
  return attempt.diagnosticId
    ? `${cause} · diagnostic ${attempt.diagnosticId}`
    : cause;
}

export function shouldPollAttemptDetail(
  attempt: WorkflowReplayAttemptSummary | null,
  runIsLive: boolean,
): boolean {
  return runIsLive && attempt !== null && isLiveReplayAttempt(attempt);
}

export function replayEdgeIsActive(
  edge: ReplayEdge,
  attempts: WorkflowReplayAttemptSummary[],
): boolean {
  const id = edgeId(edge);
  return attempts.some((attempt) => {
    if (attempt.nodeId !== edge.from) return false;
    const transition = transitionOf(attempt);
    if (!transition) return false;
    if (transition.edgeIds.length > 0) return transition.edgeIds.includes(id);
    return transition.port === (edge.fromPort ?? "out");
  });
}

function ReplayCanvas({
  response,
  graphAttempts,
  graphHistoryComplete,
  selectedNodeId,
  onSelectNode,
}: {
  response: WorkflowRunReplayResponse;
  graphAttempts: WorkflowReplayAttemptSummary[];
  graphHistoryComplete: boolean;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const snapshot = response.snapshot;
  if (!snapshot) return null;

  const latestByNode = latestReplayAttempts(graphAttempts);
  const nodes: ReplayNode[] = snapshot.graph.nodes.map((node) => {
    const layout = snapshot.layout.nodes[node.id];
    return {
      id: node.id,
      type: node.type,
      name: node.name,
      x: layout?.x ?? node.x,
      y: layout?.y ?? node.y,
    };
  });
  const edges: ReplayEdge[] = snapshot.graph.edges;
  const minX = Math.min(0, ...nodes.map((node) => node.x));
  const minY = Math.min(0, ...nodes.map((node) => node.y));
  const positions = new Map(
    nodes.map((node) => [
      node.id,
      {
        x: node.x - minX + CANVAS_PADDING,
        y: node.y - minY + CANVAS_PADDING,
      },
    ]),
  );
  const width = Math.max(
    780,
    ...nodes.map(
      (node) =>
        (positions.get(node.id)?.x ?? 0) + NODE_WIDTH + CANVAS_PADDING,
    ),
  );
  const height = Math.max(
    280,
    ...nodes.map(
      (node) =>
        (positions.get(node.id)?.y ?? 0) + NODE_HEIGHT + CANVAS_PADDING,
    ),
  );

  return (
    <div
      className="relative w-full min-w-0 max-w-full overflow-auto rounded-[3px] border border-neutral-200 bg-[#F8F9FB]"
      aria-label="Workflow run replay"
      data-replay-canvas="true"
    >
      <div
        className="relative"
        style={{
          width,
          height,
          backgroundImage:
            "radial-gradient(circle, #CDD1D6 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${width} ${height}`}
        >
          <defs>
            <marker
              id="replay-arrow-muted"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="#B7BBC1" />
            </marker>
            <marker
              id="replay-arrow-active"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="#3C43E7" />
            </marker>
          </defs>
          {edges.map((edge, index) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const storedGeometry = snapshot.layout.edges[edge.id];
            const geometry = storedGeometry
              ? {
                  bend: {
                    x: storedGeometry.bend.x - minX + CANVAS_PADDING,
                    y: storedGeometry.bend.y - minY + CANVAS_PADDING,
                  },
                }
              : undefined;
            const automaticBend = Math.max(
              48,
              Math.abs(x2 - x1) * 0.45,
            );
            const active = replayEdgeIsActive(edge, graphAttempts);
            const historyPending = !graphHistoryComplete && !active;
            return (
              <path
                key={edgeId(edge)}
                d={
                  geometry
                    ? edgeBezierPath(
                        { x: x1, y: y1 },
                        { x: x2, y: y2 },
                        geometry,
                      )
                    : `M ${x1} ${y1} C ${x1 + automaticBend} ${y1}, ${x2 - automaticBend} ${y2}, ${x2} ${y2}`
                }
                fill="none"
                stroke={
                  active
                    ? "#3C43E7"
                    : historyPending
                      ? "#D9DDE2"
                      : "#B7BBC1"
                }
                strokeWidth={active ? 3 : 1.5}
                strokeDasharray={
                  active ? undefined : historyPending ? "2 4" : "5 5"
                }
                markerEnd={
                  active
                    ? "url(#replay-arrow-active)"
                    : "url(#replay-arrow-muted)"
                }
              />
            );
          })}
        </svg>

        {nodes.map((node) => {
          const position = positions.get(node.id)!;
          const latest = latestByNode.get(node.id);
          const state =
            latest?.state ??
            (graphHistoryComplete ? "pending" : "loading_history");
          const style = STATE_STYLE[state];
          const selected = selectedNodeId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node.id)}
              aria-label={`${node.name ?? labelForType(node.type)}: ${style.label}`}
              aria-pressed={selected}
              className="absolute appearance-none overflow-hidden rounded-[4px] p-0 text-left shadow-[0_2px_8px_rgba(24,27,32,0.08)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-2"
              style={{
                left: position.x,
                top: position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                border: `${selected ? 3 : 2}px solid ${style.border}`,
                background: style.background,
              }}
            >
              <span className="flex h-full flex-col justify-between px-3 py-2.5">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: style.dot }}
                  />
                  <span className="truncate font-display text-[13px] font-semibold text-coal">
                    {node.name ?? labelForType(node.type)}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.03em] text-neutral-600">
                  <span>{style.label}</span>
                  {latest ? <span>{displayDuration(latest)}</span> : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Copies arbitrary text to the clipboard, for the small "Copy" action on a
 *  payload pane. Silently no-ops on denial: there is no actionable recovery
 *  to show the user, and the pane's own content is the fallback. */
function CopyButton({
  getText,
  className,
}: {
  getText: () => string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(getText())
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className={`rounded-[3px] border border-neutral-700 bg-[#1A1D24] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-300 hover:bg-[#242832] ${className ?? ""}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function jsonPre(value: JsonValue): React.ReactNode {
  return (
    <div className="relative">
      <CopyButton
        getText={() => JSON.stringify(value, null, 2)}
        className="absolute right-2 top-2"
      />
      <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-[#0E1014] p-3 pr-14 font-mono text-[11px] leading-[1.6] text-neutral-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function ReplayEnvelope({
  envelope,
  emptyLabel,
  render,
}: {
  envelope: ReplaySanitizedEnvelope | null | undefined;
  emptyLabel: string;
  /** Overrides the raw JSON dump with a legible view of the same value. A
   *  null return (the value's shape doesn't match, e.g. it was truncated
   *  away) falls back to the JSON dump; the raw form stays reachable either
   *  way, under "Raw JSON". */
  render?: (value: JsonValue) => React.ReactNode;
}) {
  if (!envelope) {
    return (
      <div className="py-8 text-center font-body text-[13px] text-neutral-500">
        {emptyLabel}
      </div>
    );
  }
  if (envelope.metadata.unavailable) {
    return (
      <div
        role="status"
        className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-3 font-body text-[13px] text-neutral-700"
      >
        This value was unavailable because it could not be sanitized safely.
      </div>
    );
  }
  const redactions = Object.values(envelope.metadata.redactions).reduce(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  const structured = render?.(envelope.value) ?? null;
  return (
    <div className="flex flex-col gap-2">
      {redactions > 0 || envelope.metadata.truncated ? (
        <div className="flex flex-wrap gap-1.5">
          {redactions > 0 ? (
            <CkChip tone="warn">
              {redactions} redaction{redactions === 1 ? "" : "s"}
            </CkChip>
          ) : null}
          {envelope.metadata.truncated ? (
            <CkChip tone="neutral">truncated</CkChip>
          ) : null}
        </div>
      ) : null}
      {structured ?? jsonPre(envelope.value)}
      {structured ? (
        <details>
          <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Raw JSON
          </summary>
          <div className="mt-1">{jsonPre(envelope.value)}</div>
        </details>
      ) : null}
    </div>
  );
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function asArray(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function asStringField(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumberField(value: JsonValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function asBooleanField(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function scriptStatusTone(status: string | null): "success" | "failed" | "warn" | "neutral" {
  if (status === "passed") return "success";
  if (status === "failed") return "failed";
  if (status === "timed_out") return "warn";
  // not_run is not neutral: a gate group nobody's config declares, or one
  // skipped for another reason, is a finding, not a non-event.
  if (status === "not_run") return "warn";
  return "neutral";
}

/** Human label for a group status token. The one place the worker's
 *  passed/failed/timed_out/not_run/skipped vocabulary is spelled out for
 *  display, so every site that prints a group status agrees on the wording.
 *  A token outside this set (an older or newer worker deploy) falls back to
 *  the raw string rather than crashing. */
const GROUP_STATUS_LABELS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  timed_out: "Timed out",
  not_run: "Not run",
  skipped: "Skipped",
};

/** Tooltip text for group status tokens whose meaning is not obvious from the
 *  label alone. passed/failed need none. */
const GROUP_STATUS_TOOLTIPS: Record<string, string> = {
  not_run: "Asked for by this run, but it never completed.",
  skipped: "No commands from this group ran in this repository in this run.",
  timed_out: "Killed after its time limit; neither passed nor failed.",
};

/** A group status chip: humanized label, original color/badge styling, and a
 *  tooltip for the tokens whose meaning needs explaining. `status` is null
 *  when the field itself is missing from an older recorded run. */
function GroupStatusChip({ status }: { status: string | null }) {
  const label = status === null ? "n/a" : (GROUP_STATUS_LABELS[status] ?? status);
  const tooltip = status === null ? undefined : GROUP_STATUS_TOOLTIPS[status];
  return (
    <span title={tooltip}>
      <CkChip tone={scriptStatusTone(status)}>{label}</CkChip>
    </span>
  );
}

/** Block types whose output tab renders the humanized script panel instead
 *  of raw JSON: the two current palette entries plus the retired
 *  "run_checks" type, whose deployed definitions still emit the same shape.
 *  renderScriptOutput returns null on a non-matching value, so a mismatch
 *  here degrades to the raw JSON fallback rather than crashing. */
export function isScriptBlockType(
  type: WorkflowBlockType | undefined,
): boolean {
  return (
    type === "run_scripts" || type === "run_pre_pr_checks" || type === "run_checks"
  );
}

/** Legible view of run_scripts / run_pre_pr_checks output: the aggregate
 *  verdict, then results/failures/dirtied per command. Returns null when the
 *  value doesn't look like this shape at all (an older run, or a capture
 *  truncated down to nothing usable), so the caller falls back to raw JSON.
 *  Called directly, not mounted as a JSX component: a JSX element is a
 *  truthy object even when the function it wraps would return null, which
 *  would defeat the raw-JSON fallback in ReplayEnvelope above. */
export function renderScriptOutput(value: JsonValue): React.ReactNode | null {
  const output = asRecord(value);
  if (!output) return null;
  const outcome = asStringField(output.outcome);
  const ok = asBooleanField(output.ok);
  const allPassed = asBooleanField(output.allPassed);
  const summary = asStringField(output.summary);
  const groupStatuses = asArray(output.groupStatuses);
  const groupCoverage = asArray(output.groupCoverage);
  const results = asArray(output.results);
  const failures = asArray(output.failures);
  const dirtied = asArray(output.dirtied);
  if (
    outcome === null &&
    ok === null &&
    groupStatuses === null &&
    results === null &&
    failures === null &&
    dirtied === null
  ) {
    return null;
  }

  // ok is true whenever nothing matched a configured group at all, which
  // reads identically to a real pass unless allPassed is checked too:
  // allPassed additionally requires a selected group to have actually run
  // and passed.
  const nothingVerified = ok === true && allPassed === false;

  // Groups a selected group never ran in at all, per groupCoverage. Absent on
  // older recorded runs (the field shipped after this shape did), so an empty
  // list here renders nothing new rather than a misleading "fully covered".
  // missing: repositories that took part in the run and do not declare the
  // group. skipped: repositories the run never entered at all (not in the
  // workspace, HEAD unchanged, batch never started).
  const coverageGaps = (groupCoverage ?? [])
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const group = asStringField(r.group);
      const missing = (asArray(r.missing) ?? [])
        .map((m) => asStringField(m))
        .filter((m): m is string => m !== null);
      const skipped = (asArray(r.skipped) ?? [])
        .map((s) => asStringField(s))
        .filter((s): s is string => s !== null);
      if (!group || (missing.length === 0 && skipped.length === 0)) return null;
      return { group, missing, skipped };
    })
    .filter(
      (entry): entry is { group: string; missing: string[]; skipped: string[] } => entry !== null,
    );

  return (
    <div className="flex flex-col gap-3">
      {nothingVerified ? (
        <div className="rounded-[3px] border border-yellow-300 bg-[#FFF4CC] px-3 py-2 font-body text-[13px] text-[#7A5A00]">
          Nothing was verified: no selected group ran.
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {outcome !== null ? <CkChip tone={scriptStatusTone(outcome)}>{outcome}</CkChip> : null}
        {ok !== null ? <CkChip tone={ok ? "success" : "failed"}>ok: {String(ok)}</CkChip> : null}
        {allPassed !== null ? (
          <CkChip tone={allPassed ? "success" : "warn"}>allPassed: {String(allPassed)}</CkChip>
        ) : null}
      </div>
      {summary ? <p className="m-0 font-body text-[12px] text-neutral-700">{summary}</p> : null}

      {groupStatuses && groupStatuses.length > 0 ? (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Groups ({groupStatuses.length})
          </div>
          <div className="flex flex-col gap-1">
            {groupStatuses.map((row, i) => {
              const r = asRecord(row);
              if (!r) return null;
              const provider = asStringField(r.provider);
              const repoPath = asStringField(r.repoPath);
              const group = asStringField(r.group);
              const status = asStringField(r.status);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 rounded-[3px] border border-neutral-200 bg-white px-2 py-1"
                >
                  <span className="min-w-0 truncate font-mono text-[11px] text-neutral-800">
                    {[provider, repoPath].filter(Boolean).join("/")} · {group ?? "n/a"}
                  </span>
                  <GroupStatusChip status={status} />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {coverageGaps.some((gap) => gap.missing.length > 0) ? (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Not declared here
          </div>
          <div className="flex flex-col gap-0.5">
            {coverageGaps
              .filter((gap) => gap.missing.length > 0)
              .map((gap) => (
                <div key={gap.group} className="font-mono text-[10px] text-neutral-500">
                  {gap.group}: not declared by {gap.missing.join(", ")} (ran nothing there)
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {coverageGaps.some((gap) => gap.skipped.length > 0) ? (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Not entered
          </div>
          <div className="flex flex-col gap-0.5">
            {coverageGaps
              .filter((gap) => gap.skipped.length > 0)
              .map((gap) => (
                <div key={gap.group} className="font-mono text-[10px] text-neutral-500">
                  {gap.group}: {gap.skipped.join(", ")} (repository was not part of this run)
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {results && results.length > 0 ? (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Results ({results.length})
          </div>
          <div className="flex flex-col gap-1.5">
            {results.map((row, i) => {
              const r = asRecord(row);
              if (!r) return null;
              const command = asStringField(r.command) ?? "";
              const group = asStringField(r.group);
              const repo = asStringField(r.repo);
              const exitCode = asNumberField(r.exitCode);
              const durationMs = asNumberField(r.durationMs);
              const timedOut = asBooleanField(r.timedOut) ?? false;
              const passed = !timedOut && exitCode === 0;
              return (
                <div key={i} className="rounded-[3px] border border-neutral-200 bg-white px-2 py-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-all font-mono text-[11px] text-neutral-900">
                      {command}
                    </span>
                    <span className="shrink-0">
                      <CkChip tone={timedOut ? "warn" : passed ? "success" : "failed"}>
                        {timedOut ? "timed out" : passed ? "passed" : `exit ${exitCode ?? "?"}`}
                      </CkChip>
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-500">
                    {repo ? <span>repo: {repo}</span> : null}
                    {group ? <span>group: {group}</span> : null}
                    {durationMs !== null ? <span>{fmtDurationMs(durationMs)}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {failures && failures.length > 0 ? (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Failures ({failures.length})
          </div>
          <div className="flex flex-col gap-1.5">
            {failures.map((row, i) => {
              const r = asRecord(row);
              if (!r) return null;
              const command = asStringField(r.command) ?? "";
              const repo = asStringField(r.repo);
              const exitCode = asNumberField(r.exitCode);
              const phase = asStringField(r.phase);
              const output = asStringField(r.output) ?? "";
              return (
                <div key={i} className="rounded-[3px] border border-red-200 bg-red-50 px-2 py-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-all font-mono text-[11px] text-red-900">
                      {command}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-red-700">
                      exit {exitCode ?? "?"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-red-700">
                    {repo ? <span>repo: {repo}</span> : null}
                    {phase ? <span>phase: {phase}</span> : null}
                  </div>
                  {output ? (
                    <pre className="m-0 mt-1.5 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-[#0E1014] p-2 font-mono text-[10px] leading-[1.5] text-neutral-300">
                      {output}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {dirtied && dirtied.length > 0 ? (
        <div>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">
            Dirtied repositories ({dirtied.length})
          </div>
          <div className="flex flex-col gap-1.5">
            {dirtied.map((row, i) => {
              const r = asRecord(row);
              if (!r) return null;
              const repo = asStringField(r.repo);
              const files = asArray(r.files) ?? [];
              const preExisting = asArray(r.preExisting) ?? [];
              return (
                <div key={i} className="rounded-[3px] border border-neutral-200 bg-white px-2 py-1.5">
                  <div className="font-mono text-[11px] text-neutral-900">{repo ?? "n/a"}</div>
                  {files.length > 0 ? (
                    <div className="mt-1 font-mono text-[10px] text-neutral-600">
                      changed: {files.map((f) => asStringField(f) ?? "").join(", ")}
                    </div>
                  ) : null}
                  {preExisting.length > 0 ? (
                    <div className="mt-0.5 font-mono text-[10px] text-neutral-500">
                      pre-existing: {preExisting.map((f) => asStringField(f) ?? "").join(", ")}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AttemptInspector({
  runId,
  attempts,
  selectedAttempt,
  selectedNodeType,
  onSelectAttempt,
  followingLatest,
  onFollowLatest,
  runIsLive,
}: {
  runId: string;
  attempts: WorkflowReplayAttemptSummary[];
  selectedAttempt: WorkflowReplayAttemptSummary | null;
  /** The selected node's block type, for the output tab's structured view.
   *  Absent when the graph snapshot hasn't loaded a type for this node. */
  selectedNodeType: WorkflowBlockType | undefined;
  onSelectAttempt: (attempt: WorkflowReplayAttemptSummary) => void;
  followingLatest: boolean;
  onFollowLatest: () => void;
  runIsLive: boolean;
}) {
  const [tab, setTab] = React.useState<ReplayTab>("output");
  const [detail, setDetail] =
    React.useState<WorkflowReplayAttemptDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestRef = React.useRef<AbortController | null>(null);
  const requestInFlightRef = React.useRef(false);

  const loadDetail = React.useCallback(async (reset: boolean) => {
    if (!selectedAttempt) {
      setDetail(null);
      return;
    }
    if (requestInFlightRef.current && !reset) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    requestInFlightRef.current = true;
    if (reset) setLoading(true);
    if (reset) {
      setDetail(null);
      setError(null);
    }
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(String(selectedAttempt.id))}`,
        { cache: "no-store", signal: controller.signal },
      );
      const result = replayAttemptDetailResult(
        response.status,
        response.ok ? await response.json().catch(() => null) : null,
      );
      if (result.error) throw new Error(result.error);
      // A momentary absence on a background tick (retention expiring mid-run, a
      // worker redeploy) must not wipe an already rendered panel.
      if (reset || result.detail !== null) setDetail(result.detail);
      // Cleared only once a response parsed, so a background tick can never
      // blank a rendered failure before its replacement arrives.
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Attempt detail is unavailable.",
      );
    } finally {
      if (requestRef.current === controller) {
        requestInFlightRef.current = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, [runId, selectedAttempt?.id, selectedAttempt?.state]);

  React.useEffect(() => {
    void loadDetail(true);
    return () => requestRef.current?.abort();
  }, [loadDetail]);

  useLivePoll({
    enabled: shouldPollAttemptDetail(selectedAttempt, runIsLive),
    intervalMs: LIVE_POLL_MS,
    onTick: () => {
      void loadDetail(false);
    },
  });

  const failureCause = selectedAttempt
    ? replayAttemptFailureCause(selectedAttempt)
    : null;
  const envelope =
    tab === "input"
      ? detail?.input
      : tab === "output"
        ? detail?.output
        : tab === "logs"
          ? detail?.logs
          : tab === "metadata"
            ? detail?.metadata
            : null;
  const isScriptBlock = isScriptBlockType(selectedNodeType);
  const envelopeRender = tab === "output" && isScriptBlock ? renderScriptOutput : undefined;

  return (
    <CkCard
      className="replay-inspector min-w-0 overflow-hidden"
      eyebrow="Sanitized observation"
      title={selectedAttempt ? displayAttempt(selectedAttempt) : "No attempt"}
      action={
        selectedAttempt ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {failureCause ? (
              <span className="font-mono text-[10px] text-fail-fg">
                {failureCause}
              </span>
            ) : null}
            {!followingLatest ? (
              <button
                type="button"
                onClick={onFollowLatest}
                className="rounded-[3px] border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-700 hover:bg-app-bg"
              >
                Follow latest
              </button>
            ) : null}
            <CkChip
              tone={
                selectedAttempt.state === "failed"
                  ? "failed"
                  : selectedAttempt.state === "completed"
                    ? "success"
                    : selectedAttempt.state === "running"
                      ? "running"
                      : "neutral"
              }
            >
              {selectedAttempt.state}
            </CkChip>
          </div>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <div
          className="max-w-full overflow-x-auto"
          data-replay-tabs="true"
        >
          <CkTabs
            tabs={[
              { id: "input", label: "Input" },
              { id: "output", label: "Output" },
              { id: "logs", label: "Logs" },
              { id: "metadata", label: "Metadata" },
              { id: "attempts", label: `Attempts (${attempts.length})` },
            ]}
            active={tab}
            onChange={(next) => setTab(next as ReplayTab)}
          />
        </div>
        {tab === "attempts" ? (
          <div className="flex max-h-[360px] flex-col gap-1 overflow-auto">
            {attempts.map((attempt) => (
              <button
                key={attempt.id}
                type="button"
                onClick={() => onSelectAttempt(attempt)}
                aria-pressed={selectedAttempt?.id === attempt.id}
                className={`flex items-center justify-between gap-3 rounded-[3px] border px-3 py-2 text-left font-mono text-[11px] ${
                  selectedAttempt?.id === attempt.id
                    ? "border-mariner bg-mariner-100 text-mariner"
                    : "border-neutral-200 bg-panel text-neutral-800 hover:bg-app-bg"
                }`}
              >
                <span className="min-w-0 truncate">
                  {displayAttempt(attempt)}
                </span>
                <span className="shrink-0">{displayDuration(attempt)}</span>
              </button>
            ))}
          </div>
        ) : loading ? (
          <div
            role="status"
            className="py-8 text-center font-body text-[13px] text-neutral-500"
          >
            Loading sanitized attempt…
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-[3px] border border-red-200 bg-red-50 px-3 py-2 font-body text-[13px] text-red-700"
          >
            {error}
          </div>
        ) : (
          <ReplayEnvelope
            envelope={envelope}
            emptyLabel={`No sanitized ${tab} was captured for this attempt.`}
            render={envelopeRender}
          />
        )}
      </div>
    </CkCard>
  );
}

export function WorkflowReplay({
  runId,
  initialResponse,
  onResponse,
  normalizeResponse,
}: {
  runId: string;
  initialResponse: WorkflowRunReplayResponse;
  onResponse?: (response: WorkflowRunReplayResponse) => void;
  /** Applies the owner's durable run lifecycle correction to a freshly polled
   * response, so a lagging replay status cannot re-arm the poll. */
  normalizeResponse?: (
    response: WorkflowRunReplayResponse,
  ) => WorkflowRunReplayResponse;
}) {
  const [response, setResponse] = React.useState(initialResponse);
  const [loadedOlder, setLoadedOlder] = React.useState(false);
  const [graphAttempts, setGraphAttempts] = React.useState(
    initialResponse.attempts,
  );
  const [graphLoadRequest, setGraphLoadRequest] = React.useState<{
    runId: string;
    cursor: string | null;
  }>({
    runId,
    cursor: initialResponse.nextCursor,
  });
  const [graphHistoryPartial, setGraphHistoryPartial] =
    React.useState(false);
  const loadedGraphRootCursorRef = React.useRef<string | null>(null);
  const refreshInFlightRef = React.useRef(false);
  const initialSelection = React.useMemo(
    () => replaySelectionForRun(initialResponse),
    [initialResponse],
  );
  const [selectedNodeId, setSelectedNodeId] =
    React.useState<string | null>(initialSelection.nodeId);
  const attemptsForNode = React.useMemo(
    () =>
      graphAttempts
        .filter((attempt) => attempt.nodeId === selectedNodeId)
        .sort(
          (left, right) =>
            compareReplayAttemptActivity(right, left),
        ),
    [graphAttempts, selectedNodeId],
  );
  const [selectedAttemptId, setSelectedAttemptId] = React.useState<
    number | null
  >(initialSelection.attemptId);
  const [followLatest, setFollowLatest] = React.useState(true);
  const selectedAttempt = selectReplayAttempt(
    attemptsForNode,
    selectedAttemptId,
    followLatest,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const graphHistoryComplete =
    graphLoadRequest.runId === runId &&
    graphLoadRequest.cursor === null &&
    !graphHistoryPartial;

  React.useEffect(() => {
    setResponse(initialResponse);
    setGraphAttempts((current) =>
      mergeReplayAttempts(current, initialResponse.attempts),
    );
    if (
      initialResponse.nextCursor &&
      loadedGraphRootCursorRef.current !== initialResponse.nextCursor
    ) {
      setGraphHistoryPartial(false);
      setGraphLoadRequest((current) =>
        current.runId === runId &&
        current.cursor === null
          ? { runId, cursor: initialResponse.nextCursor }
          : current,
      );
    }
  }, [initialResponse, runId]);

  React.useEffect(() => {
    setLoadedOlder(false);
    setGraphAttempts(initialResponse.attempts);
    setGraphHistoryPartial(false);
    loadedGraphRootCursorRef.current = null;
    setGraphLoadRequest({ runId, cursor: initialResponse.nextCursor });
    setFollowLatest(true);
    const selection = replaySelectionForRun(initialResponse);
    setSelectedNodeId(selection.nodeId);
    setSelectedAttemptId(selection.attemptId);
  }, [runId]);

  React.useEffect(() => {
    if (
      graphLoadRequest.runId !== runId ||
      graphLoadRequest.cursor === null
    ) {
      return;
    }
    const controller = new AbortController();
    void loadReplayAttemptSummaryTail({
      runId,
      cursor: graphLoadRequest.cursor,
      signal: controller.signal,
    })
      .then(({ attempts: olderAttempts, remainingCursor }) => {
        if (controller.signal.aborted) return;
        setGraphAttempts((current) =>
          mergeReplayAttempts(current, olderAttempts),
        );
        loadedGraphRootCursorRef.current = graphLoadRequest.cursor;
        setGraphHistoryPartial(remainingCursor !== null);
        setGraphLoadRequest({ runId, cursor: null });
      })
      .catch(() => {
        // Graph completion is best-effort. Live response polling and the
        // explicit history paginator remain usable if an older page fails.
      });
    return () => controller.abort();
  }, [graphLoadRequest, runId]);

  const refreshLiveReplay = React.useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const result = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/replay?limit=100`,
        { cache: "no-store" },
      );
      if (!result.ok) return;
      const polled = (await result.json()) as WorkflowRunReplayResponse;
      const fresh = normalizeResponse ? normalizeResponse(polled) : polled;
      onResponse?.(fresh);
      setGraphAttempts((current) =>
        mergeReplayAttempts(current, fresh.attempts),
      );
      if (
        fresh.nextCursor &&
        loadedGraphRootCursorRef.current !== fresh.nextCursor
      ) {
        setGraphHistoryPartial(false);
        setGraphLoadRequest((current) =>
          current.runId === runId &&
          current.cursor === null
            ? { runId, cursor: fresh.nextCursor }
            : current,
        );
      }
      setResponse((current) => ({
        ...fresh,
        attempts: mergeReplayAttempts(
          current.attempts,
          fresh.attempts,
        ),
        nextCursor: loadedOlder
          ? current.nextCursor
          : fresh.nextCursor,
      }));
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [loadedOlder, normalizeResponse, onResponse, runId]);

  const runIsLive = shouldPollReplay(response);

  useLivePoll({
    enabled: runIsLive,
    intervalMs: LIVE_POLL_MS,
    onTick: () => {
      void refreshLiveReplay();
    },
  });

  React.useEffect(() => {
    if (selectedNodeId === null) {
      const nextNodeId = initialReplayNodeId(response);
      if (nextNodeId !== null) setSelectedNodeId(nextNodeId);
    }
  }, [response, selectedNodeId]);

  React.useEffect(() => {
    if (followLatest) {
      setSelectedAttemptId(attemptsForNode[0]?.id ?? null);
    } else if (
      !attemptsForNode.some((attempt) => attempt.id === selectedAttemptId)
    ) {
      setFollowLatest(true);
      setSelectedAttemptId(attemptsForNode[0]?.id ?? null);
    }
  }, [attemptsForNode, followLatest, selectedAttemptId]);

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const latest = graphAttempts
      .filter((attempt) => attempt.nodeId === nodeId)
      .sort(
        (left, right) =>
          compareReplayAttemptActivity(right, left),
      )[0];
    setFollowLatest(true);
    setSelectedAttemptId(latest?.id ?? null);
  };

  const loadMore = async () => {
    if (!response.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/replay?limit=100&cursor=${encodeURIComponent(response.nextCursor)}`,
        { cache: "no-store" },
      );
      if (!next.ok) return;
      const page = (await next.json()) as WorkflowRunReplayResponse;
      setLoadedOlder(true);
      setGraphAttempts((current) =>
        mergeReplayAttempts(current, page.attempts),
      );
      setGraphHistoryPartial(false);
      setGraphLoadRequest({ runId, cursor: page.nextCursor });
      setResponse((current) => ({
        ...current,
        attempts: mergeReplayAttempts(current.attempts, page.attempts),
        nextCursor: page.nextCursor,
      }));
    } finally {
      setLoadingMore(false);
    }
  };

  if (!response.snapshot) {
    return (
      <CkCard eyebrow="Visual replay · read-only" title="Preparing replay">
        <div
          role="status"
          className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-3 font-body text-[13px] text-neutral-700"
        >
          Waiting for the sanitized workflow snapshot. This view will update
          automatically while the run is active.
        </div>
      </CkCard>
    );
  }

  const selectedNodeType = response.snapshot?.graph.nodes.find(
    (node) => node.id === selectedNodeId,
  )?.type;

  return (
    <div
      className="grid w-full min-w-0 max-w-full gap-3 overflow-hidden 2xl:grid-cols-[minmax(0,1.7fr)_minmax(360px,1fr)]"
      data-replay-root="true"
    >
      <CkCard
        className="min-w-0 overflow-hidden"
        eyebrow="Visual replay · read-only"
        title="Executed workflow"
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CkChip tone="success">{graphAttempts.length} attempts</CkChip>
            {graphLoadRequest.cursor !== null ? (
              <CkChip tone="neutral">loading recent history</CkChip>
            ) : graphHistoryPartial ? (
              <CkChip tone="neutral">partial history</CkChip>
            ) : null}
            {response.snapshot ? (
              <CkChip tone="neutral">
                definition v{response.snapshot.definitionVersion}
              </CkChip>
            ) : null}
          </div>
        }
        pad={12}
      >
        <ReplayCanvas
          response={response}
          graphAttempts={graphAttempts}
          graphHistoryComplete={graphHistoryComplete}
          selectedNodeId={selectedNodeId}
          onSelectNode={selectNode}
        />
        {response.nextCursor ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-[3px] border border-neutral-200 bg-panel px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.04em] text-neutral-800 hover:bg-app-bg disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load older attempts"}
            </button>
          </div>
        ) : null}
      </CkCard>
      <AttemptInspector
        runId={runId}
        attempts={attemptsForNode}
        selectedAttempt={selectedAttempt}
        selectedNodeType={selectedNodeType}
        runIsLive={runIsLive}
        followingLatest={followLatest}
        onFollowLatest={() => {
          setFollowLatest(true);
          setSelectedAttemptId(attemptsForNode[0]?.id ?? null);
        }}
        onSelectAttempt={(attempt) => {
          setFollowLatest(attempt.id === attemptsForNode[0]?.id);
          setSelectedAttemptId(attempt.id);
        }}
      />
    </div>
  );
}
