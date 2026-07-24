import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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
  HarnessProfileDraftManifestV1,
  HarnessProfileManifestV1,
  HarnessRunManifestRecord,
  PromptSlotDefinition,
  ReplayAttemptOutcome,
  ReplayAttemptState,
  ReplayCaptureStatus,
  ReplaySanitizedEnvelope,
  ResolvedPromptReference,
  WorkflowDefinitionLayoutInput,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
  WorkflowReplaySelectedTransition,
  WorkflowRunBudgetFailure,
} from "@shared/contracts";
import type { GateStatusRef } from "../adapters/vcs/types.js";
import type { PrePrCheckConfig } from "../pre-pr-checks/config.js";
import { organization } from "./auth-schema.js";

/** One owner-CAS reservation per provider-neutral workflow subject. */
export const activeRuns = pgTable(
  "active_runs",
  {
    subjectKey: text("subject_key").primaryKey(),
    ticketKey: text("ticket_key"),
    ownerToken: text("owner_token").notNull(),
    runId: text("run_id"),
    state: text("state").notNull().default("reserved"),
    runKind: text("run_kind").notNull().default("ticket"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "active_runs_state_check",
      sql`${t.state} in ('reserved', 'bound', 'parking', 'parked', 'cancelling')`,
    ),
    check(
      "active_runs_state_run_id_check",
      sql`(${t.state} = 'reserved' and ${t.runId} is null) or (${t.state} in ('bound', 'parking', 'parked') and ${t.runId} is not null) or ${t.state} = 'cancelling'`,
    ),
    index("active_runs_ticket_key_idx").on(t.ticketKey),
    uniqueIndex("active_runs_subject_owner_idx").on(t.subjectKey, t.ownerToken),
  ],
);

/** Every scratch/code sandbox owned by a run, not merely the most recent one. */
export const activeRunSandboxes = pgTable(
  "active_run_sandboxes",
  {
    subjectKey: text("subject_key").notNull(),
    ownerToken: text("owner_token").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.ownerToken, t.sandboxId] }),
    foreignKey({
      columns: [t.subjectKey, t.ownerToken],
      foreignColumns: [activeRuns.subjectKey, activeRuns.ownerToken],
      name: "active_run_sandboxes_subject_owner_fk",
    }).onDelete("cascade"),
  ],
);

/** Authenticated, normalized provider-event inbox. Delivery identity is
 * idempotent; at most one row per subject is retained as pending feedback. */
export const triggerDeliveries = pgTable(
  "trigger_deliveries",
  {
    provider: text("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    producer: text("producer").notNull(),
    triggerType: text("trigger_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    ticketKey: text("ticket_key"),
    headSha: text("head_sha").notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    pending: boolean("pending").notNull().default(false),
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.deliveryId] }),
    uniqueIndex("trigger_deliveries_one_pending_per_subject_idx")
      .on(t.subjectKey)
      .where(sql`${t.pending} = true`),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "trigger_deliveries_definition_version_fk",
    }),
  ],
);

export const manualDispatchRequests = pgTable(
  "manual_dispatch_requests",
  {
    requestId: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    triggerNodeId: text("trigger_node_id").notNull(),
    triggerType: text("trigger_type").notNull(),
    inputKind: text("input_kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    ticketKey: text("ticket_key"),
    inputPayload: jsonb("input_payload").$type<Record<string, unknown>>().notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorLabel: text("actor_label").notNull(),
    ownerToken: text("owner_token"),
    runId: text("run_id"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "manual_dispatch_requests_status_check",
      sql`${t.status} in ('pending', 'reserved', 'prepared', 'candidate_started', 'started', 'failed')`,
    ),
    check(
      "manual_dispatch_requests_input_kind_check",
      sql`${t.inputKind} in ('ticket', 'pull_request')`,
    ),
    index("manual_dispatch_requests_status_idx").on(t.status),
    index("manual_dispatch_requests_subject_key_idx").on(t.subjectKey),
    index("manual_dispatch_requests_run_id_idx").on(t.runId),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "manual_dispatch_requests_definition_version_fk",
    }),
  ],
);

/** Replaces blazebot:failed-tickets — FailedTicketMeta as typed columns. */
export const failedTickets = pgTable("failed_tickets", {
  ticketKey: text("ticket_key").primaryKey(),
  runId: text("run_id").notNull(),
  error: text("error").notNull(),
  /** ISO-8601 string, exactly as FailedTicketMeta.failedAt round-trips today. */
  failedAt: text("failed_at").notNull(),
});

/**
 * Replaces blazebot:thread-parents. Separate table on purpose: thread
 * parents survive across runs for the same ticket (unregister must not
 * clear them). text column = no more Upstash number-coercion of Slack ts.
 */
