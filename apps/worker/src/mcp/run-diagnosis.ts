/**
 * Deterministic classifier for a run's status/likely cause.
 *
 * Security-critical: log, trace, and ticket content are UNTRUSTED and may
 * contain text trying to steer an agent reading it. This module never runs a
 * model over that content and never lets raw message/log text leave through
 * evidenceRefs or nextActions, only stable references (step ids, error
 * codes) and a fixed, code-owned set of action phrases. No IO, no runtime
 * state, no other src/mcp module.
 *
 * One import, on purpose. The per-category sentences this file matches on live
 * in exactly one table (`SAFE_EXECUTION_ERROR_MESSAGES` in
 * workflow-definition/interpreter.ts) and the repository enforces that with
 * `workflow-definition/execution-error-invariant.test.ts`: a copy of the table
 * is how the scheduler path once drifted into producing a right-looking
 * sentence while skipping derivation. Re-typing those sentences here to keep
 * the file import-free would recreate exactly that failure surface, and it
 * would rot silently the day one of them is reworded. Importing the table
 * costs nothing the security property above cares about, because that property
 * is about never letting UNTRUSTED text out, not about the import count.
 */

import { SAFE_EXECUTION_ERROR_MESSAGES } from "../workflow-definition/interpreter.js";

export type RunDiagnosisCategory =
  | "succeeded"
  | "running"
  | "awaiting_input"
  | "cancelled"
  | "never_started"
  | "no_workflow_matched"
  | "stopped_without_reason"
  | "dependency_auth"
  | "dependency_unavailable"
  | "sandbox_timeout"
  | "workspace_unavailable"
  | "workspace_gate"
  | "source_pull_request_moved"
  | "validation_failed"
  | "budget_exhausted"
  | "engine_error"
  | "step_failed"
  | "unknown";

export type RunDiagnosis = {
  category: RunDiagnosisCategory;
  confidence: "high" | "low";
  evidenceRefs: string[];
  nextActions: string[];
};

/** Matches what RunDetail/RunStep actually carry (@shared/contracts domain.ts:
 *  1, 141-145, 162-179), so a caller reading a run's status/error/steps needs
 *  no lossy adapter to call this. */
export interface DiagnoseRunInput {
  status: "success" | "running" | "failed" | "blocked" | "awaiting";
  error: { code?: string; message?: string } | null;
  steps: ReadonlyArray<{
    stepId: string;
    name: string;
    status: string;
    error?: { code?: string; message?: string } | null;
  }>;
}

/** Closed, code-owned action phrases per category. Never assembled from
 *  input data, so a poisoned message/log can never inject a phrase here. */
const NEXT_ACTIONS: Record<RunDiagnosisCategory, string[]> = {
  succeeded: ["No action needed; the run completed successfully."],
  running: ["Wait for the run to finish before taking further action."],
  awaiting_input: [
    "The run is parked waiting for human input; no failure occurred.",
    "Check whether it is waiting on a clarification answer or an approval decision; either needs a person to act before the run continues.",
  ],
  // Hedged on purpose. This category is reached from a "cancel" mention in
  // free operator text, so it always carries confidence "low", and the previous
  // wording ("No action needed; the run was cancelled intentionally.") stated a
  // substring match as established fact. A caller repeating that to a user would
  // close the case on a guess.
  cancelled: [
    "The recorded reason reads as an intentional cancellation, which usually needs no action.",
    "Confirm with runs.result before treating this as final; this category comes from the wording of the reason, not from a structural signal.",
  ],
  never_started: [
    "The run never started within the startup window; check dispatcher/worker health at the time.",
    "Re-dispatch the ticket once the underlying startup issue is resolved.",
  ],
  no_workflow_matched: [
    "Enable a workflow definition whose trigger matches this ticket (e.g. the AI column trigger).",
  ],
  stopped_without_reason: [
    "The run was most likely cancelled or swept up as an orphan; no failure was recorded.",
    "Check whether the ticket moved out of the AI column or the run's clarification/approval was superseded.",
  ],
  dependency_auth: [
    "Verify the AI provider API key is valid and has not expired or been revoked.",
  ],
  dependency_unavailable: [
    "Retry the run after a short delay.",
    "Check the AI provider's status page for ongoing incidents.",
  ],
  sandbox_timeout: [
    "Retry the run; narrow its scope so it finishes inside the time budget.",
    "Check whether the sandbox or a workflow step is unusually slow.",
  ],
  workspace_unavailable: [
    "Retry the run; the sandbox/workspace environment could not complete the block.",
    "Check sandbox provisioning health if this recurs across runs.",
  ],
  workspace_gate: [
    "Re-run the pre-publication checks before retrying publication.",
    "Confirm the run workspace was not modified after checks passed.",
  ],
  source_pull_request_moved: [
    "Someone other than this run pushed to the pull request, or retargeted it, while the run was working.",
    "Re-read the pull request's own commit history; the run's work was not published.",
  ],
  validation_failed: [
    "Review the block or trigger configuration that produced the invalid output.",
    "Check for a recent breaking change to the workflow definition.",
  ],
  budget_exhausted: [
    "The run stopped after exhausting its configured budget, not from a failure.",
    "Raise the workflow's budget limit or narrow the ticket's scope before retrying.",
  ],
  engine_error: [
    "Check the workflow definition graph for an unresolvable trigger, node, or edge.",
  ],
  step_failed: [
    // Deliberately does NOT send the caller to look the reference up in the
    // trace. evidenceRefs carry step identifiers from the run detail world
    // ("phase:<name>" or a workflow step id), while runs.trace describes
    // attempts by nodeId, a numeric id and a diagnosticId. Those namespaces do
    // not intersect, so the old wording promised a lookup that always fails.
    // Aligning them needs one shared identifier space and is a follow-up.
    "Read the failing step's own reason with runs.result; evidenceRefs names that step, and its identifiers are not the ones runs.trace uses.",
    "This confirms a step failed, not why; some causes (a gate, a budget stop) should not simply be retried.",
  ],
  unknown: [
    "Fetch the attempts with runs.trace and the recorded reason with runs.result; no automated diagnosis matched.",
  ],
};

