import { Buffer } from "node:buffer";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RunDetail, RunStep, WorkflowReplayAttemptSummary } from "@shared/contracts";

import { env } from "../../../env.js";
import { fetchRunDetailFromDb } from "../../db/queries/run-detail-read.js";
import { sanitizeRunDetailForResponse } from "../../lib/overview/sanitize-run-detail.js";
import {
  getRunReplay,
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
import { MCP_TOOL_CATALOG } from "../tool-catalog.js";

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
  const modelFallback = env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
  const loaded = await fetchRunDetailFromDb({
    db,
    runId,
    jiraBaseUrl: env.JIRA_BASE_URL,
    modelFallback,
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
  // and edge ids is not a guaranteed fit. Dropping outcome/selectedTransition
  // entirely makes the cap an actual invariant instead of a probabilistic one.
  return { ...withoutEdges, outcome: null, selectedTransition: null };
}

export function registerRunTools(server: McpServer, deps: McpToolDependencies): void {
  server.registerTool(
    "runs.get",
    MCP_TOOL_CATALOG["runs.get"],
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

  server.registerTool(
    "runs.trace",
    MCP_TOOL_CATALOG["runs.trace"],
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.trace",
        targetRefs: [input.runId],
        operation: async () => {
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
          return {
            availability: replay.availability,
            // Verbatim from getRunReplay, deliberately not recomputed:
            // run-observability/store.ts's own terminal check excludes
            // "awaiting" (contracts.ts documents the disagreement), while
            // this slice's isTerminalRunStatus includes it. An awaiting run
            // can therefore show mayAdvance: true here while runs.get
            // reports terminal: true for the same run. That mismatch is the
            // pre-existing repo disagreement, not a bug this tool should
            // paper over by inventing a second, competing definition.
            mayAdvance: replay.mayAdvance,
            snapshot: replay.snapshot,
            attempts: replay.attempts.map(trimAttemptForTrace),
            nextCursor: replay.nextCursor,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  server.registerTool(
    "runs.result",
    MCP_TOOL_CATALOG["runs.result"],
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.result",
        targetRefs: [input.runId],
        operation: async () => {
          const { run } = await loadSanitizedRun(deps.db, input.runId);
          const terminal = isTerminalRunStatus(run.status);
          return {
            runId: run.id,
            status: run.status,
            terminal,
            result: terminal
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

  server.registerTool(
    "runs.diagnose",
    MCP_TOOL_CATALOG["runs.diagnose"],
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
