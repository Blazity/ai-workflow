import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  BlockRunState,
  HarnessRunManifestRecord,
  ReplayAttemptOutcome,
  ReplayAttemptState,
  ReplayCaptureStatus,
  ReplaySanitizedEnvelope,
  ResolvedPromptReference,
  RunPullRequest,
  RunAnalysisReport,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
  WorkflowReplaySelectedTransition,
  WorkflowRunBudgetFailure,
} from "@shared/contracts";
import { organization } from "../auth-schema.js";
import { workflowDefinitionVersions } from "./definitions.js";

export type GateStatusRef =
  | { provider: "github"; id: number }
  | { provider: "gitlab"; name: string; headSha: string };

type BlockRunStateSummary = Omit<BlockRunState, "output">;

export const workflowRuns = pgTable("workflow_runs", {
  runId: text("run_id").primaryKey(),

  // Lifecycle - cron-owned (from the Workflow world).
  workflowId: text("workflow_id"),
  workflowName: text("workflow_name"),
  status: text("status"),
  /** Durable reason for a blocked/failed run - who cancelled it or why it
   * failed. Written by cancelRun / recordRunUsage; the world has no such field
   * (a cancelled run's error is always undefined). */
  statusReason: text("status_reason"),
  subjectKey: text("subject_key"),
  ticketKey: text("ticket_key"),
  ticketTitle: text("ticket_title"),
  ticketUrl: text("ticket_url"),
  /** Application-owned startup boundary, independent from Workflow world time. */
  entryStartedAt: timestamp("entry_started_at", { withTimezone: true }),
  startupDeadlineAt: timestamp("startup_deadline_at", { withTimezone: true }),
  diagnosticId: text("diagnostic_id"),
  model: text("model"),
  sandboxId: text("sandbox_id"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationSec: integer("duration_sec"),

  // Pull request - gate runs from gate_current (cron); agent runs from the
  // workflow output (workflow write).
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  prRepo: text("pr_repo"),
  /** Every PR/MR an agent run opened, one per changed repository, so a
   * multi-repo run is not reduced to the single prUrl/prNumber above (which
   * stay: gate runs write them, and runs predating this column only have them). */
  prs: jsonb("prs").$type<RunPullRequest[]>(),

  // Cost & usage - workflow-owned (accumulated PhaseUsage). costKnown is false
  // when any phase cost couldn't be priced (e.g. Codex with no price lookup).
  // numeric(19,4): fixed-precision currency so SQL cost rollups don't drift
  // like float (real). mode:"number" keeps the JS type a plain number.
  costUsd: numeric("cost_usd", { precision: 19, scale: 4, mode: "number" }),
  costKnown: boolean("cost_known"),
  tokensInput: integer("tokens_input"),
  tokensCached: integer("tokens_cached"),
  tokensOutput: integer("tokens_output"),
  /** Per-phase breakdown: { [phase]: { costUsd, tokens, durationMs, numTurns } }. */
  phases: jsonb("phases"),
  /** Full RunStep[] trace waterfall, captured on completion (workflow-owned). */
  steps: jsonb("steps"),
  /** Sanitized durable planning/research summary (workflow-owned). */
  analysisReport: jsonb("analysis_report").$type<RunAnalysisReport>(),
  /** Structured terminal budget cause; null for non-budget exits. */
  budgetFailure: jsonb("budget_failure").$type<WorkflowRunBudgetFailure>(),

  definitionVersion: integer("definition_version"),
  definitionId: integer("definition_id"),
  blockStatuses: jsonb("block_statuses")
    .$type<Record<string, BlockRunStateSummary>>(),
  promptManifest: jsonb("prompt_manifest").$type<ResolvedPromptReference[]>(),
  harnessManifests: jsonb("harness_manifests").$type<HarnessRunManifestRecord[]>(),
  /** Durable markers distinguish a captured replay that expired from a
   * historical run for which replay was never captured. */
  replayOrganizationId: text("replay_organization_id").references(
    () => organization.id,
    { onDelete: "set null" },
  ),
  replayCapturedAt: timestamp("replay_captured_at", { withTimezone: true }),
  replayExpiresAt: timestamp("replay_expires_at", { withTimezone: true }),
  replayCaptureFailedAt: timestamp("replay_capture_failed_at", {
    withTimezone: true,
  }),

  // Bookkeeping.
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Built for querying: active-count by status, time-window stats by startedAt,
  // per-ticket run history by ticketKey, editor block-status poll by definitionId.
  index("workflow_runs_status_idx").on(t.status),
  index("workflow_runs_started_at_idx").on(t.startedAt),
  index("workflow_runs_subject_key_idx").on(t.subjectKey),
  index("workflow_runs_ticket_key_idx").on(t.ticketKey),
  index("workflow_runs_definition_id_idx").on(t.definitionId),
  index("workflow_runs_startup_watchdog_idx")
    .on(t.startupDeadlineAt)
    .where(
      sql`${t.entryStartedAt} is null and coalesce(${t.status}, 'running') not in ('success', 'failed', 'blocked', 'awaiting', 'completed', 'cancelled')`,
    ),
]);

/** Provider check resources are owned by one run and exact PR head. The
 * provider reference never crosses the workflow binding boundary. */
export const workflowRunExternalChecks = pgTable(
  "workflow_run_external_checks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    activationScope: text("activation_scope").notNull(),
    subjectKey: text("subject_key").notNull(),
    provider: text("provider").notNull(),
    repository: text("repository").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    name: text("name").notNull(),
    providerReference: jsonb("provider_reference").$type<GateStatusRef>(),
    state: text("state").notNull().default("pending"),
    closureIntent: text("closure_intent"),
    conclusion: text("conclusion"),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    diagnosticId: text("diagnostic_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("workflow_run_external_checks_attempt_unique").on(
      t.runId,
      t.nodeId,
      t.activationScope,
      t.attempt,
    ),
    index("workflow_run_external_checks_reconcile_idx").on(t.state, t.updatedAt),
    index("workflow_run_external_checks_run_idx").on(t.runId),
    check(
      "workflow_run_external_checks_state_check",
      sql`${t.state} in ('creating', 'pending', 'closing', 'completed')`,
    ),
    check(
      "workflow_run_external_checks_conclusion_check",
      sql`${t.conclusion} is null or ${t.conclusion} in ('success', 'failure', 'neutral', 'cancelled', 'timed_out', 'superseded')`,
    ),
  ],
);