// A "cancel" mention in the reason. No exact system-owned sentence here (unlike
// the other message rules below): the dashboard's durable statusReason column
// carries free-form operator/reconciler text (e.g. "Orphaned run cancelled by
// reconciler", "Cancelled via Slack /ai-workflow cancel"), so this can only ever
// be low confidence, and only fires for the "blocked" status that carries it.
// DiagnoseRunInput's status union has no "cancelled" member (RunStatus,
// @shared/contracts domain.ts:1, has none either; STATUS_MAP, lib/overview/
// collect-run-detail.ts:65-71, maps the raw world "cancelled" to "blocked"), so
// do not add a structured high-confidence rule keyed on a "cancelled" status.
const CANCELLED_REASON_PATTERN = /cancel/i;

// STARTUP_TIMEOUT_REASON (lib/run-start-lifecycle.ts:16-17), written verbatim
// as statusReason by markStartupFailure (run-start-lifecycle.ts:364-379), which
// sets status "failed". The run never started, so `steps` is empty by
// construction; no status/step guard is required to keep this precise, since
// the sentence is unique to this one path.
const NEVER_STARTED_MESSAGE = "Workflow did not start within 10 minutes.";

// NO_DEFINITION_BLOCKED_REASON (lib/run-start-lifecycle.ts:153-154), recorded
// with status "blocked" (run-start-lifecycle.ts:190-192).
const NO_WORKFLOW_MATCHED_MESSAGE =
  "No enabled workflow definition currently handles the trigger_ticket_ai trigger, so this ticket was never picked up. Enable a workflow definition whose trigger is the AI column.";

// leak-review.ts:668-674 sets an explicit options.message overriding the
// generic "checks" category sentence, so it needs its own rule.
const LEAK_REVIEW_GATE_PREFIX = "Leak review blocked publication before the branch was pushed:";

// Prefix produced by SAFE_EXECUTION_ERROR_MESSAGES.checks (workflow-definition/
// interpreter.ts:95) whenever a block reports `category: "checks"`. The pre-pr-gate
// failure (AIW-223) is one of two sources of that category; the other is an
// unrelated unmet-checks message, so a keyword from the WorkspaceGateError
// messages (workflows/workspace-gate.ts:122-137) is required too.
const WORKSPACE_GATE_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.checks;
const WORKSPACE_GATE_KEYWORDS = ["Run Workspace", "pre-publication check"];
// The staleness guards wrap their reason inside an external-service failure, so
// prefix matching alone routes them to dependency_unavailable and tells the
// reader to check the AI provider's status page. Nothing about them is a
// dependency.
const SOURCE_PULL_REQUEST_MOVED_KEYWORDS = [
  "stale PR/MR head",
  "stale PR/MR target",
  "remote branch moved",
];

// "Run stopped on budget: <reason>", set as statusReason for a "failed" run
// stopped by a budget check (workflows/agent.ts:2537-2543).
const BUDGET_EXHAUSTED_PREFIX = "Run stopped on budget:";

