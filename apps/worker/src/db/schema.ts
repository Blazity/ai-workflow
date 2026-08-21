import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
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
  HarnessCapabilityCatalog,
  HarnessProfileDraftManifest,
  HarnessProfileManifest,
  HarnessRunManifestRecord,
  PromptSlotDefinition,
  ReplayAttemptOutcome,
  ReplayAttemptState,
  ReplayCaptureStatus,
  ReplaySanitizedEnvelope,
  ResolvedPromptReference,
  RunPullRequest,
  WorkflowDefinitionLayoutInput,
  WorkflowReplayGraphSnapshot,
  WorkflowReplayLayoutSnapshot,
  WorkflowReplaySelectedTransition,
  WorkflowRunBudgetFailure,
} from "@shared/contracts";
import type { GateStatusRef } from "../adapters/vcs/types.js";
import type { PrePrCheckConfig } from "../pre-pr-checks/config.js";
import { organization } from "./auth-schema.js";

export type McpIdempotencyState = "started" | "completed" | "failed";

export type McpIdempotencyRow = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  idempotencyKey: string;
  payloadHash: string;
  state: McpIdempotencyState;
  safeResponse: unknown | null;
  errorCode: string | null;
  expiresAt: Date;
};

export type McpAuditEventRow = {
  id: string;
  requestId: string;
  traceId: string;
  organizationId: string;
  actorSubject: string;
  clientId: string;
  role: "owner" | "admin" | "member" | "service";
  scopes: string[];
  toolName: string;
  mutationClass: "read" | "direct" | "confirmed";
  targetRefs: string[];
  inputHash: string;
  outputHash: string | null;
  idempotencyKeyHash: string | null;
  outcome: "attempted" | "success" | "rejected" | "failed";
  errorCode: string | null;
  latencyMs: number;
  serverVersion: string;
  contractHash: string;
  occurredAt: Date;
};

export type McpRateLimitWindowRow = {
  organizationId: string;
  actorSubject: string;
  clientId: string;
  toolName: string;
  windowStartedAt: Date;
  requestCount: number;
  expiresAt: Date;
};

export const mcpIdempotencyKeys = pgTable(
  "mcp_idempotency_keys",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    clientId: text("client_id").notNull(),
    toolName: text("tool_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state").$type<McpIdempotencyState>().notNull(),
    safeResponse: jsonb("safe_response").$type<unknown>(),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("mcp_idempotency_keys_namespace_unique").on(
      table.organizationId,
      table.actorSubject,
      table.clientId,
      table.toolName,
      table.idempotencyKey,
    ),
    index("mcp_idempotency_keys_expires_at_idx").on(table.expiresAt),
    check(
      "mcp_idempotency_keys_state_check",
      sql`${table.state} in ('started', 'completed', 'failed')`,
    ),
  ],
);

export const mcpAuditEvents = pgTable(
  "mcp_audit_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    traceId: text("trace_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    clientId: text("client_id").notNull(),
    role: text("role").$type<McpAuditEventRow["role"]>().notNull(),
    scopes: text("scopes").array().notNull(),
    toolName: text("tool_name").notNull(),
    mutationClass: text("mutation_class")
      .$type<McpAuditEventRow["mutationClass"]>()
      .notNull(),
    targetRefs: text("target_refs").array().notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash"),
    idempotencyKeyHash: text("idempotency_key_hash"),
    outcome: text("outcome").$type<McpAuditEventRow["outcome"]>().notNull(),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms").notNull(),
    serverVersion: text("server_version").notNull(),
    contractHash: text("contract_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("mcp_audit_events_organization_occurred_at_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    index("mcp_audit_events_request_id_idx").on(table.requestId),
  ],
);

