import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
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
