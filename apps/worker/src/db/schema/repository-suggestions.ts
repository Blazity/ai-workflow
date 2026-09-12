import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { repositories } from "./repositories.js";

/**
 * Every suggestion call, whatever it ended as.
 *
 * It exists so the cost page can show what suggestions cost WITHOUT a run id:
 * a suggestion is not a run, it has no workflow, no ticket and no gate, and
 * the only other table that records model usage is keyed by one. That is the
 * whole reason for a separate table rather than a column somewhere.
 *
 * A row is written for a timeout and for a malformed answer too. Those calls
 * are billed exactly like the ones that worked, and an admin retrying a
 * repository the model keeps failing on is the case where the bill and the
 * visible result diverge most.
 *
 * Nothing here is written to the repository's profile. The proposal goes back
 * to the caller and dies there unless the admin saves it through the profile
 * route, which is the only path that mints a version.
 */
export const repositorySuggestions = pgTable(
  "repository_suggestions",
  {
    id: serial("id").primaryKey(),
    repositoryId: integer("repository_id")
      .notNull()
      .references((): AnyPgColumn => repositories.id, { onDelete: "cascade" }),
    /** Who asked. Recorded with the label as it read at the time, the way a
     *  profile version records it, so a cost page does not have to resolve a
     *  user that may since have left. */
    actorId: text("actor_id").notNull(),
    actorLabel: text("actor_label").notNull(),
    /** The model that actually answered, not the one that was configured. */
    model: text("model").notNull(),
    outcome: text("outcome").notNull(),
    /**
     * Tokens as the provider reported them, or null.
     *
     * Null is **unpriced**, not free. It means the call ended before the
     * provider reported anything: a timeout, a repository that turned out to be
     * missing, a bundle that never loaded. A cost page must render such a row
     * as unpriced rather than as 0.00, because zero says the call was free and
     * a timeout against a provider that had already begun work is not.
     */
    tokensInput: integer("tokens_input"),
    tokensCached: integer("tokens_cached"),
    tokensOutput: integer("tokens_output"),
    /**
     * What the call cost, when something priced it.
     *
     * Written null by the suggestion path, exactly as the call_llm block
     * leaves its own usage: the price table is fetched over the network and
     * resolving it per call would put an HTTP dependency on a path whose whole
     * point is one bounded provider call. The column is here so the cost page
     * can price a page of rows at once and write the answer back.
     *
     * numeric(19,4), matching workflow_runs.cost_usd, so a rollup across both
     * does not drift the way float would.
     */
    costUsd: numeric("cost_usd", { precision: 19, scale: 4, mode: "number" }),
    /**
     * How long the call took, in milliseconds, as the caller measured it.
     *
     * Recorded next to the tokens because the two answer different questions on
     * the same row: a timeout costs no tokens and all of the wall clock, and a
     * history that showed only "unpriced" for it would leave an admin unable to
     * tell a provider that hung from one that refused instantly. Nullable for a
     * row written before this column existed.
     */
    durationMs: integer("duration_ms"),
    /** Why it failed, in words, empty for a proposal. Not a code: the useful
     *  half of a provider failure is its own message. */
    error: text("error").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("repository_suggestions_repository_idx").on(t.repositoryId, t.createdAt),
    // Spelled out rather than joined from the contract's list: drizzle-kit
    // serializes a parameterized `sql` fragment into the migration as `$1`,
    // which is not SQL a migrator can run.
    //
    // What keeps the two in step is not a comment but a test:
    // `repository-suggestions.test.ts` inserts EVERY value of
    // REPOSITORY_SUGGESTION_OUTCOMES against this constraint as the migration
    // actually created it, and a separate case inserts one the contract does
    // not name and expects the refusal. Adding an outcome to the contract
    // without adding it here fails the first; loosening this without the
    // contract fails the second.
    check(
      "repository_suggestions_outcome_check",
      sql`${t.outcome} in ('proposed', 'timeout', 'malformed', 'failed', 'missing')`,
    ),
  ],
);