export const mcpRateLimitWindows = pgTable(
  "mcp_rate_limit_windows",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorSubject: text("actor_subject").notNull(),
    clientId: text("client_id").notNull(),
    toolName: text("tool_name").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
    // Writers set this to two full rate-limit windows after windowStartedAt.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.actorSubject,
        table.clientId,
        table.toolName,
        table.windowStartedAt,
      ],
    }),
    index("mcp_rate_limit_windows_expires_at_idx").on(table.expiresAt),
  ],
);

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
    /** Stable identity of the human action behind this delivery. One review's
     * fan-out of N webhooks shares one key so it accepts exactly one run. */
    semanticKey: text("semantic_key"),
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
    uniqueIndex("trigger_deliveries_semantic_key_idx")
      .on(t.provider, t.semanticKey)
      .where(sql`${t.semanticKey} is not null`),
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
 * At-capacity dispatch queue (AIW-277). One row per ticket the poll refused
 * because every run slot was taken. Mirrors the failed_tickets tombstone shape
 * (PK ticket_key) so a ticket keyed here gets an at-capacity comment
 * at-least-once, effectively-once per episode (the residual gap: a Jira POST
 * that lands but whose confirmed_at write is lost lets a later tick re-post).
 *
 * Suppression/lease semantics use ONLY attempted_at and confirmed_at:
 * - confirmed_at set  = a Jira comment was CONFIRMED sent → suppress further ones.
 * - confirmed_at NULL = never confirmed; attempted_at is a short claim lease so
 *   two overlapping poll ticks don't both send, and a row whose Jira call failed
 *   (attempted_at set, confirmed_at still NULL) is retried by a later tick.
 * queued_at is display-only: it feeds the dashboard "waiting" duration and never
 * gates the lease. The row is dropped when the ticket dispatches or a human
 * moves it out of the AI column (episode over); re-entry re-inserts a fresh one.
 */
export const dispatchCapacityQueue = pgTable("dispatch_capacity_queue", {
  ticketKey: text("ticket_key").primaryKey(),
  queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
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

  // Pull request — gate runs from gate_current (cron); agent runs from the
  // workflow output (workflow write).
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  prRepo: text("pr_repo"),
  /** Every PR/MR an agent run opened, one per changed repository, so a
   * multi-repo run is not reduced to the single prUrl/prNumber above (which
   * stay: gate runs write them, and runs predating this column only have them). */
  prs: jsonb("prs").$type<RunPullRequest[]>(),

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
 * Pre-image audit of every loop carry schema that migration 0051 (AIW-245)
 * rewrote in place. The resync matches a stored carry schema by value against a
 * known prior platform shape, but value alone cannot prove the stored copy was
 * the platform's rather than a customer's step output that happens to be the
 * same shape. So before rewriting, the migration records the exact coordinate
 * and the before-value here, giving an operator the rows changed and the value
 * to revert. The primary key doubles as the idempotency key: the pre-image
 * INSERT is ON CONFLICT DO NOTHING, so re-running the migration captures nothing
 * new. No foreign key, deliberately: the audit must survive a later delete of
 * the version row it describes.
 */
export const carrySchemaResyncAudit = pgTable(
  "carry_schema_resync_audit",
  {
    definitionId: integer("definition_id").notNull(),
    version: integer("version").notNull(),
    /** 0-based index into the definition's nodes array. */
    nodeIndex: integer("node_index").notNull(),
    nodeId: text("node_id"),
    /** 0-based index into the loop node's configuration.carry array. */
    carryIndex: integer("carry_index").notNull(),
    /** Which EMBEDDED_SCHEMA_SOURCES entry the before-value matched. */
    sourceKey: text("source_key").notNull(),
    beforeSchema: jsonb("before_schema").$type<unknown>().notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.definitionId, t.version, t.nodeIndex, t.carryIndex],
    }),
  ],
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
 * One authenticated ingress per webhook trigger node. The id doubles as the
 * public URL path segment, so it is a random opaque value and never the
 * definition id: guessing another tenant's endpoint must not be possible.
 * Secrets live here encrypted (AES-256-GCM under WEBHOOK_TRIGGER_ENCRYPTION_KEY)
 * and are never returned in cleartext after creation. A rotation writes the
 * outgoing secret to previous_secret_ciphertext and keeps accepting it until
 * previous_expires_at, so a caller can be updated without a failed delivery.
 * ON DELETE CASCADE keeps an endpoint subordinate to its definition.
 */
