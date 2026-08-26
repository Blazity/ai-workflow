import { Buffer } from "node:buffer";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
  JsonValue,
  ReplayAttemptOutcome,
  ReplaySanitizedEnvelope,
  RunDetail,
  RunStep,
  WorkflowReplayAttemptDetail,
  WorkflowReplayAttemptSummary,
} from "@shared/contracts";

import { env } from "../../../env.js";
import { fetchRunDetailFromDb } from "../../db/queries/run-detail-read.js";
import { sanitizeRunDetailForResponse } from "../../lib/overview/sanitize-run-detail.js";
import {
  getRunReplay,
  getRunReplayAttempt,
  getRunReplayAvailability,
  MAX_REPLAY_PAGE_LIMIT,
  RunObservationStoreError,
} from "../../run-observability/store.js";
import {
  McpPublicError,
  isTerminalRunStatus,
  type McpRunSummary,
  type McpToolDependencies,
} from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { diagnoseRun, type DiagnoseRunInput } from "../run-diagnosis.js";
import { registerCatalogTool } from "../tool-catalog.js";

// Flat interval, not a backoff curve: this slice has no per-run ETA to size
// anything smarter from. `terminal: true` (which, for MCP, includes
// "awaiting" -- see isTerminalRunStatus in contracts.ts) is what tells an
// agent to stop polling altogether, so a constant interval for the "keep
// checking" case is enough.
const RUN_POLL_INTERVAL_MS = 5_000;

function pollAfterMs(terminal: boolean): number | null {
  return terminal ? null : RUN_POLL_INTERVAL_MS;
}

/**
 * Shared load path for runs.get / runs.result / runs.diagnose. Durable-only
 * on purpose: this slice reads `workflow_runs` via fetchRunDetailFromDb, not
 * the live Vercel Workflow world the dashboard also merges in. Throws
 * NOT_FOUND for an unknown run id, the one thing all three tools need to
 * agree on. Sanitization happens here, once, so no caller can accidentally
 * feed raw (secret-bearing, prompt-injection-shaped) error text to
 * diagnoseRun or hand it back to the agent unredacted.
 */
async function loadSanitizedRun(
  db: McpToolDependencies["db"],
  runId: string,
): Promise<{ run: RunDetail; steps: RunStep[] }> {
  // No model fallback passed any more: AIW-253 made the run's model attribution
  // come from the live harness manifest instead of an env-derived guess, and
  // fetchRunDetailFromDb dropped the option. Passing one here would have been
  // silently ignored at runtime while claiming to influence the answer.
  const loaded = await fetchRunDetailFromDb({
    db,
    runId,
    jiraBaseUrl: env.JIRA_BASE_URL,
  });
  if (!loaded) throw new McpPublicError("NOT_FOUND", "Run not found", false);
  return sanitizeRunDetailForResponse({ run: loaded.run, steps: loaded.steps });
}

function toRunSummary(run: RunDetail): McpRunSummary {
  return {
    runId: run.id,
    workflowName: run.workflowName,
    status: run.status,
    terminal: isTerminalRunStatus(run.status),
    ticketKey: run.ticket ? run.ticket : null,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationSec: run.durationSec,
  };
}

// --- runs.trace paging ------------------------------------------------
//
// getRunReplay's own page limits (default 100, max 200, run-observability/
// store.ts) assume the caller enforces its own byte budget; MCP's envelope
// has a hard one (MCP_MAX_RESULT_BYTES) instead. A page's `attempts` carry
// `outcome.details`, arbitrary JSON that run-observability/sanitizer.ts
// bounds only by a ~2MB *traversal* budget, not a per-field byte cap, so a
// single attempt can already dwarf the whole envelope on its own.
//
// If that happens, sanitizeMcpData's fallback for an oversized envelope
// replaces `data` with a bare digest but keeps the same `nextCursor`
// pointing at the same (still oversized) page. An agent that follows it
// gets a truncated first page, follows the cursor expecting the rest, and
// keeps landing back on the one page that got thrown away -- with no way
// out, since re-requesting that cursor deterministically reproduces the
// same oversized page. Losing exactly that page is costly: it is usually
// where the run's first failed attempt lives.
//
// Both mechanisms below exist purely to keep a returned page under that
// fallback, never to rely on it: a page limit derived from (and smaller
// than) the byte budget, and a hard per-attempt byte cap enforced locally
// before the envelope is built.
const TRACE_ATTEMPT_MAX_BYTES = 8_192;
// Half the result budget is reserved for attempts; the rest is headroom for
// the envelope wrapper/meta and the one-time snapshot the first page (no
// cursor) also carries. The snapshot itself is bounded by run-observability/
// sanitizer.ts, not by this tool -- out of this slice's file scope.
const TRACE_PAGE_LIMIT = Math.max(
  1,
  Math.min(
    MAX_REPLAY_PAGE_LIMIT,
    Math.floor(env.MCP_MAX_RESULT_BYTES / 2 / TRACE_ATTEMPT_MAX_BYTES),
  ),
);

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const TRACE_DETAILS_OMITTED = "[omitted: exceeds the runs.trace page byte budget]";

