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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { BlockRunState, WorkflowRunBudgetFailure } from "@shared/contracts";
import type { GateStatusRef } from "../adapters/vcs/types.js";
import type { PrePrCheckConfig } from "../pre-pr-checks/config.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";

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
    /** Monotonic CAS for ticket-side provider starts and human cancellation
     * fences. Cancellation may release only the exact version it reconciled. */
    ticketMutationVersion: integer("ticket_mutation_version").notNull().default(0),
    /** Exact owner-local provider boundary count. Release and handoff require
     * zero; a database trigger also accounts for old pods during rollout. */
    ticketProviderCallsInFlight: integer("ticket_provider_calls_in_flight")
      .notNull()
      .default(0),
    /** NULL is outside the cancellation protocol, -2 is an indeterminate
     * legacy cancellation, -1 is an opened cancellation awaiting
     * reconciliation, and a nonnegative value acknowledges the exact
     * ticketMutationVersion that may be released. */
    ticketCancellationReconciledVersion: integer(
      "ticket_cancellation_reconciled_version",
    ),
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
    subjectKey: text("subject_key")
      .notNull()
      .references(() => activeRuns.subjectKey, { onDelete: "cascade" }),
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

/** Short-lived proof that a workflow, not a human, initiated a ticket status
 * change. Jira webhook echoes consume this record instead of cancelling or
 * dispatching the owning run. */
export const ticketTransitionIntents = pgTable(
  "ticket_transition_intents",
  {
    id: serial("id").primaryKey(),
    ticketKey: text("ticket_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    ownerToken: text("owner_token").notNull(),
    /** Null while a pre-start reservation owns the transition. Intentionally
     * no active_runs FK: a provider echo can arrive after release or handoff. */
    runId: text("run_id"),
    /** Stable Jira account id for the authenticated workflow actor that
     * requested the transition. Provider echoes must match it exactly. */
    actorAccountId: text("actor_account_id").notNull(),
    targetStatusId: text("target_status_id"),
    targetStatusName: text("target_status_name").notNull(),
    /** Jira preserves this identifier across webhook retries. Once attached
     * to a consumed intent it makes every retry idempotent. */
    webhookIdentifier: text("webhook_identifier"),
    /** Durable provider-call fence. Cancellation may begin after this marker
     * but cannot release the owner until the call is reconciled. */
    /** The default deliberately marks inserts from pre-fence application pods
     * as potentially started. Current code explicitly writes NULL while it is
     * only recording an intent, then opens the provider boundary separately. */
    providerStartedAt: timestamp("provider_started_at", { withTimezone: true }).defaultNow(),
    providerFinishedAt: timestamp("provider_finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ticket_transition_intents_ticket_expiry_idx").on(t.ticketKey, t.expiresAt),
    uniqueIndex("ticket_transition_intents_webhook_identifier_uidx").on(
      t.webhookIdentifier,
    ),
  ],
);

/** Exact-owner fence for Jira label mutations. Label writes have no stable
 * provider echo, so an ambiguous HTTP result remains unfinished until the
 * desired live label set is positively observed (or the ticket no longer
 * exists); expiry alone is never provider proof. */
export const ticketLabelMutationIntents = pgTable(
  "ticket_label_mutation_intents",
  {
    id: serial("id").primaryKey(),
    ticketKey: text("ticket_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    ownerToken: text("owner_token").notNull(),
    runId: text("run_id"),
    addLabels: text("add_labels").array().notNull().default(sql`'{}'::text[]`),
    removeLabels: text("remove_labels").array().notNull().default(sql`'{}'::text[]`),
    providerStartedAt: timestamp("provider_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    providerFinishedAt: timestamp("provider_finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ticket_label_mutation_intents_owner_expiry_idx").on(
      t.subjectKey,
      t.ownerToken,
      t.expiresAt,
    ),
    check(
      "ticket_label_mutation_intents_nonempty_check",
      sql`cardinality(${t.addLabels}) > 0 or cardinality(${t.removeLabels}) > 0`,
    ),
    check(
      "ticket_label_mutation_intents_disjoint_check",
      sql`not (${t.addLabels} && ${t.removeLabels})`,
    ),
  ],
);

/** Human ticket destinations observed while an exact owner is being closed.
 * Rows survive owner release so retries and late provider calls can reconcile
 * against the newest Jira event without relying on process memory. */
export const ticketCancellationFences = pgTable(
  "ticket_cancellation_fences",
  {
    id: serial("id").primaryKey(),
    ticketKey: text("ticket_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    ownerToken: text("owner_token").notNull(),
    runId: text("run_id"),
    targetStatusId: text("target_status_id"),
    targetStatusName: text("target_status_name").notNull(),
    webhookIdentifier: text("webhook_identifier").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_cancellation_fences_webhook_identifier_uidx").on(
      t.webhookIdentifier,
    ),
    index("ticket_cancellation_fences_owner_occurred_idx").on(
      t.subjectKey,
      t.ownerToken,
      t.occurredAt,
    ),
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
export const workflowRuns = pgTable("workflow_runs", {
  runId: text("run_id").primaryKey(),

  // Lifecycle — cron-owned (from the Workflow world).
  workflowId: text("workflow_id"),
  workflowName: text("workflow_name"),
  status: text("status"),
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
  blockStatuses: jsonb("block_statuses").$type<Record<string, BlockRunState>>(),

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
 * Durable two-phase publication ledger. Finalize Workspace owns the push
 * phases; Open PR/MR may consume only an attempt that reached `finalized`.
 * The run/block uniqueness is the replay guard that prevents a Workflow step
 * replay from pushing the same workspace twice.
 */
export const publicationAttempts = pgTable(
  "publication_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    blockId: text("block_id").notNull(),
    workspaceManifest: jsonb("workspace_manifest").$type<WorkspaceManifest>().notNull(),
    status: text("status").notNull().default("preflighting"),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("publication_attempts_run_block_idx").on(t.runId, t.blockId),
    check(
      "publication_attempts_status_check",
      sql`${t.status} in ('preflighting', 'pushing', 'finalized', 'creating_prs', 'published', 'failed')`,
    ),
  ],
);

/** Per-repository facts retained even when a cross-provider publication is partial. */
export const publicationAttemptRepositories = pgTable(
  "publication_attempt_repositories",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => publicationAttempts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    repoPath: text("repo_path").notNull(),
    branchName: text("branch_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    changed: boolean("changed").notNull().default(false),
    expectedHead: text("expected_head"),
    targetHead: text("target_head"),
    pushedHead: text("pushed_head"),
    prId: integer("pr_id"),
    prUrl: text("pr_url"),
    prIsNew: boolean("pr_is_new"),
    failure: text("failure"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.provider, t.repoPath] }),
    check(
      "publication_attempt_repositories_provider_check",
      sql`${t.provider} in ('github', 'gitlab')`,
    ),
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
    /** Node coordinates are CAS-patched independently from semantic edits. */
    layout: jsonb("layout")
      .$type<{ nodes: Record<string, { x: number; y: number }> }>()
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

export * from "./auth-schema.js";
export * from "./email-delivery-schema.js";
export * from "./approvals-schema.js";
export * from "./clarifications-schema.js";