export const webhookTriggerEndpoints = pgTable(
  "webhook_trigger_endpoints",
  {
    id: text("id").primaryKey(),
    definitionId: integer("definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    authScheme: text("auth_scheme").notNull().default("hmac_sha256"),
    /** null means "the scheme's default header name", so changing that default
     *  does not require rewriting rows that never overrode it. */
    headerName: text("header_name"),
    /** Optional hmac_sha256 replay protection: when on, the signature must cover
     *  `${timestamp}.${rawBody}` and the timestamp must be fresh. */
    requireTimestamp: boolean("require_timestamp").notNull().default(false),
    /** null means "the default timestamp header name", mirroring headerName. */
    timestampHeader: text("timestamp_header"),
    timestampToleranceSeconds: integer("timestamp_tolerance_seconds")
      .notNull()
      .default(300),
    secretCiphertext: text("secret_ciphertext").notNull(),
    previousSecretCiphertext: text("previous_secret_ciphertext"),
    previousExpiresAt: timestamp("previous_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "webhook_trigger_endpoints_auth_scheme_check",
      sql`${t.authScheme} in ('hmac_sha256', 'shared_token')`,
    ),
    check(
      "webhook_trigger_endpoints_timestamp_tolerance_check",
      sql`${t.timestampToleranceSeconds} > 0`,
    ),
    uniqueIndex("webhook_trigger_endpoints_definition_node_idx").on(
      t.definitionId,
      t.nodeId,
    ),
  ],
);

/** Authenticated, normalized webhook-delivery inbox. Delivery identity is
 * idempotent per endpoint; at most one row per subject is retained as pending
 * feedback. Deliberately separate from trigger_deliveries: that inbox is keyed
 * by provider and carries VCS-shaped columns this one has no meaning for. */
export const webhookTriggerDeliveries = pgTable(
  "webhook_trigger_deliveries",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookTriggerEndpoints.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    pending: boolean("pending").notNull().default(false),
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.endpointId, t.deliveryId] }),
    uniqueIndex("webhook_trigger_deliveries_one_pending_per_subject_idx")
      .on(t.subjectKey)
      .where(sql`${t.pending} = true`),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "webhook_trigger_deliveries_definition_version_fk",
    }),
  ],
);

/** Fixed-window request counter per endpoint. The window start is part of the
 * key, so an upsert is the whole rate-limit algorithm and expired windows are
 * simply rows nobody reads again. `kind` splits the budget in two: an "ingress"
 * counter charged before authentication (so a URL holder flooding junk cannot
 * burn unbounded CPU) and an "inbox" counter charged only after a valid
 * signature (so junk can never starve the real sender's budget). */
export const webhookTriggerRateLimits = pgTable(
  "webhook_trigger_rate_limits",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookTriggerEndpoints.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    kind: text("kind").notNull().default("inbox"),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.windowStart, t.kind] })],
);

/**
 * Per-day tally of deliveries refused before they became deliveries. A rejected
 * request (bad signature, unknown or revoked endpoint, oversized or unparsable
 * body, rate limit) never writes a webhook_trigger_deliveries row, so without
 * this table the operator reads a clean delivery log while the sender sees
 * nothing but errors. No foreign key on purpose: the endpoint id in a rejection
 * can be one that never existed, which is exactly the case worth surfacing.
 */
export const webhookTriggerRejectionCounters = pgTable(
  "webhook_trigger_rejection_counters",
  {
    endpointId: text("endpoint_id").notNull(),
    /** Floored to the day by the caller. */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.windowStart, t.reason] })],
);

/** Bounded, payload-free evidence for provider webhook health. One row per
 * provider/check/outcome/reason/day keeps authentication failures visible to
 * System Health without turning untrusted requests into an unbounded log. */
export const systemHealthObservationCounters = pgTable(
  "system_health_observation_counters",
  {
    integrationId: text("integration_id").notNull(),
    checkId: text("check_id").notNull(),
    scope: text("scope").notNull().default("deployment"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason").notNull(),
    count: integer("count").notNull().default(1),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.integrationId,
        t.checkId,
        t.scope,
        t.windowStart,
        t.outcome,
        t.reason,
      ],
      name: "system_health_observation_counters_pk",
    }),
  ],
);

/** Fixed-window start counter per trigger node, shared by every automatic
 * trigger type (ticket, PR, schedule, webhook). The window start is part of
 * the key, so one upsert is the whole rate-limit algorithm and an expired
 * window is simply a row nobody reads again. No foreign key: the counter
 * outlives nothing and a deleted definition's rows are harmless. */
