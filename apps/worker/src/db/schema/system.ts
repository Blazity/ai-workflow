import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  SystemHealthResponse,
} from "@shared/contracts";

export const envMarker = pgTable("env_marker", {
  id: integer("id").primaryKey(),
  env: text("env").notNull(),
  endpointHost: text("endpoint_host").notNull(),
});

/**
 * Durable run telemetry - one row per workflow run, keyed by runId. Survives
 * far longer than Vercel's ~24h observability window so run history, active
 * counts, and per-run cost stay queryable with plain SQL.
 *
 * Written by three upserters that own disjoint columns:
 * - The poll cron snapshots lifecycle/status/ticket/PR(gate) from the
 *   Workflow world + the run registry (see lib/telemetry/collect-snapshots).
 * - The agent workflow records cost/tokens/per-phase usage + the agent PR on
 *   completion - data that only exists inside the run (see recordRunUsage).
 * - The mid-run block-status writer owns exactly block_statuses,
 *   definition_version and definition_id (plus updated_at), streaming
 *   per-block progress as the run advances through the stored definition.
 *
 * All use ON CONFLICT (run_id) DO UPDATE setting only their own columns, so
 * whichever writes first inserts the row and the others fill in the rest,
 * regardless of order.
 */

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

/** The last System Health scan, one row per deployment. The Health screen
 * shows this on load so nobody has to rescan just to see the current state;
 * a new scan overwrites it. The report is stored as the API response shape. */
export const systemHealthScans = pgTable("system_health_scans", {
  scope: text("scope").primaryKey().default("deployment"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  report: jsonb("report").$type<SystemHealthResponse>().notNull(),
});

/** Fixed-window start counter per trigger node, shared by every automatic
 * trigger type (ticket, PR, schedule, webhook). The window start is part of
 * the key, so one upsert is the whole rate-limit algorithm and an expired
 * window is simply a row nobody reads again. No foreign key: the counter
 * outlives nothing and a deleted definition's rows are harmless. */