// fallbackTerminalError's "blocked" lead (lib/overview/sanitize-run-detail.ts:
// 104-113): the observed face of three silent stop paths that record no
// statusReason: markRunBlockedOnCancel and sweepOrphanedAwaitingRuns
// (lib/telemetry/run-telemetry.ts:528-533, 581-602) and
// retireClarificationForGoneTicket (clarifications/answer-core.ts:111-119).
const STOPPED_WITHOUT_REASON_PREFIX =
  "This run was stopped before it finished, but no specific reason was recorded.";

// Generic sentences for schema/contract failures: SAFE_EXECUTION_ERROR_MESSAGES.schema
// (workflow-definition/interpreter.ts:94, used by interpreter.ts:439 contractViolation
// and block output validation) and the agent-protocol schema_mismatch message
// (sandbox/agents/protocol.ts:211). Also SAFE_EXECUTION_ERROR_MESSAGES.binding
// (interpreter.ts:91, an unresolvable block input reference: a workflow-definition
// configuration defect) and .parsing (interpreter.ts:93, an unparsable response).
const VALIDATION_FAILED_PREFIXES = [
  SAFE_EXECUTION_ERROR_MESSAGES.schema,
  "The current agent phase returned an invalid structured response.",
  SAFE_EXECUTION_ERROR_MESSAGES.binding,
  SAFE_EXECUTION_ERROR_MESSAGES.parsing,
];

// Curated PROVIDER_CAUSES sentence for an AI-provider auth rejection
// (workflow-definition/failure-message.ts:100-105). classifyProviderFailure
// gives this trusted match first shot at the raw provider error text, so this
// rule matches ONLY the sentence it already decided on, never the raw text.
const DEPENDENCY_AUTH_PREFIX =
  "The AI provider rejected the credentials (authentication failed).";

// The other PROVIDER_CAUSES sentences (workflow-definition/failure-message.ts:
// 90-113): billing/credit, rate limit, model unavailable, and overloaded. Plus
// SAFE_EXECUTION_ERROR_MESSAGES.provider (interpreter.ts:89), the uncurated
// fallback for a "provider"-category failure that matched none of those. Plus
// the agent-CLI runtime-prep/execution sentences set directly as
// `options.message` (protocol.ts:122/131/243/418 "The agent runtime could not
// be prepared."; protocol.ts:173/185 "The current agent phase could not be
// completed."): both are AgentRuntimeError category "provider" (sandbox/agents/
// types.ts:467), and the exposed text cannot distinguish "missing credentials"
// from "CLI install/exit failed", so they land here rather than under
// dependency_auth. All describe an external/tooling dependency being
// unreachable or broken right now, distinct from a rejected credential.
const DEPENDENCY_UNAVAILABLE_PREFIXES = [
  "The AI provider rejected the request: the account credit or billing balance is too low.",
  "The AI provider rate-limited the request.",
  "The requested AI model is unavailable or access is denied.",
  "The AI provider is overloaded.",
  SAFE_EXECUTION_ERROR_MESSAGES.provider,
  "The agent runtime could not be prepared.",
  "The current agent phase could not be completed.",
];

// SAFE_EXECUTION_ERROR_MESSAGES.timeout (workflow-definition/interpreter.ts:92),
// composed whenever a block reports `category: "timeout"` (e.g. workflows/blocks/
// generic-agent.ts:470, workflows/agent.ts:4396-4398).
const SANDBOX_TIMEOUT_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.timeout;

// SAFE_EXECUTION_ERROR_MESSAGES.sandbox (interpreter.ts:88), the generic
// "sandbox"-category sentence (e.g. workflows/blocks/prepare-workspace.ts's
// outer catches, `category: "sandbox"`).
const WORKSPACE_UNAVAILABLE_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.sandbox;

// SAFE_EXECUTION_ERROR_MESSAGES.engine (interpreter.ts:90), used for
// engine-level failures (e.g. an unresolvable entry trigger or waiting node,
// interpreter.ts:409-422).
const ENGINE_ERROR_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.engine;

/** Stable references only: stepId of steps that failed, plus their error
 *  codes and the run-level error code when present. Never message/log text. */