export const triggerRateLimits = pgTable(
  "trigger_rate_limits",
  {
    definitionId: text("definition_id").notNull(),
    nodeId: text("node_id").notNull(),
    /**
     * Which fixed window this row counts, part of the key rather than derivable
     * from window_start: at 00:00 UTC on the first of a month all four kinds
     * floor to the SAME instant, so without this column a node whose window an
     * operator just changed would inherit the count of the window it left.
     */
    windowKind: text("window_kind").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  // Named explicitly: the generated name for four columns exceeds Postgres's
  // 63-byte identifier limit, and a silently truncated constraint name drifts
  // from the Drizzle snapshot.
  (t) => [
    primaryKey({
      name: "trigger_rate_limits_pk",
      columns: [t.definitionId, t.nodeId, t.windowKind, t.windowStart],
    }),
  ],
);

/** Per-day tally of trigger starts refused by the node rate limit. A rejected
 * start writes no run row, so this counter is the only trace a saturated
 * trigger leaves behind. Day is stored as an ISO calendar date (UTC). */
export const triggerRejectionCounters = pgTable(
  "trigger_rejection_counters",
  {
    definitionId: text("definition_id").notNull(),
    nodeId: text("node_id").notNull(),
    reason: text("reason").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.nodeId, t.day, t.reason] })],
);

/**
 * Attempt counter for the auto-fix loop, one row per pull request per trigger
 * node. A failing check starts a run that pushes a fix to the same branch, which
 * fails the check again, so without a cap an unfixable pull request loops
 * forever at the cost of an agent run plus a full CI run each time.
 *
 * Keyed on the pull request and not on the node alone, unlike
 * trigger_rate_limits: a node-wide window is one valve for every repository
 * sharing the definition, so a single hopeless pull request would spend the
 * budget of all the others. node_id is in the key too, because two auto-fix
 * nodes of one definition are two independent loops over the same pull request
 * and one exhausting its budget must not silence the other.
 *
 * attempts is a lifetime tally of admitted dispatches: no window, no reset, and
 * therefore no head sha to store. Resetting on a head the workflow did not
 * publish was tried and removed: unreachable under scope "workflow_owned", where
 * the published sha filters the ownership lookup, and unbounded under scope
 * "any", where nothing is ever published so every head looked foreign.
 *
 * No foreign key: rows for a deleted definition or a merged pull request are
 * harmless, and nothing sweeps them.
 */