export const workflowPrReviewPublications = pgTable(
  "workflow_pr_review_publications",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    activationScope: text("activation_scope").notNull(),
    provider: text("provider").notNull(),
    repository: text("repository").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    contentHash: text("content_hash").notNull(),
    decision: text("decision").notNull(),
    summary: text("summary").notNull(),
    state: text("state").notNull().default("pending"),
    providerReference: text("provider_reference"),
    inlineCommentCount: integer("inline_comment_count").notNull().default(0),
    summaryFallbackCount: integer("summary_fallback_count").notNull().default(0),
    lastError: text("last_error"),
    diagnosticId: text("diagnostic_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("workflow_pr_review_publications_content_unique").on(
      t.provider,
      t.repository,
      t.prNumber,
      t.headSha,
      t.contentHash,
    ),
    index("workflow_pr_review_publications_run_idx").on(t.runId),
    check(
      "workflow_pr_review_publications_state_check",
      sql`${t.state} in ('pending', 'published')`,
    ),
    check(
      "workflow_pr_review_publications_decision_check",
      sql`${t.decision} in ('approve', 'request_changes')`,
    ),
  ],
);

export const workflowPrReviewPublicationComments = pgTable(
  "workflow_pr_review_publication_comments",
  {
    publicationId: text("publication_id")
      .notNull()
      .references(() => workflowPrReviewPublications.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    providerReference: text("provider_reference"),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.publicationId, t.contentHash] }),
    check(
      "workflow_pr_review_publication_comments_state_check",
      sql`${t.state} in ('pending', 'published')`,
    ),
  ],
);

/**
 * Replay-safe snapshot captured at the beginning of a v2 run. The exact
 * definition and layout are copied here because both mutable draft state and
 * independently persisted layout can change after dispatch.
 */