function evidenceFrom(input: DiagnoseRunInput): string[] {
  const refs: string[] = [];
  for (const step of input.steps) {
    if (step.status !== "failed") continue;
    refs.push(step.stepId);
    if (step.error?.code) refs.push(step.error.code);
  }
  if (input.error?.code) refs.push(input.error.code);
  return refs;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

type RuleMatch = { confidence: "high" | "low"; evidenceRefs: string[] };

interface Rule {
  category: RunDiagnosisCategory;
  match(input: DiagnoseRunInput): RuleMatch | null;
}

/**
 * Ordered classification rules; the first match wins. Order is part of the
 * contract (see module doc), so it is captured here as data rather than as an
 * if/else chain scattered through diagnoseRun.
 *
 * Order: non-error statuses (structured, high) -> message rules from most to
 * least specific (structured status guard where one exists, always low
 * confidence) -> generic SAFE_EXECUTION_ERROR_MESSAGES-based message rules
 * (low) -> step_failed (structural, high, placed last so it never shadows a
 * more specific message-based classification) -> unknown.
 */
const RULES: readonly Rule[] = [
  {
    category: "running",
    match: (input) => (input.status === "running" ? { confidence: "high", evidenceRefs: [] } : null),
  },
  {
    category: "succeeded",
    match: (input) => (input.status === "success" ? { confidence: "high", evidenceRefs: [] } : null),
  },
  {
    category: "awaiting_input",
    match: (input) => (input.status === "awaiting" ? { confidence: "high", evidenceRefs: [] } : null),
  },
  {
    category: "never_started",
    match: (input) => {
      if (input.status !== "failed") return null;
      const message = input.error?.message;
      if (!message || !message.startsWith(NEVER_STARTED_MESSAGE)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "no_workflow_matched",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(NO_WORKFLOW_MATCHED_MESSAGE)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "workspace_gate",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(LEAK_REVIEW_GATE_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "budget_exhausted",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(BUDGET_EXHAUSTED_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "cancelled",
    match: (input) => {
      if (input.status !== "blocked") return null;
      const message = input.error?.message;
      if (!message || !CANCELLED_REASON_PATTERN.test(message)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "stopped_without_reason",
    match: (input) => {
      if (input.status !== "blocked") return null;
      const message = input.error?.message;
      if (!message || !message.startsWith(STOPPED_WITHOUT_REASON_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "workspace_gate",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(WORKSPACE_GATE_PREFIX)) return null;
      if (!WORKSPACE_GATE_KEYWORDS.some((keyword) => message.includes(keyword))) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "source_pull_request_moved",
    match: (input) => {
      const message = input.error?.message;
      if (!message) return null;
      if (!SOURCE_PULL_REQUEST_MOVED_KEYWORDS.some((keyword) => message.includes(keyword))) {
        return null;
      }
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "validation_failed",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !startsWithAny(message, VALIDATION_FAILED_PREFIXES)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "dependency_auth",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(DEPENDENCY_AUTH_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "dependency_unavailable",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !startsWithAny(message, DEPENDENCY_UNAVAILABLE_PREFIXES)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "sandbox_timeout",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(SANDBOX_TIMEOUT_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "workspace_unavailable",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(WORKSPACE_UNAVAILABLE_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "engine_error",
    match: (input) => {
      const message = input.error?.message;
      if (!message || !message.startsWith(ENGINE_ERROR_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    // Placed after every message rule above: most block failures return an
    // executionError rather than throwing (the WDK step itself completes; only
    // the later `throw new WorkflowExecutionError`, agent.ts:2913, fails the
    // run), so a genuinely "failed" step is a narrow case, not a broad
    // catch-all, and must never shadow a more specific message-based
    // classification for the same failure.
    category: "step_failed",
    match: (input) => {
      const hasFailedStep = input.steps.some((step) => step.status === "failed");
      if (!hasFailedStep) return null;
      return { confidence: "high", evidenceRefs: evidenceFrom(input) };
    },
  },
];

export function diagnoseRun(input: DiagnoseRunInput): RunDiagnosis {
  for (const rule of RULES) {
    const hit = rule.match(input);
    if (hit) {
      return {
        category: rule.category,
        confidence: hit.confidence,
        evidenceRefs: hit.evidenceRefs,
        // Copy, not the shared constant array: callers must not be able to
        // mutate NEXT_ACTIONS and poison every later call in this process.
        nextActions: [...NEXT_ACTIONS[rule.category]],
      };
    }
  }
  // evidenceFrom, not an empty list: no rule matching does not mean there is
  // nothing to hand over. The run's own diagnostic code is available here and
  // was being thrown away, so the caller was told "no cause found" while
  // runs.result returned a readable reason for the same run.
  return {
    category: "unknown",
    confidence: "low",
    evidenceRefs: evidenceFrom(input),
    nextActions: [...NEXT_ACTIONS.unknown],
  };
}