export const prAutofixAttempts = pgTable(
  "pr_autofix_attempts",
  {
    definitionId: text("definition_id").notNull(),
    nodeId: text("node_id").notNull(),
    provider: text("provider").notNull(),
    repoPath: text("repo_path").notNull(),
    prNumber: integer("pr_number").notNull(),
    attempts: integer("attempts").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  // Named explicitly: the generated name for these five columns is 73 bytes,
  // over Postgres's 63-byte identifier limit, and a silently truncated
  // constraint name drifts from the Drizzle snapshot.
  (t) => [
    primaryKey({
      name: "pr_autofix_attempts_pk",
      columns: [t.definitionId, t.nodeId, t.provider, t.repoPath, t.prNumber],
    }),
  ],
);

/**
 * One row per trigger_schedule node: the server-owned state a cron evaluator
 * reads and writes. The id is a generated opaque value like an endpoint's, on a
 * distinct prefix so a schedule id and a webhook endpoint id can never be
 * mistaken for one another.
 *
 * The four authored columns (cron, timezone, overlap policy, catch-up grace) are
 * re-synced from the head graph on every deploy, exactly the draft -> deploy path
 * every other block parameter follows.
 *
 * paused_at is STICKY across a deploy, because it records a human intention: a
 * customer who pauses a schedule and then redeploys must still have it paused.
 * revoked_at is NOT sticky, and that asymmetry is deliberate. Revoking a webhook
 * endpoint is a security act about a possibly leaked secret, so it may never
 * revive by itself; revoking a schedule only records the structural fact that its
 * node is no longer in the deployed head. A deploy that puts the node back has
 * therefore answered the only question revoked_at was asking, and re-syncing
 * clears it. Without that, a paused schedule whose node was removed and then
 * restored under the same id would be permanently wedged, since no deploy could
 * ever lift the revocation and there is no unrevoke endpoint.
 *
 * ON DELETE CASCADE keeps a schedule subordinate to its definition.
 */
export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: text("id").primaryKey(),
    definitionId: integer("definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    overlapPolicy: text("overlap_policy").notNull().default("skip"),
    catchUpGraceMinutes: integer("catch_up_grace_minutes").notNull().default(60),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /**
     * Bookkeeping cursor, NOT a display value: the newest occurrence instant the
     * evaluator has accounted for, whether it fired, was skipped as stale, or was
     * never worth firing. Minting and resuming also park it at a synthetic instant
     * that never corresponded to an occurrence at all.
     *
     * Named for what it is because it used to be called last_occurrence_at, and
     * under that name a caller reasonably rendered it as "last run": a freshly
     * minted schedule then advertised a run at its creation time and a resumed one
     * advertised a run that never happened. What a reader wants is
     * last_started_occurrence_at below.
     *
     * NOT NULL with a now() default because the default IS the invariant: a row
     * that started at null would make its first evaluation treat every occurrence
     * since the epoch as missed.
     */
    evaluationWatermarkAt: timestamp("evaluation_watermark_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** That an evaluation pass ran at all, including one that found nothing due.
     * Distinct from the watermark on purpose: only this column tells
     * "the scheduler is not running in this environment" (still null, or long
     * stale) apart from "nothing was due yet" (fresh, watermark unmoved). */
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /** The last occurrence that actually started a run, and that run. Written only
     *  when a start is published, so this is the truthful "last run" a UI should
     *  show, and it is the only record of a successful firing that outlives the
     *  occurrence ledger's retention window. */
    lastStartedOccurrenceAt: timestamp("last_started_occurrence_at", {
      withTimezone: true,
    }),
    lastStartedRunId: text("last_started_run_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workflow_schedules_overlap_policy_check",
      sql`${t.overlapPolicy} in ('skip', 'queue', 'allow')`,
    ),
    check(
      "workflow_schedules_catch_up_grace_check",
      sql`${t.catchUpGraceMinutes} > 0`,
    ),
    uniqueIndex("workflow_schedules_definition_node_idx").on(t.definitionId, t.nodeId),
  ],
);

/**
 * Occurrence ledger for schedule triggers, and the whole idempotency story:
 * the occurrence instant is computed from the cron expression, so re-evaluating
 * the same occurrence reproduces an identical primary key and the second write
 * is a conflict instead of a second run. No fallback identity and therefore no
 * bucket edge, unlike the webhook inbox, which has to hash the body into a
 * six-hour tumbling bucket when a sender omits a delivery id.
 *
 * Deliberately separate from webhook_trigger_deliveries and trigger_deliveries:
 * both of those are keyed by a caller-supplied delivery id and carry payload
 * columns a schedule has nothing to put in.
 *
 * The composite foreign key pins the version the occurrence was admitted under,
 * so a redeploy mid-wait cannot silently move an occurrence onto a newer graph.
 */
export const scheduleOccurrences = pgTable(
  "schedule_occurrences",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => workflowSchedules.id, { onDelete: "cascade" }),
    occurrenceAt: timestamp("occurrence_at", { withTimezone: true }).notNull(),
    definitionId: integer("definition_id").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    /**
     * True while this occurrence is still waiting to be dispatched. A row is
     * SETTLED when pending is false and outcome is not null, and settled is
     * terminal. An occurrence that is pending with a non-null skip_reason is not
     * settled: it carries an annotation about a failed or deferred attempt and the
     * drain will try it again.
     */
    pending: boolean("pending").notNull().default(false),
    outcome: text("outcome"),
    /** Machine-readable detail behind a settlement or a retryable annotation
     *  ("at_capacity", "overlap:<instant>", a provider message). Never cleared
     *  once written: a later writer coalesces onto it rather than nulling it, so
     *  the reason an occurrence ended is not overwritten by the reason it was
     *  finally settled. */
    skipReason: text("skip_reason"),
    /** How many older occurrences this row stands in for: the backlog the
     *  evaluator passed over plus any pending occurrence this one superseded. */
    droppedCount: integer("dropped_count").notNull().default(0),
    /** True when dropped_count is a floor rather than an exact number, because
     *  the evaluator stopped counting at its backlog cap. Without this column the
     *  cap would be recorded as an exact count, which would make the persistence
     *  layer invent a number the evaluator deliberately refused to invent. */
    droppedCountCapped: boolean("dropped_count_capped").notNull().default(false),
    /** How many dispatch attempts this occurrence has absorbed. Distinguishes
     *  "the drain never got to it" (0) from "it kept failing" (>1), which one
     *  overwritten skip_reason cannot. */
    attemptCount: integer("attempt_count").notNull().default(0),
    blockingRunId: text("blocking_run_id"),
    runId: text("run_id"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scheduleId, t.occurrenceAt] }),
    uniqueIndex("schedule_occurrences_one_pending_per_schedule_idx")
      .on(t.scheduleId)
      .where(sql`${t.pending} = true`),
    index("schedule_occurrences_run_id_idx").on(t.runId),
    check(
      "schedule_occurrences_outcome_check",
      // Spelled with the null branch even though a null check passes anyway: an
      // undecided occurrence is the normal pending state, not an oversight.
      //
      // There is deliberately no 'skipped_capacity': being at capacity is not a
      // decision about an occurrence, it is a reason it has not run YET. Settling
      // it would break the queue policy's promise that a due occurrence waits, so
      // capacity is recorded as an annotation on a still-pending row instead.
      sql`${t.outcome} is null or ${t.outcome} in ('started', 'skipped_overlap', 'skipped_stale', 'superseded', 'expired', 'cancelled', 'run_cancelled', 'error')`,
    ),
    foreignKey({
      columns: [t.definitionId, t.definitionVersion],
      foreignColumns: [
        workflowDefinitionVersions.definitionId,
        workflowDefinitionVersions.version,
      ],
      name: "schedule_occurrences_definition_version_fk",
    }),
  ],
);

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
    manifest: jsonb("manifest").$type<HarnessProfileManifest>().notNull(),
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
      .$type<HarnessProfileDraftManifest>()
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
 * Organization-scoped, non-secret provider capability discovery cache.
 * Catalog rows are keyed by the exact CLI version used by an immutable
 * Harness Profile so a stale but safe catalog can still be inspected.
 */