export const threadParents = pgTable("thread_parents", {
  ticketKey: text("ticket_key").primaryKey(),
  messageId: text("message_id").notNull(),
});

/**
 * Post-PR gate lock — replaces gate:lock:{repo}#{pr} (SET NX EX 30).
 * An expired row counts as released; acquire atomically steals it.
 */
export const gateLocks = pgTable(
  "gate_locks",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr] })],
);

/** Replaces gate:dedupe:{repo}#{pr}@{sha} (SET NX EX 14d). */
export const gateDedupe = pgTable(
  "gate_dedupe",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    headSha: text("head_sha").notNull(),
    runId: text("run_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr, t.headSha] })],
);

/**
 * Replaces gate:current:{repo}#{pr} (JSON pointer, EX 14d).
 * check_run_ids stays for migration compatibility. New gate code stores
 * provider-neutral references in gate_status_refs.
 */
export const gateCurrent = pgTable(
  "gate_current",
  {
    repo: text("repo").notNull(),
    pr: integer("pr").notNull(),
    runId: text("run_id").notNull(),
    headSha: text("head_sha").notNull(),
    checkRunIds: bigint("check_run_ids", { mode: "number" })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    gateStatusRefs: jsonb("gate_status_refs")
      .$type<GateStatusRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.pr] })],
);

/**
 * Environment-isolation guard. Exactly one row (id=1). Claimed at build
 * time by scripts/db-migrate.ts: if a branch is already claimed by a
 * different VERCEL_ENV on the SAME endpoint host, the build fails —
 * preview must never share production's Neon branch. A differing endpoint
 * host means the branch was copied (Neon branches copy data), so the
 * marker is re-claimed instead of failing.
 */
export const envMarker = pgTable("env_marker", {
  id: integer("id").primaryKey(),
  env: text("env").notNull(),
  endpointHost: text("endpoint_host").notNull(),
});

/**
 * Durable run telemetry — one row per workflow run, keyed by runId. Survives
 * far longer than Vercel's ~24h observability window so run history, active
 * counts, and per-run cost stay queryable with plain SQL.
 *
 * Written by three upserters that own disjoint columns:
 * - The poll cron snapshots lifecycle/status/ticket/PR(gate) from the
 *   Workflow world + the run registry (see lib/telemetry/collect-snapshots).
 * - The agent workflow records cost/tokens/per-phase usage + the agent PR on
 *   completion — data that only exists inside the run (see recordRunUsage).
 * - The mid-run block-status writer owns exactly block_statuses,
 *   definition_version and definition_id (plus updated_at), streaming
 *   per-block progress as the run advances through the stored definition.
 *
 * All use ON CONFLICT (run_id) DO UPDATE setting only their own columns, so
 * whichever writes first inserts the row and the others fill in the rest,
 * regardless of order.
 */
type BlockRunStateSummary = Omit<BlockRunState, "output">;

export const workflowRuns = pgTable("workflow_runs", {
  runId: text("run_id").primaryKey(),

  // Lifecycle — cron-owned (from the Workflow world).
  workflowId: text("workflow_id"),
  workflowName: text("workflow_name"),
  status: text("status"),
  /** Durable reason for a blocked/failed run — who cancelled it or why it
   * failed. Written by cancelRun / recordRunUsage; the world has no such field
   * (a cancelled run's error is always undefined). */
  statusReason: text("status_reason"),
  subjectKey: text("subject_key"),
  ticketKey: text("ticket_key"),
  ticketTitle: text("ticket_title"),
  ticketUrl: text("ticket_url"),
  model: text("model"),
  sandboxId: text("sandbox_id"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationSec: integer("duration_sec"),

  // Pull request — gate runs from gate_current (cron); agent runs from the
  // workflow output (workflow write).
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  prRepo: text("pr_repo"),

  // Cost & usage — workflow-owned (accumulated PhaseUsage). costKnown is false
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
]);

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
export const prePrCheckConfigVersions = pgTable("pre_pr_check_config_versions", {
  version: serial("version").primaryKey(),
  config: jsonb("config").$type<PrePrCheckConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: text("created_by_id").notNull(),
  createdByLabel: text("created_by_label").notNull(),
  restoredFromVersion: integer("restored_from_version"),
});

/**
 * Dashboard-managed workflow definition versions, append-only per definition.
 * Declared before workflowDefinitions so that table can express its composite
 * deployed pointer. The typed lazy reference keeps the reverse FK cycle safe.
 */
export const workflowDefinitionVersions = pgTable(
  "workflow_definition_versions",
  {
    definitionId: integer("definition_id")
      .notNull()
      .references((): AnyPgColumn => workflowDefinitions.id),
    version: integer("version").notNull(),
    // Stored rows may predate required normalized node fields. Reads parse and
    // upgrade this raw JSON before exposing the canonical WorkflowDefinition.
    definition: jsonb("definition").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
    restoredFromVersion: integer("restored_from_version"),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.version] })],
);

