import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Run registry — replaces the blazebot:active-runs / blazebot:sandboxes /
 * blazebot:entry-timestamps Redis hashes. One row per in-flight ticket;
 * the three hashes shared a lifecycle (unregister cleared all three), so
 * they are one table. createdAt backs reconcile's orphan grace period and
 * is REFRESHED on register(), not just set on claim().
 */
export const activeRuns = pgTable("active_runs", {
  ticketKey: text("ticket_key").primaryKey(),
  runId: text("run_id").notNull(),
  sandboxId: text("sandbox_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
 * bigint[]: GitHub check-run IDs exceed int4 range.
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
 * Written by two upserters that own disjoint columns:
 * - The poll cron snapshots lifecycle/status/ticket/PR(gate) from the
 *   Workflow world + the run registry (see lib/telemetry/collect-snapshots).
 * - The agent workflow records cost/tokens/per-phase usage + the agent PR on
 *   completion — data that only exists inside the run (see recordRunUsage).
 *
 * Both use ON CONFLICT (run_id) DO UPDATE setting only their own columns, so
 * whichever writes first inserts the row and the other fills in the rest,
 * regardless of order.
 */
export const workflowRuns = pgTable("workflow_runs", {
  runId: text("run_id").primaryKey(),

  // Lifecycle — cron-owned (from the Workflow world).
  workflowId: text("workflow_id"),
  workflowName: text("workflow_name"),
  status: text("status"),
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

  // Bookkeeping.
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Built for querying: active-count by status, time-window stats by startedAt,
  // per-ticket run history by ticketKey.
  index("workflow_runs_status_idx").on(t.status),
  index("workflow_runs_started_at_idx").on(t.startedAt),
  index("workflow_runs_ticket_key_idx").on(t.ticketKey),
]);