// Room left for what sanitizeMcpData wraps around `data`: requestId, traceId,
// serverVersion, contractHash, trust, truncated, redactions, nextCursor and the
// JSON punctuation. Redaction can also lengthen a string ("Bearer x" becomes
// "Bearer [REDACTED]"), so the page is measured before redaction and this is the
// margin that keeps the measurement honest afterwards.
const TRACE_ENVELOPE_HEADROOM_BYTES = 8 * 1024;

/**
 * Keeps one attempt under TRACE_ATTEMPT_MAX_BYTES by dropping its least-
 * bounded fields first. Structural fields (state, ids, timestamps) survive
 * every step -- store.ts already bounds identifiers to <=200 characters --
 * because they are what makes an attempt findable in a follow-up call,
 * unlike its outcome detail or edge-id list.
 */
function trimAttemptForTrace(
  attempt: WorkflowReplayAttemptSummary,
): WorkflowReplayAttemptSummary {
  if (jsonByteLength(attempt) <= TRACE_ATTEMPT_MAX_BYTES) return attempt;

  const withoutDetails: WorkflowReplayAttemptSummary = attempt.outcome
    ? {
        ...attempt,
        outcome: {
          kind: attempt.outcome.kind,
          status: attempt.outcome.status,
          details: TRACE_DETAILS_OMITTED,
        },
      }
    : attempt;
  if (jsonByteLength(withoutDetails) <= TRACE_ATTEMPT_MAX_BYTES) return withoutDetails;

  const withoutEdges: WorkflowReplayAttemptSummary = withoutDetails.selectedTransition
    ? {
        ...withoutDetails,
        selectedTransition: { port: withoutDetails.selectedTransition.port, edgeIds: [] },
      }
    : withoutDetails;
  if (jsonByteLength(withoutEdges) <= TRACE_ATTEMPT_MAX_BYTES) return withoutEdges;

  // Last resort: outcome.status is itself an unbounded string (sanitizeReplay
  // AttemptOutcome passes any string through untouched), so dropping details
  // and edge ids is not a guaranteed fit. `outcome: null` would be a lie
  // though: per run-replay.ts that means "no outcome was recorded", which
  // reads as an observability gap, when the truth is that the outcome was too
  // large to show. So `kind` stays, being the smallest and most diagnostic
  // field of the three, and `status` carries the same marker the details path
  // already uses.
  return {
    ...withoutEdges,
    outcome: withoutEdges.outcome
      ? { kind: withoutEdges.outcome.kind, status: TRACE_DETAILS_OMITTED, details: null }
      : null,
    selectedTransition: null,
  };
}

// --- runs.logs --------------------------------------------------------
//
// The debug read. Where runs.get/result/diagnose go through loadSanitizedRun --
// which clamps the failure message (sanitizeFailureMessage) and carries no raw
// logs -- this one exposes the un-summarized detail. It does NOT re-implement
// redaction: every value it returns still passes executeMcpRead's sanitize step
// (sanitizeMcpData, with the configured secrets and the Bearer/GitHub/private-key
// patterns) on the way out, which strips tokens and counts them in
// meta.redactions. The observation envelopes were also already secret-redacted
// and byte-bounded once at capture (run-observability/sanitizer.ts). So the only
// thing lifted here is the lossy summarization, never the secret redaction.
//
// Each genuinely unbounded diagnostic field -- a stdout/stderr tail, a step I/O
// envelope, an outcome detail blob, the harness manifest -- is capped at 32 KB
// for the response and the truncation is REPORTED in the payload, not dropped
// silently. The stored envelopes are already capped at REPLAY_FIELD_MAX_BYTES
// (64 KB) each; this second, smaller cap keeps one attempt's four envelopes from
// crowding the rest of the response out of the result budget.
const RUNS_LOGS_FIELD_MAX_BYTES = 32 * 1024;
// The run-level attempt index drops the big outcome.details (it rides the
// per-attempt detail mode instead) but keeps outcome.status, itself an unbounded
// string, so the status is capped to keep the directory small.
const RUNS_LOGS_INDEX_STATUS_MAX = 512;
const RUNS_LOGS_TRUNCATION_MARKER = "…[truncated by runs.logs]";