/**
 * Named workflow definitions: one row per definition the dashboard manages.
 * trigger_types is denormalized from the head version, kept in sync by
 * save/restore, and backs the one-enabled-definition-per-trigger rule so the
 * overlap check is a plain array-overlap query instead of re-parsing every
 * head version's graph. A definition is archived (soft-deleted) via
 * archived_at; the partial unique index frees its name for reuse once archived.
 */
export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    triggerTypes: text("trigger_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Canvas geometry is CAS-patched independently from semantic edits. */
    layout: jsonb("layout")
      .$type<WorkflowDefinitionLayoutInput>()
      .notNull()
      .default(sql`'{"nodes":{}}'::jsonb`),
    layoutRevision: integer("layout_revision").notNull().default(0),
    /** Exact immutable snapshot selected for new dispatches. */
    deployedVersion: integer("deployed_version"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
  },
  (t) => [
    uniqueIndex("workflow_definitions_name_active_idx")
      .on(t.name)
      .where(sql`${t.archivedAt} is null`),
    foreignKey({
      columns: [t.id, t.deployedVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "workflow_definitions_deployed_version_fk",
    }),
  ],
);

/**
 * Enabled trigger bindings — the DB-level guarantee behind "at most one enabled
 * definition per trigger type". One row per trigger_type currently owned by an
 * enabled, non-archived definition. trigger_type is the PRIMARY KEY, so a second
 * definition trying to claim the same trigger fails with a unique violation
 * (surfaced as the 409 "already handled" path) instead of racing past a
 * read-then-write overlap check.
 *
 * Rows exist ONLY while the owning definition is enabled, so their presence IS
 * the "enabled = true" predicate — a plain PK on trigger_type is equivalent to a
 * partial unique index on trigger_type WHERE enabled. A definition with several
 * trigger nodes gets several rows; enabling inserts them, disabling/archiving
 * deletes them, saving a new version re-syncs them to the head graph, and
 * getEnabledWorkflowDefinitionForTrigger repairs any drift (from a crashed
 * write) on read. ON DELETE CASCADE keeps a binding subordinate to its
 * definition.
 */
export const workflowDefinitionTriggers = pgTable("workflow_definition_triggers", {
  triggerType: text("trigger_type").primaryKey(),
  definitionId: integer("definition_id")
    .notNull()
    .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
});

/**
 * Prompt library: one row per reusable prompt the dashboard manages. The
 * metadata here (name, description, tags) is mutable in place, while the prompt
 * text is append-only in prompt_library_versions, the same split
 * workflow_definitions uses. A prompt is archived (soft-deleted) via
 * archived_at; the partial unique index frees its name for reuse once archived.
 * Distinct from the read-only Arthur prompt registry served by /api/v1/prompts:
 * those are runtime agent prompts discovered from the codebase, these are
 * user-authored text blocks copied into workflow-definition block params.
 */
export const promptLibrary = pgTable(
  "prompt_library",
  {
    id: serial("id").primaryKey(),
    /** Immutable reference key used by {{prompt:<slug>}} tokens; derived from
     *  the name at create time, never changed by renames. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
  },
  (t) => [
    uniqueIndex("prompt_library_name_active_idx")
      .on(t.name)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex("prompt_library_slug_active_idx")
      .on(t.slug)
      .where(sql`${t.archivedAt} is null`),
  ],
);

/**
 * Prompt library versions, append-only per prompt. Each row belongs to a
 * prompt_library row; a prompt's head is its highest version, and a restore
 * appends a copy of an older body with restored_from_version set. The body
 * lives here (never mutated) so the version history is the audit trail, while
 * the parent row carries only mutable metadata.
 */
export const promptLibraryVersions = pgTable(
  "prompt_library_versions",
  {
    promptId: integer("prompt_id")
      .notNull()
      .references(() => promptLibrary.id),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    slots: jsonb("slots")
      .$type<PromptSlotDefinition[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").notNull(),
    createdByLabel: text("created_by_label").notNull(),
    restoredFromVersion: integer("restored_from_version"),
  },
  (t) => [primaryKey({ columns: [t.promptId, t.version] })],
);

/**
 * Harness profiles split mutable draft state from immutable published
 * versions. System profiles are global and read-only; organization profiles
 * are tenant-owned and all store access must scope them to organization_id.
 */
export const harnessProfileVersions = pgTable(
  "harness_profile_versions",
  {
    profileId: text("profile_id")
      .notNull()
      .references((): AnyPgColumn => harnessProfiles.id, {
        onDelete: "restrict",
      }),
    version: integer("version").notNull(),
    manifest: jsonb("manifest").$type<HarnessProfileManifestV1>().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id").notNull(),
    restoredFromVersion: integer("restored_from_version"),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.version] }),
    uniqueIndex("harness_profile_versions_hash_unique").on(
      t.profileId,
      t.manifestHash,
    ),
    check("harness_profile_versions_version_check", sql`${t.version} > 0`),
  ],
);

export const harnessProfiles = pgTable(
  "harness_profiles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    slug: text("slug").notNull(),
    draftManifest: jsonb("draft_manifest")
      .$type<HarnessProfileDraftManifestV1>()
      .notNull(),
    draftRevision: integer("draft_revision").notNull().default(1),
    draftRestoredFromVersion: integer("draft_restored_from_version"),
    publishedVersion: integer("published_version"),
    system: boolean("system").notNull().default(false),
    readOnly: boolean("read_only").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id").notNull(),
    updatedById: text("updated_by_id").notNull(),
  },
  (t) => [
    uniqueIndex("harness_profiles_org_slug_unique")
      .on(t.organizationId, t.slug)
      .where(sql`${t.organizationId} is not null`),
    uniqueIndex("harness_profiles_system_slug_unique")
      .on(t.slug)
      .where(sql`${t.organizationId} is null`),
    index("harness_profiles_organization_id_idx").on(t.organizationId),
    check(
      "harness_profiles_ownership_check",
      sql`(${t.system} = true and ${t.readOnly} = true and ${t.organizationId} is null) or (${t.system} = false and ${t.organizationId} is not null)`,
    ),
    check(
      "harness_profiles_draft_revision_check",
      sql`${t.draftRevision} > 0`,
    ),
    check(
      "harness_profiles_published_version_check",
      sql`${t.publishedVersion} is null or ${t.publishedVersion} > 0`,
    ),
    foreignKey({
      columns: [t.id, t.publishedVersion],
      foreignColumns: [
        harnessProfileVersions.profileId,
        harnessProfileVersions.version,
      ],
      name: "harness_profiles_published_version_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * Content-addressed, organization-private snapshots of imported GitHub skills.
 * The artifact hash covers the exact source commit, root path, file paths,
 * modes, hashes, and bytes.
 */
export const harnessSkillArtifacts = pgTable(
  "harness_skill_artifacts",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    artifactHash: text("artifact_hash").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sourceOwner: text("source_owner").notNull(),
    sourceRepository: text("source_repository").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id").notNull(),
  },
  (t) => [
    uniqueIndex("harness_skill_artifacts_org_hash_unique").on(
      t.organizationId,
      t.artifactHash,
    ),
    index("harness_skill_artifacts_source_idx").on(
      t.organizationId,
      t.sourceOwner,
      t.sourceRepository,
      t.sourcePath,
    ),
  ],
);

export const harnessSkillArtifactFiles = pgTable(
  "harness_skill_artifact_files",
  {
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => harnessSkillArtifacts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    mode: integer("mode").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    contentBase64: text("content_base64").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.path] }),
    check(
      "harness_skill_artifact_files_mode_check",
      sql`${t.mode} in (420, 493)`,
    ),
    check(
      "harness_skill_artifact_files_size_check",
      sql`${t.sizeBytes} >= 0`,
    ),
  ],
);

export const harnessProfileVersionSkills = pgTable(
  "harness_profile_version_skills",
  {
    profileId: text("profile_id").notNull(),
    profileVersion: integer("profile_version").notNull(),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => harnessSkillArtifacts.id, { onDelete: "restrict" }),
    skillName: text("skill_name").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.profileId, t.profileVersion, t.artifactId],
    }),
    foreignKey({
      columns: [t.profileId, t.profileVersion],
      foreignColumns: [
        harnessProfileVersions.profileId,
        harnessProfileVersions.version,
      ],
      name: "harness_profile_version_skills_profile_version_fk",
    }).onDelete("restrict"),
    uniqueIndex("harness_profile_version_skills_name_unique").on(
      t.profileId,
      t.profileVersion,
      t.skillName,
    ),
    uniqueIndex("harness_profile_version_skills_position_unique").on(
      t.profileId,
      t.profileVersion,
      t.position,
    ),
    check(
      "harness_profile_version_skills_position_check",
      sql`${t.position} >= 0`,
    ),
  ],
);

export * from "./auth-schema.js";
export * from "./email-delivery-schema.js";
export * from "./approvals-schema.js";
export * from "./clarifications-schema.js";