export const workflowRunObservations = pgTable(
  "workflow_run_observations",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    definitionSchemaVersion: integer("definition_schema_version").notNull(),
    graph: jsonb("graph").$type<WorkflowReplayGraphSnapshot>().notNull(),
    layout: jsonb("layout").$type<WorkflowReplayLayoutSnapshot>().notNull(),
    runtimeManifest: jsonb("runtime_manifest")
      .$type<ReplaySanitizedEnvelope>()
      .notNull(),
    captureStatus: text("capture_status").$type<ReplayCaptureStatus>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("workflow_run_observations_run_org_unique").on(
      t.runId,
      t.organizationId,
    ),
    index("workflow_run_observations_org_captured_idx").on(
      t.organizationId,
      t.capturedAt,
    ),
    index("workflow_run_observations_expires_at_idx").on(t.expiresAt),
    check(
      "workflow_run_observations_schema_version_check",
      sql`${t.definitionSchemaVersion} in (1, 2)`,
    ),
    check(
      "workflow_run_observations_capture_status_check",
      sql`${t.captureStatus} in ('available', 'unavailable')`,
    ),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "workflow_run_observations_definition_version_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * One durable row per invocation. Inputs, outputs, logs, and metadata are
 * diagnostic copies only; they are sanitized and bounded before persistence.
 */
export const workflowBlockAttempts = pgTable(
  "workflow_block_attempts",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    organizationId: text("organization_id").notNull(),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    activationScopeId: text("activation_scope_id").notNull(),
    state: text("state").$type<ReplayAttemptState>().notNull(),
    outcome: jsonb("outcome").$type<ReplayAttemptOutcome>(),
    selectedTransition: jsonb("selected_transition")
      .$type<WorkflowReplaySelectedTransition>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    diagnosticId: text("diagnostic_id"),
    inputEnvelope: jsonb("input_envelope").$type<ReplaySanitizedEnvelope>(),
    outputEnvelope: jsonb("output_envelope").$type<ReplaySanitizedEnvelope>(),
    logEnvelope: jsonb("log_envelope").$type<ReplaySanitizedEnvelope>(),
    metadataEnvelope: jsonb("metadata_envelope").$type<ReplaySanitizedEnvelope>(),
    observationRevision: integer("observation_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_block_attempts_identity_unique").on(
      t.runId,
      t.nodeId,
      t.attempt,
      t.activationScopeId,
    ),
    index("workflow_block_attempts_run_id_idx").on(t.runId, t.id),
    index("workflow_block_attempts_org_run_idx").on(
      t.organizationId,
      t.runId,
      t.id,
    ),
    check("workflow_block_attempts_attempt_check", sql`${t.attempt} > 0`),
    check(
      "workflow_block_attempts_observation_revision_check",
      sql`${t.observationRevision} >= 0`,
    ),
    check(
      "workflow_block_attempts_state_check",
      sql`${t.state} in ('running', 'waiting_loop', 'waiting_for_clarification', 'completed', 'failed', 'cancelled', 'skipped')`,
    ),
    check(
      "workflow_block_attempts_duration_check",
      sql`${t.durationMs} is null or ${t.durationMs} >= 0`,
    ),
    check(
      "workflow_block_attempts_completion_check",
      sql`(${t.state} in ('running', 'waiting_loop') and ${t.completedAt} is null) or (${t.state} not in ('running', 'waiting_loop') and ${t.completedAt} is not null)`,
    ),
    foreignKey({
      columns: [t.runId, t.organizationId],
      foreignColumns: [
        workflowRunObservations.runId,
        workflowRunObservations.organizationId,
      ],
      name: "workflow_block_attempts_run_org_fk",
    }).onDelete("cascade"),
  ],
);

export const workflowOwnedBranches = pgTable(
  "workflow_owned_branches",
  {
    ticketKey: text("ticket_key").notNull(),
    provider: text("provider").notNull(),
    repoPath: text("repo_path").notNull(),
    branchName: text("branch_name").notNull(),
    prId: integer("pr_id"),
    prUrl: text("pr_url"),
    prBranchName: text("pr_branch_name"),
    publishedHeadSha: text("published_head_sha"),
    /** Intended target branch for the current publication intent. */
    targetBranch: text("target_branch"),
    /** Head SHA at which the stored PR identity was last confirmed. */
    prPublishedHeadSha: text("pr_published_head_sha"),
    /** Target branch at which the stored PR identity was last confirmed. */
    prTargetBranch: text("pr_target_branch"),
    /** A provider PR identity is still expected for the current intent. */
    prCorrelationPending: boolean("pr_correlation_pending").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketKey, t.provider, t.repoPath] }),
    check("workflow_owned_branches_provider_check", sql`${t.provider} in ('github', 'gitlab')`),
  ],
);

/**
 * Dashboard-managed pre-PR check configuration, append-only. The current
 * config is the row with the highest version; a rollback appends a copy of
 * an older version with restored_from_version set. No rows = gate disabled.
 */