function boundJsonValue(
  value: JsonValue,
  maxBytes: number,
): { value: JsonValue; truncated: boolean } {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  // Replaced with a bounded textual slice rather than structurally pruned: the
  // point is a hard byte ceiling that holds for any shape, and the caller learns
  // it happened from the `truncated` flag the payload reports alongside. Measure
  // the JSON-encoded result on every step so multibyte text and escaped characters
  // cannot make the returned value exceed that ceiling.
  const characters = Array.from(serialized);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters
      .slice(0, middle)
      .join("")}${RUNS_LOGS_TRUNCATION_MARKER}`;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return {
    value: `${characters.slice(0, low).join("")}${RUNS_LOGS_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function boundEnvelope(
  envelope: ReplaySanitizedEnvelope | null,
): { envelope: ReplaySanitizedEnvelope | null; truncated: boolean } {
  if (!envelope) return { envelope: null, truncated: false };
  const bounded = boundJsonValue(envelope.value, RUNS_LOGS_FIELD_MAX_BYTES);
  // The capture-time metadata is kept verbatim: its own redactions tally and
  // truncated flag are part of the debug picture (they say what the sink already
  // removed and shortened), distinct from this tool's response-side cap above.
  return {
    envelope: { value: bounded.value, metadata: envelope.metadata },
    truncated: bounded.truncated,
  };
}

function boundOutcome(
  outcome: ReplayAttemptOutcome | null,
): { outcome: ReplayAttemptOutcome | null; truncated: boolean } {
  if (!outcome || outcome.details === undefined) {
    return { outcome, truncated: false };
  }
  const bounded = boundJsonValue(outcome.details, RUNS_LOGS_FIELD_MAX_BYTES);
  return {
    outcome: { kind: outcome.kind, status: outcome.status, details: bounded.value },
    truncated: bounded.truncated,
  };
}

/** The lean directory an agent reads to pick an attempt `id` to drill into. The
 * unbounded outcome.details is deliberately absent (it rides the detail mode);
 * outcome.status is capped for the same reason. */
function toAttemptIndexEntry(attempt: WorkflowReplayAttemptSummary) {
  return {
    id: attempt.id,
    nodeId: attempt.nodeId,
    attempt: attempt.attempt,
    state: attempt.state,
    outcomeKind: attempt.outcome?.kind ?? null,
    outcomeStatus: attempt.outcome
      ? attempt.outcome.status.slice(0, RUNS_LOGS_INDEX_STATUS_MAX)
      : null,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    durationMs: attempt.durationMs,
    diagnosticId: attempt.diagnosticId,
  };
}

async function loadRunDebugOverview(
  deps: McpToolDependencies,
  runId: string,
  run: RunDetail,
) {
  const replay = await getRunReplay({
    db: deps.db,
    runId,
    organizationId: deps.actor.organizationId,
    limit: MAX_REPLAY_PAGE_LIMIT,
    cursor: null,
    now: deps.now(),
  });
  const snapshot = replay.snapshot;
  const manifest = boundEnvelope(snapshot?.runtimeManifest ?? null);
  return {
    runId: run.id,
    status: run.status,
    terminal: isTerminalRunStatus(run.status),
    // Verbatim, straight from fetchRunDetailFromDb: this path never calls
    // sanitizeRunDetailForResponse, so the failure reason is NOT clamped the way
    // runs.result reports it. Both are surfaced because they diverge for a run
    // whose status carries a reason but no RunError (a cancel, say).
    error: run.error,
    statusReason: run.statusReason,
    replay: {
      availability: replay.availability,
      manifest: manifest.envelope,
      manifestTruncated: manifest.truncated,
      capturedAt: snapshot?.capturedAt ?? null,
      expiresAt: snapshot?.expiresAt ?? null,
      definitionId: snapshot?.definitionId ?? null,
      definitionVersion: snapshot?.definitionVersion ?? null,
      attempts: replay.attempts.map(toAttemptIndexEntry),
      // The index page is capped at MAX_REPLAY_PAGE_LIMIT attempts; a non-null
      // cursor means older attempts exist, reachable via runs.trace.
      moreAttempts: replay.nextCursor !== null,
    },
  };
}

async function loadAttemptDebugDetail(
  deps: McpToolDependencies,
  runId: string,
  attemptId: number,
  run: RunDetail,
) {
  const availability = await getRunReplayAvailability({
    db: deps.db,
    runId,
    organizationId: deps.actor.organizationId,
    now: deps.now(),
  });
  const detail: WorkflowReplayAttemptDetail | null = await getRunReplayAttempt({
    db: deps.db,
    runId,
    organizationId: deps.actor.organizationId,
    attemptId,
    now: deps.now(),
  });
  if (!detail) {
    // The run exists (fetchRunDetailFromDb resolved it) but this attempt id is not
    // in its captured replay -- a wrong id, or a replay that is not_captured or
    // expired. `availability` says which, without faking an attempt.
    return { runId: run.id, attemptId, availability, attempt: null, truncation: null };
  }
  const input = boundEnvelope(detail.input);
  const output = boundEnvelope(detail.output);
  const logs = boundEnvelope(detail.logs);
  const metadata = boundEnvelope(detail.metadata);
  const outcome = boundOutcome(detail.outcome);
  return {
    runId: run.id,
    attemptId,
    availability,
    attempt: {
      id: detail.id,
      nodeId: detail.nodeId,
      attempt: detail.attempt,
      activationScopeId: detail.activationScopeId,
      state: detail.state,
      outcome: outcome.outcome,
      selectedTransition: detail.selectedTransition,
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      durationMs: detail.durationMs,
      diagnosticId: detail.diagnosticId,
      input: input.envelope,
      output: output.envelope,
      logs: logs.envelope,
      metadata: metadata.envelope,
    },
    truncation: {
      input: input.truncated,
      output: output.truncated,
      logs: logs.truncated,
      metadata: metadata.truncated,
      outcomeDetails: outcome.truncated,
    },
  };
}

export function registerRunTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "runs.get",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.get",
        targetRefs: [input.runId],
        operation: async () => {
          const { run } = await loadSanitizedRun(deps.db, input.runId);
          const summary = toRunSummary(run);
          return { ...summary, pollAfterMs: pollAfterMs(summary.terminal) };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "runs.trace",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.trace",
        targetRefs: [input.runId],
        operation: async () => {
          // Resolved first, and only for its existence and status: without this
          // a typo in runId answered with a successful "not_captured" page,
          // while runs.get, runs.result and runs.diagnose all answer NOT_FOUND
          // for the same id, so a caller was told the run exists but has no
          // trace. getRunReplay cannot tell those apart on its own.
          const { run } = await loadSanitizedRun(deps.db, input.runId);
          let replay;
          try {
            replay = await getRunReplay({
              db: deps.db,
              runId: input.runId,
              organizationId: deps.actor.organizationId,
              limit: TRACE_PAGE_LIMIT,
              cursor: input.cursor ?? null,
              now: deps.now(),
            });
          } catch (error) {
            if (error instanceof RunObservationStoreError && error.statusCode === 400) {
              throw new McpPublicError("VALIDATION_FAILED", "Invalid trace cursor", false);
            }
            throw error;
          }
          // Derived from isTerminalRunStatus, NOT passed through from
          // getRunReplay: run-observability/store.ts excludes "awaiting" from
          // its terminal set while this slice includes it, so the store would
          // report mayAdvance: true for a parked run that runs.get calls
          // terminal in the same conversation. contracts.ts freezes one
          // definition precisely so two tools cannot answer this differently.
          const mayAdvance = !isTerminalRunStatus(run.status);
          const page = {
            availability: replay.availability,
            mayAdvance,
            attempts: replay.attempts.map(trimAttemptForTrace),
            nextCursor: replay.nextCursor,
          };
          // The page has to fit the global result cap by itself. attempts are
          // bounded (TRACE_PAGE_LIMIT times TRACE_ATTEMPT_MAX_BYTES is half the
          // cap), snapshot is not: run-observability/sanitizer.ts admits a graph
          // and a layout at 512 KB each plus a 64 KB manifest, together more
          // than the whole MCP budget. Unbounded, sanitizeMcpData swaps the
          // entire data for a digest and still returns nextCursor, so the caller
          // gets an empty first page, follows that cursor and is told "Invalid
          // trace cursor" for a cursor this server issued: a dead end with the
          // first failed attempt inside the page it never saw. Dropping the
          // snapshot with an explicit marker keeps the page and the cursor
          // usable, and says which of the two happened.
          const snapshotBudget =
            env.MCP_MAX_RESULT_BYTES - jsonByteLength(page) - TRACE_ENVELOPE_HEADROOM_BYTES;
          const snapshotFits =
            replay.snapshot !== null && jsonByteLength(replay.snapshot) <= snapshotBudget;
          return {
            ...page,
            snapshot: snapshotFits ? replay.snapshot : null,
            snapshotOmitted: replay.snapshot !== null && !snapshotFits,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "runs.result",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.result",
        targetRefs: [input.runId],
        operation: async () => {
          const { run } = await loadSanitizedRun(deps.db, input.runId);
          const terminal = isTerminalRunStatus(run.status);
          // "awaiting" is terminal for polling, which contracts.ts freezes so an
          // agent stops instead of spinning to the timeout. It is NOT a finished
          // run: markRunAwaiting parks a live run that resumes once a human
          // answers and can still end as success. A populated result here would
          // carry error, prNumber and completedAt all null, which reads as
          // "finished, no error, no PR", so the caller would report the run as
          // done to the very person being waited on. There is no final outcome
          // yet, so this says so rather than inventing an empty one.
          const awaitingHumanInput = run.status === "awaiting";
          return {
            runId: run.id,
            status: run.status,
            terminal,
            awaitingHumanInput,
            result:
              terminal && !awaitingHumanInput
                ? {
                    error: run.error,
                    prNumber: run.prNumber,
                    prUrl: run.prUrl,
                    prs: run.prs,
                    completedAt: run.completedAt,
                    durationSec: run.durationSec,
                  }
                : null,
            pollAfterMs: pollAfterMs(terminal),
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "runs.diagnose",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.diagnose",
        targetRefs: [input.runId],
        operation: async () => {
          const { run, steps } = await loadSanitizedRun(deps.db, input.runId);
          const diagnoseInput: DiagnoseRunInput = {
            status: run.status,
            error: run.error ? { code: run.error.code, message: run.error.message } : null,
            steps: steps.map((step) => ({
              stepId: step.stepId,
              name: step.name,
              status: step.status,
              error: step.error ? { code: step.error.code, message: step.error.message } : null,
            })),
          };
          return diagnoseRun(diagnoseInput);
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}

/**
 * runs.logs registers on its own, called last (server.ts), for the same reason
 * runs.stats does: FIRST_SLICE_TOOLS appends it last, and the contract-artifact
 * test pins tools/list order against that array, so its registration has to land
 * after everything already registered. Kept in this file, not run-stats.ts,
 * because it shares this module's run-detail and replay reads.
 */
export function registerRunLogsTool(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "runs.logs",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.logs",
        targetRefs: [input.runId],
        operation: async () => {
          // fetchRunDetailFromDb, NOT loadSanitizedRun: this tool's whole purpose
          // is the un-clamped record, and fetchRunDetailFromDb builds run.error /
          // statusReason verbatim from the durable row (the clamp lives only in
          // sanitizeRunDetailForResponse). Resolved first so a bad runId answers
          // NOT_FOUND, exactly like every sibling run read.
          const loaded = await fetchRunDetailFromDb({
            db: deps.db,
            runId: input.runId,
            jiraBaseUrl: env.JIRA_BASE_URL,
          });
          if (!loaded) throw new McpPublicError("NOT_FOUND", "Run not found", false);
          return input.attemptId === undefined
            ? loadRunDebugOverview(deps, input.runId, loaded.run)
            : loadAttemptDebugDetail(deps, input.runId, input.attemptId, loaded.run);
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
