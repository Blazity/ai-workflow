import {
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