export const harnessCapabilityCatalogs = pgTable(
  "harness_capability_catalogs",
  {
    id: serial("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    cliVersion: text("cli_version").notNull(),
    catalog: jsonb("catalog").$type<HarnessCapabilityCatalog>().notNull(),
    catalogHash: text("catalog_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    lastRefreshFailedAt: timestamp("last_refresh_failed_at", {
      withTimezone: true,
    }),
    lastRefreshError: text("last_refresh_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("harness_capability_catalogs_scope_unique").on(
      t.organizationId,
      t.provider,
      t.cliVersion,
    ),
    check(
      "harness_capability_catalogs_provider_check",
      sql`${t.provider} in ('claude', 'codex')`,
    ),
  ],
);

/**
 * Content-addressed, organization-private snapshots of imported skills. The
 * artifact hash covers the exact source, root path, file paths, modes, hashes,
 * and bytes.
 *
 * A row carries exactly one source variant: either the four GitHub columns, or
 * the two local ones describing a directory shipped with the deployment. The
 * variants are told apart by `sourceKind`, which lives here rather than inside
 * the hashed source payload: a discriminator inside that payload would rehash
 * every artifact already stored and unpin every profile pinning it. The shape
 * check makes a half-filled row unrepresentable.
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
    sourceKind: text("source_kind").notNull().default("github"),
    sourceOwner: text("source_owner"),
    sourceRepository: text("source_repository"),
    sourcePath: text("source_path"),
    sourceCommitSha: text("source_commit_sha"),
    localPath: text("local_path"),
    localContentSha256: text("local_content_sha256"),
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
    check(
      "harness_skill_artifacts_source_kind_check",
      sql`${t.sourceKind} in ('github', 'local')`,
    ),
    check(
      "harness_skill_artifacts_source_shape_check",
      sql`(
        ${t.sourceKind} <> 'github'
        or (
          ${t.sourceOwner} is not null
          and ${t.sourceRepository} is not null
          and ${t.sourcePath} is not null
          and ${t.sourceCommitSha} is not null
          and ${t.localPath} is null
          and ${t.localContentSha256} is null
        )
      ) and (
        ${t.sourceKind} <> 'local'
        or (
          ${t.localPath} is not null
          and ${t.localContentSha256} is not null
          and ${t.sourceOwner} is null
          and ${t.sourceRepository} is null
          and ${t.sourcePath} is null
          and ${t.sourceCommitSha} is null
        )
      )`,
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
export * from "./memory-schema.js";
