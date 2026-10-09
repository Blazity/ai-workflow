/**
 * Deterministic classifier for a run's status/likely cause.
 *
 * Security-critical: log, trace, and ticket content are UNTRUSTED and may
 * contain text trying to steer an agent reading it. This module never runs a
 * model over that content and never lets raw message/log text leave through
 * evidenceRefs or nextActions, only stable references (step ids, error
 * codes) and a fixed, code-owned set of action phrases. No IO, no runtime
 * state.
 *
 * Five value imports, on purpose (the first import is type-only and is
 * erased). Two are stop sentences, engine/support/ticket-left-column.ts and
 * engine/support/pull-request-moved-on.ts, pure text and codes whose reader
 * belongs next to its writer for the reason given below.
 * One is isRunCompletionPending from this
 * cluster's own contracts module, which is a pure predicate over three fields
 * and side-effect free: `completion_fields_pending` has to answer exactly what
 * `completionPending` answers on runs.get, runs.result and tickets.list_runs,
 * and a second copy of that rule here is how the two would come to disagree
 * about the same run. The other two are of one kind: the per-category
 * sentences this file matches on live in exactly one place each
 * (`SAFE_EXECUTION_ERROR_MESSAGES` in packages/workflow-graph/interpreter.ts and
 * the curated provider sentences read through `curatedProviderFailureOf` beside
 * them, the repository scripts classes in engine/blocks/support/repository-
 * scripts-output.ts) and the repository enforces the first with
 * `engine/execution-error-invariant.test.ts`: a copy of the table
 * is how the scheduler path once drifted into producing a right-looking
 * sentence while skipping derivation. Re-typing those sentences here to keep
 * the file import-free would recreate exactly that failure surface, and it
 * would rot silently the day one of them is reworded. Importing the table
 * costs nothing the security property above cares about, because that property
 * is about never letting UNTRUSTED text out, not about the import count.
 */

import type { IntegrationUnavailableReason, RunFailureCode } from "@shared/contracts";
import {
  curatedProviderFailureOf,
  SAFE_EXECUTION_ERROR_MESSAGES,
  WORKSPACE_GATE_NOT_RECORDED_PREFIX,
  type ProviderAccount,
  type ProviderFailureCause,
} from "@shared/workflow-graph";
import {
  isRepositoryScriptsRefusal,
  REPOSITORY_SCRIPTS_SETUP_FAILED_PREFIX,
} from "../../engine/blocks/support/repository-scripts-output.js";
import {
  isLeftColumnReason,
  isPrematureReviewReason,
} from "../../engine/support/ticket-left-column.js";
import {
  pullRequestMovedOnKind,
  SUPERSEDED_BY_NEWER_COMMIT,
  type PullRequestMovedOn,
} from "../../engine/support/pull-request-moved-on.js";
import { isRunCompletionPending } from "./contracts.js";


type RunDiagnosisCategory =
  | "completion_fields_pending"
  | "integration_unavailable"
  | "succeeded"
  | "running"
  | "awaiting_input"
  | "cancelled"
  | "never_started"
  | "no_workflow_matched"
  | "stopped_without_reason"
  | "ticket_left_trigger_column"
  | "ticket_moved_to_review_early"
  | "pull_request_moved_on"
  | "provider_account"
  | "dependency_auth"
  | "dependency_unavailable"
  | "sandbox_timeout"
  | "workspace_unavailable"
  | "workspace_gate"
  | "repository_scripts_failed"
  | "source_pull_request_moved"
  | "validation_failed"
  | "budget_exhausted"
  | "engine_stalled"
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
  completedAt?: string | null;
  /** The row's workflow id and whether its end-of-run write has landed: the two
   *  inputs isRunCompletionPending reads. Required, and required together: a
   *  default for either would decide the completion_fields_pending rule from
   *  the absence of an argument rather than from the run, which is how a caller
   *  that forgot one would silently get a confident wrong category. */
  workflowId: string | null;
  usageRecorded: boolean;
  error: { code?: string; message?: string } | null;
  /**
   * The durable machine-readable cause, when the run recorded one
   * (`workflow_runs.status_reason_code`, ADR-010 S4). Distinct from
   * `error.code`, which is the execution error a block reported: this one is
   * the answer the run itself was closed with, and it is a closed set rather
   * than free text, which is why the rule that reads it is the only
   * high-confidence rule in this file that looks at a failure at all.
   */
  failureCode?: RunFailureCode | null;
  steps: ReadonlyArray<{
    stepId: string;
    name: string;
    status: string;
    error?: { code?: string; message?: string } | null;
  }>;
}

