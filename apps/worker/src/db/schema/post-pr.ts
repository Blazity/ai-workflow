import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { GateStatusRef } from "./runs.js";

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
 * different VERCEL_ENV on the SAME endpoint host, the build fails -
 * preview must never share production's Neon branch. A differing endpoint
 * host means the branch was copied (Neon branches copy data), so the
 * marker is re-claimed instead of failing.
 */