/** The half of every account answer that tells the reader it is not their bug. */
const RERUN_AFTER_ACCOUNT_FIX =
  "Nothing is wrong with the ticket or the workflow: rerun once the account is fixed, and a rerun before that fails the same way.";

/** Closed, code-owned action phrases per category. Never assembled from
 *  input data, so a poisoned message/log can never inject a phrase here. */
const NEXT_ACTIONS: Record<RunDiagnosisCategory, string[]> = {
  // Overridden per reason by INTEGRATION_UNAVAILABLE_ACTIONS below, which is
  // where the three cases differ; this is the answer shared by all of them.
  integration_unavailable: [
    "An integration this workflow uses was not usable, so the run stopped instead of skipping the step.",
    "Read system.capabilities for which integrations this deployment has and what state they are in; connecting, enabling and configuring one is a dashboard action a person has to take.",
  ],
  completion_fields_pending: [
    "Completion fields are pending; read runs.result again before relying on pull request data.",
    "If the fields remain pending, inspect worker logs for run_completion_telemetry_persist_failed with this run id.",
  ],
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
  // Overridden per match by leftColumnActions, which adds the moment; this is
  // the answer for a run whose completion time was never recorded.
  ticket_left_trigger_column: [
    "Stopped because the ticket left the trigger column: a person moved it, so nothing failed.",
    "To run it again, move the ticket back into the trigger column; a new run starts from the beginning.",
  ],
  // Overridden per match by reviewTooEarlyActions, which adds the moment.
  ticket_moved_to_review_early: [
    "Stopped because the ticket was moved to the review column before this run had published a pull request: a person moved it, so nothing failed.",
    "To have the work done, move the ticket back into the trigger column; a new run starts from the beginning.",
  ],
  // Overridden per case by PULL_REQUEST_MOVED_ON_ACTIONS; this is the answer
  // for the dispatcher's own stop of a superseded run, which records no code.
  pull_request_moved_on: [
    "Stopped because the pull request got a newer commit while this run was working on an older one: nothing failed.",
    "Nothing to retry: the newer commit is handled by its own run when the workflow starts on pull request updates.",
  ],
  // Overridden per cause and account by providerAccountActions.
  provider_account: [
    "An AI provider account refused the run; an admin of that account has to act (credit, spend limit or plan).",
    RERUN_AFTER_ACCOUNT_FIX,
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
  // The scripts block reports "ok" for any run that reached a command, whatever
  // the commands said: "failed" is reserved for a block that could not run at
  // all (engine/agent-workflow.ts repositoryScriptsStatus). Reading the status alone
  // therefore says a script failure did not happen, so these actions send the
  // reader to the record that does carry the verdict.
  repository_scripts_failed: [
    "Open the run trace: the scripts block output in the run trace lists every command with its exit code and output tail.",
    "Fix the failing command, or its entry on the Repository scripts screen, then run the workflow again.",
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
  engine_stalled: [
    "The watchdog marked this run failed after a workflow step stopped making progress.",
    "Inspect the named step and worker or sandbox health before retrying the run.",
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
// @shared/contracts domain.ts:21, has none either; STATUS_MAP, engine/support/
// collect-run-detail.ts:67-73, maps the raw world "cancelled" to "blocked"), so
// do not add a structured high-confidence rule keyed on a "cancelled" status.
const CANCELLED_REASON_PATTERN = /cancel/i;

// STARTUP_TIMEOUT_REASON (services/run-lifecycle/run-start-lifecycle.ts:25),
// written verbatim as statusReason by the startup sweep's persistence.markFailure
// call (run-start-lifecycle.ts:285), which
// sets status "failed". The run never started, so `steps` is empty by
// construction; no status/step guard is required to keep this precise, since
// the sentence is unique to this one path.
const NEVER_STARTED_MESSAGE = "Workflow did not start within 10 minutes.";

// NO_DEFINITION_BLOCKED_REASON (services/run-lifecycle/run-start-lifecycle.ts:150),
// recorded with status "blocked" by the insert in db/repositories/runs/startup.ts:156.
const NO_WORKFLOW_MATCHED_MESSAGE =
  "No enabled workflow definition currently handles the trigger_ticket_ai trigger, so this ticket was never picked up. Enable a workflow definition whose trigger is the AI column.";

// engine/blocks/leak-review/execute.ts:665 sets an explicit options.message overriding the
// generic "checks" category sentence, so it needs its own rule.
const LEAK_REVIEW_GATE_PREFIX = "Leak review blocked publication before the branch was pushed:";

// Prefix produced by SAFE_EXECUTION_ERROR_MESSAGES.checks
// (packages/workflow-graph/interpreter.ts) whenever a block reports
// `category: "checks"`. The pre-pr-gate failure (AIW-223) is one of two sources
// of that category; the other is an unrelated unmet-checks message, so a keyword
// from the WorkspaceGateError messages (engine/steps/workspace-gate.ts:290 and
// :327) is required too.
const WORKSPACE_GATE_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.checks;
const WORKSPACE_GATE_KEYWORDS = ["Run Workspace", "pre-publication check"];
// The gate having no record leads with its own sentence rather than the checks
// one (UP-4847): the gate record is what is missing, and the scripts may well
// have passed. Same category, its own lead, so the prefix rule above cannot see
// it and it needs one of its own. There are two such leads (the second fires
// when the scripts DID report failures), so this matches their shared opening
// rather than either sentence.

// The two ways a repository scripts verdict ends a run, both system-composed
// and neither of them the gate. finalize_workspace refuses an unmet `checks.*`
// input with the first (engine/blocks/finalize-workspace/execute.ts), and a scripts
// block that could not run at all throws the second (prePrChecksFailureReport,
// engine/helpers/repository-failure.ts:147, reached through
// engine/steps/repository-failure.ts:32). Matched as substrings, not prefixes: both are
// wrapped in a category lead before they reach a run reason.
const REPOSITORY_SCRIPTS_KEYWORDS = [
  "required checks not satisfied",
  "The repository scripts step failed:",
];

/** Setup provisions the workspace before any agent runs, so it fails in a
 *  different block from the scripts and needs actions of its own: nothing about
 *  a missing toolchain is answered by reading a check's output tail. */
const REPOSITORY_SCRIPTS_SETUP_ACTIONS = [
  "Fix the setup command on the Repository scripts screen; setup runs when the workspace is created, before any agent.",
  "The failing setup command, its exit code and its output tail are in the ticket comment this run posted.",
];
// No action names a node label or a board column: a definition names its nodes
// whatever it likes, and a pull-request run has no ticket column to move back
// to, so "move the ticket back to the AI column" was an instruction that either
// did nothing or bounced a claimed ticket.
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
// stopped by a budget check (engine/agent-workflow.ts).
const BUDGET_EXHAUSTED_PREFIX = "Run stopped on budget:";

// WATCHDOG_FAILURE_REASON_PREFIX (db/repositories/runs/telemetry.ts:117), written
// only by the engine-stall watchdog as a durable failed-run reason.
const ENGINE_STALLED_PREFIX = "Run engine stalled:";

// fallbackTerminalError's "blocked" lead (engine/support/sanitize-run-detail.ts:
// 106): the observed face of three silent stop paths that record no
// statusReason: markRunBlockedOnCancel and sweepOrphanedAwaitingRuns
// (db/repositories/runs/telemetry.ts:661 and :821) and
// retireClarificationForGoneTicket (services/clarifications/retirement.ts).
const STOPPED_WITHOUT_REASON_PREFIX =
  "This run was stopped before it finished, but no specific reason was recorded.";

// Generic sentences for schema/contract failures: SAFE_EXECUTION_ERROR_MESSAGES.schema
// (packages/workflow-graph/interpreter.ts, used wherever the scheduler rejects
// a block output against its contract) and the agent-protocol schema_mismatch
// message (sandbox/agents/protocol.ts, validateStructuredValue). Also
// SAFE_EXECUTION_ERROR_MESSAGES.binding (an unresolvable block input reference:
// a definition configuration defect) and .parsing (an unparsable response),
// both from the same table.
const VALIDATION_FAILED_PREFIXES = [
  SAFE_EXECUTION_ERROR_MESSAGES.schema,
  "The current agent phase returned an invalid structured response.",
  SAFE_EXECUTION_ERROR_MESSAGES.binding,
  SAFE_EXECUTION_ERROR_MESSAGES.parsing,
];

// The curated provider sentences (packages/workflow-graph/failure-message.ts,
// PROVIDER_CAUSES) are read through curatedProviderFailureOf, which matches the
// leads that table itself produces, named after an account or not, and the
// unnamed ones are the sentences runs recorded before accounts were named. So
// this file holds no copy of them: a copy is how a reworded sentence once went
// on being produced while its rule matched nothing.
//
// The remaining prefixes: SAFE_EXECUTION_ERROR_MESSAGES.provider (same table as
// the other generic sentences), the uncurated fallback for a "provider"-category
// failure that matched no curated cause, plus the agent-CLI runtime-prep and
// execution sentences set directly as `options.message` (protocol.ts "The agent
// runtime could not be prepared." and "The current agent phase could not be
// completed."): both are AgentRuntimeError (sandbox/agents/runtime-error.ts)
// with category "provider" (AgentProtocolFailureCategory, sandbox/agents/
// types.ts), and the exposed text cannot distinguish "missing credentials" from
// "CLI install/exit failed", so they land here rather than under
// dependency_auth. All describe an external/tooling dependency being
// unreachable or broken right now, distinct from a rejected credential.
const DEPENDENCY_UNAVAILABLE_PREFIXES = [
  SAFE_EXECUTION_ERROR_MESSAGES.provider,
  "The agent runtime could not be prepared.",
  "The current agent phase could not be completed.",
];

/**
 * What to do about an account the provider refused on, per cause and account.
 *
 * The account comes out of the curated sentence, and it is one of two names this
 * build owns, so naming it here is naming a member of a closed set, not copying
 * run text into an action.
 */
function providerAccountActions(
  cause: ProviderFailureCause,
  account: ProviderAccount | null,
): readonly string[] {
  const who = account ? `The ${account} account` : "The AI provider account";
  const where = account ? `the ${account} billing settings` : "the provider's billing settings";
  switch (cause) {
    case "credit":
      return [`${who} has no credit left; an admin must top it up in ${where}.`, RERUN_AFTER_ACCOUNT_FIX];
    case "spend_limit":
      return [
        `${who} reached its spend limit; an admin must raise or remove it in ${where}, or wait for it to reset.`,
        RERUN_AFTER_ACCOUNT_FIX,
      ];
    default:
      return [
        `The ${account ?? "AI provider"} plan this deployment signs in with hit its usage limit; rerun after it resets, or have an admin move to a larger plan or an API key.`,
        "Nothing is wrong with the ticket or the workflow.",
      ];
  }
}

/** Actions for a rejected credential, naming whose it was when the sentence did. */
function providerAuthActions(account: ProviderAccount | null): readonly string[] {
  if (!account) return NEXT_ACTIONS.dependency_auth;
  return [
    `${account} rejected the credential AI Workflow uses for it; an admin must replace the ${account} API key or login.`,
    "Nothing is wrong with the ticket: rerun once the credential is replaced.",
  ];
}

/** Actions for a provider that is refusing for now rather than for good. */
function providerUnavailableActions(
  cause: ProviderFailureCause,
  account: ProviderAccount | null,
): readonly string[] {
  if (!account) return NEXT_ACTIONS.dependency_unavailable;
  switch (cause) {
    case "rate_limit":
      return [
        `${account} rate-limited the request; wait a few minutes and rerun.`,
        "Nothing is wrong with the ticket; if this keeps happening, the account's rate limits are too low for this workload.",
      ];
    case "model":
      return [
        `${account} refused the requested model; choose one this account can use in the harness profile, then rerun.`,
      ];
    default:
      return [
        "Retry the run after a short delay.",
        `Check ${account}'s status page for ongoing incidents.`,
      ];
  }
}

const PROVIDER_ACCOUNT_CAUSES: ReadonlySet<ProviderFailureCause> = new Set([
  "credit",
  "spend_limit",
  "usage_limit",
]);

/**
 * The moment the run stopped, from its own completion time, or nothing.
 *
 * The one piece of the run this file puts into an action, and it is safe to:
 * it is re-rendered from a parsed Date, so whatever the column held, what comes
 * out is an ISO timestamp or nothing at all. The column names in the recorded
 * reason come from the tracker and are never copied.
 */
function leftColumnActions(completedAt: string | null | undefined): readonly string[] {
  const at = stopMoment(completedAt);
  if (!at) return NEXT_ACTIONS.ticket_left_trigger_column;
  return [
    `Stopped because the ticket left the trigger column at ${at}: a person moved it, so nothing failed.`,
    NEXT_ACTIONS.ticket_left_trigger_column[1] as string,
  ];
}

/** The same, for a ticket moved to the review column before anything was
 *  published: the run was stopped rather than left to publish into a column a
 *  person had already moved on from. */
function reviewTooEarlyActions(completedAt: string | null | undefined): readonly string[] {
  const at = stopMoment(completedAt);
  if (!at) return NEXT_ACTIONS.ticket_moved_to_review_early;
  return [
    `Stopped because the ticket was moved to the review column at ${at}, before this run had published a pull request: a person moved it, so nothing failed.`,
    NEXT_ACTIONS.ticket_moved_to_review_early[1] as string,
  ];
}

/** The run's completion time re-rendered from a parsed Date, or null. */
function stopMoment(completedAt: string | null | undefined): string | null {
  const at = completedAt ? new Date(completedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

// SAFE_EXECUTION_ERROR_MESSAGES.timeout (packages/workflow-graph/interpreter.ts),
// composed whenever a block reports `category: "timeout"` (e.g. engine/blocks/
// generic-agent/execute.ts:461, engine/agent-workflow.ts).
const SANDBOX_TIMEOUT_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.timeout;

// SAFE_EXECUTION_ERROR_MESSAGES.sandbox (same table), the generic
// "sandbox"-category sentence (e.g. engine/blocks/prepare-workspace/execute.ts's
// outer catches at :947 and :1486, `category: "sandbox"`).
const WORKSPACE_UNAVAILABLE_PREFIX = SAFE_EXECUTION_ERROR_MESSAGES.sandbox;

// SAFE_EXECUTION_ERROR_MESSAGES.engine (same table), used for
// engine-level failures (e.g. an unresolvable entry trigger or waiting node,
// V2SchedulerDefinitionError in packages/workflow-graph/scheduler.ts).
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

type RuleMatch = {
  confidence: "high" | "low";
  evidenceRefs: string[];
  /** Actions for this MATCH rather than for its category, for a category with
   *  two flavours an operator answers differently. Still a closed, code-owned
   *  phrase list: nothing from the run's own text may reach it. */
  nextActions?: readonly string[];
};

interface Rule {
  category: RunDiagnosisCategory;
  match(input: DiagnoseRunInput): RuleMatch | null;
}

/**
 * What a person has to do, per reason. Code-owned like every other phrase here:
 * the run's own sentence says the same thing for a human and is never copied
 * into an action.
 */
const INTEGRATION_UNAVAILABLE_ACTIONS: Record<IntegrationUnavailableReason, string[]> = {
  disconnected: [
    "An integration this workflow uses is no longer connected, so the run stopped at its next use of it.",
    "Ask an admin to reconnect it on the Integrations page, then run the workflow again.",
  ],
  disabled: [
    "An integration this workflow uses was disabled while the run was in flight, so the run stopped at its next use of it.",
    "Ask an admin to enable it on the Integrations page, then run the workflow again.",
  ],
  reconfigured: [
    "An integration this workflow uses was reconfigured while the run was in flight, so the run stopped rather than mixing the connection it started with and the one in force now.",
    "Nothing is broken: run the workflow again and it will use the new connection.",
  ],
};

/** What to tell a reader about a pull request run that stopped because its
 *  pull request moved on, per way it moved. Code-owned like every phrase here. */
const PULL_REQUEST_MOVED_ON_ACTIONS: Record<PullRequestMovedOn["kind"], string[]> = {
  new_commit: [
    "Stopped because the pull request got a newer commit before this run finished with the one it was started for: nothing failed.",
    "Nothing to retry: the newer commit is handled by its own run when the workflow starts on pull request updates.",
  ],
  closed: [
    "Stopped because the pull request was closed or merged before this run finished: nothing failed.",
    "Nothing to retry: reopening the pull request starts a new run when the workflow triggers on it.",
  ],
};

/**
 * The reason inside an `integration_unavailable.*` code, or nothing.
 *
 * Split off the code rather than carried separately, because the code is what
 * the column holds and a second field would be a second thing to keep true.
 */
function integrationUnavailableReasonOf(
  code: RunFailureCode | null,
): IntegrationUnavailableReason | null {
  const prefix = "integration_unavailable.";
  if (!code || !code.startsWith(prefix)) return null;
  return code.slice(prefix.length) as IntegrationUnavailableReason;
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
 *
 * One deliberate exception to "non-error statuses first":
 * completion_fields_pending sits immediately BEFORE succeeded, because it is
 * the same structured signal seen one step earlier (a success whose end-of-run
 * write has not landed yet). It is scoped to status "success" on top of the
 * shared predicate for exactly that reason: a failed or blocked run is also
 * allowed to be missing that write, and diagnosing one as "pending" instead of
 * giving its real cause is the opposite of useful. The predicate answers false
 * for a Post-PR gate row and for a live park, so neither can reach this rule
 * and shadow cancelled / awaiting_input below.
 */
const RULES: readonly Rule[] = [
  {
    category: "running",
    match: (input) => (input.status === "running" ? { confidence: "high", evidenceRefs: [] } : null),
  },
  {
    // Ahead of every prose rule, and high confidence, because this is the one
    // cause the run recorded as a value rather than as a sentence. A run
    // stopped by an integration whose sentence happens to open like another
    // category's would otherwise be diagnosed by its wording, which is exactly
    // what the code was added to stop.
    category: "integration_unavailable",
    match: (input) => {
      const reason = integrationUnavailableReasonOf(input.failureCode ?? null);
      if (!reason) return null;
      return {
        confidence: "high",
        // The code itself, which is a stable reference and not run text.
        evidenceRefs: [input.failureCode as string, ...evidenceFrom(input)],
        nextActions: INTEGRATION_UNAVAILABLE_ACTIONS[reason],
      };
    },
  },
  {
    // The other cause a run records as a value. High confidence for the same
    // reason as the rule above, and ahead of every prose rule because the
    // moved-on sentence would otherwise read as nothing in particular.
    category: "pull_request_moved_on",
    match: (input) => {
      const kind = pullRequestMovedOnKind(input.failureCode ?? null);
      if (!kind) return null;
      return {
        confidence: "high",
        evidenceRefs: [input.failureCode as string, ...evidenceFrom(input)],
        nextActions: PULL_REQUEST_MOVED_ON_ACTIONS[kind],
      };
    },
  },
  {
    category: "completion_fields_pending",
    match: (input) =>
      isRunCompletionPending(input)
        ? { confidence: "low", evidenceRefs: evidenceFrom(input) }
        : null,
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
    category: "engine_stalled",
    match: (input) => {
      if (input.status !== "failed") return null;
      const message = input.error?.message;
      if (!message || !message.startsWith(ENGINE_STALLED_PREFIX)) return null;
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    // Ahead of "cancelled": the poll's wording for this move says "cancelled by
    // reconciler", and a person moving a ticket is a more specific answer than
    // a cancellation of unknown origin. Low confidence like every rule that
    // reads a sentence, although both sentences are this build's own.
    category: "ticket_left_trigger_column",
    match: (input) => {
      if (input.status !== "blocked") return null;
      const message = input.error?.message;
      if (!message || !isLeftColumnReason(message)) return null;
      return {
        confidence: "low",
        evidenceRefs: evidenceFrom(input),
        nextActions: leftColumnActions(input.completedAt),
      };
    },
  },
  {
    // Its own sentence, written only by the ticket webhook and the reconciler
    // when a ticket reaches the review column while its run has published
    // nothing (services/tickets/ai-review-transition.ts); the tracker's name in
    // front of it is never copied into an action.
    category: "ticket_moved_to_review_early",
    match: (input) => {
      if (input.status !== "blocked") return null;
      const message = input.error?.message;
      if (!message || !isPrematureReviewReason(message)) return null;
      return {
        confidence: "low",
        evidenceRefs: evidenceFrom(input),
        nextActions: reviewTooEarlyActions(input.completedAt),
      };
    },
  },
  {
    // The trigger dispatcher stops a pull request's previous run when a newer
    // commit arrives and records this sentence with no code. Ahead of
    // "cancelled" because it is the more specific answer; low confidence
    // because it is read off the wording.
    category: "pull_request_moved_on",
    match: (input) => {
      if (input.status !== "blocked") return null;
      const message = input.error?.message;
      if (!message || !message.startsWith(SUPERSEDED_BY_NEWER_COMMIT)) return null;
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
    // Ahead of the generic checks-prefix rule below. Both are the checks
    // category, and a script that ran and failed is not the publication gate
    // refusing to publish; an operator answers the two differently.
    category: "repository_scripts_failed",
    match: (input) => {
      const message = input.error?.message;
      if (!message) return null;
      // Setup first: it is the one flavour whose answer is a different screen.
      if (message.startsWith(REPOSITORY_SCRIPTS_SETUP_FAILED_PREFIX)) {
        return {
          confidence: "low",
          evidenceRefs: evidenceFrom(input),
          nextActions: REPOSITORY_SCRIPTS_SETUP_ACTIONS,
        };
      }
      // The publication boundary's own refusal, which leads with the scripts
      // class and names the command. Structural, not a keyword: it is composed
      // from the constants imported above.
      if (
        !isRepositoryScriptsRefusal(message) &&
        !REPOSITORY_SCRIPTS_KEYWORDS.some((keyword) => message.includes(keyword))
      ) {
        return null;
      }
      return { confidence: "low", evidenceRefs: evidenceFrom(input) };
    },
  },
  {
    category: "workspace_gate",
    match: (input) => {
      const message = input.error?.message;
      if (!message) return null;
      if (message.startsWith(WORKSPACE_GATE_NOT_RECORDED_PREFIX)) {
        return { confidence: "low", evidenceRefs: evidenceFrom(input) };
      }
      if (!message.startsWith(WORKSPACE_GATE_PREFIX)) return null;
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
    category: "provider_account",
    match: (input) => {
      const curated = curatedProviderFailureOf(input.error?.message ?? "");
      if (!curated || !PROVIDER_ACCOUNT_CAUSES.has(curated.cause)) return null;
      return {
        confidence: "low",
        evidenceRefs: evidenceFrom(input),
        nextActions: providerAccountActions(curated.cause, curated.account),
      };
    },
  },
  {
    category: "dependency_auth",
    match: (input) => {
      const curated = curatedProviderFailureOf(input.error?.message ?? "");
      if (curated?.cause !== "auth") return null;
      return {
        confidence: "low",
        evidenceRefs: evidenceFrom(input),
        nextActions: providerAuthActions(curated.account),
      };
    },
  },
  {
    category: "dependency_unavailable",
    match: (input) => {
      const message = input.error?.message;
      if (!message) return null;
      const curated = curatedProviderFailureOf(message);
      if (curated) {
        return {
          confidence: "low",
          evidenceRefs: evidenceFrom(input),
          nextActions: providerUnavailableActions(curated.cause, curated.account),
        };
      }
      if (!startsWithAny(message, DEPENDENCY_UNAVAILABLE_PREFIXES)) return null;
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
    // the later `throw new WorkflowExecutionError`, engine/agent-workflow.ts:453, fails the
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
        nextActions: [...(hit.nextActions ?? NEXT_ACTIONS[rule.category])],
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
