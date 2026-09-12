/**
 * The suggestions table's whole database surface: write one call, read a
 * repository's calls back, and count a recent window of them.
 *
 * Writes are inserts and nothing else. A suggestion is never updated: it
 * happened, it cost what it cost, and a later edit to the profile it proposed
 * does not change that.
 */
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type {
  RepositorySuggestionOutcome,
  RepositorySuggestionUsage,
} from "@shared/contracts";
import { getDb, type Db } from "../client.js";
import { repositorySuggestions } from "../schema.js";

export type RepositorySuggestionRow = typeof repositorySuggestions.$inferSelect;

/** The newest calls first, which is the only order a cost page or a history
 *  panel reads them in. */
const DEFAULT_SUGGESTION_LIST_LIMIT = 50;

export interface InsertRepositorySuggestionInput {
  repositoryId: number;
  actorId: string;
  actorLabel: string;
  model: string;
  outcome: RepositorySuggestionOutcome;
  /** Null for a call the provider never reported usage for, which is what a
   *  timeout usually looks like. */
  usage: RepositorySuggestionUsage | null;
  /** Null from the suggestion path: tokens are recorded, the price is not
   *  resolved per call. */
  costUsd?: number | null;
  error?: string;
}

export async function insertRepositorySuggestion(
  db: Db,
  input: InsertRepositorySuggestionInput,
): Promise<RepositorySuggestionRow> {
  const [row] = await db
    .insert(repositorySuggestions)
    .values({
      repositoryId: input.repositoryId,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      model: input.model,
      outcome: input.outcome,
      tokensInput: input.usage?.inputTokens ?? null,
      tokensCached: input.usage?.cachedTokens ?? null,
      tokensOutput: input.usage?.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      error: input.error ?? "",
    })
    .returning();
  if (!row) throw new Error("repository suggestion insert returned no row");
  return row;
}

export function listRepositorySuggestions(
  db: Db,
  repositoryId: number,
  limit: number = DEFAULT_SUGGESTION_LIST_LIMIT,
) {
  return db
    .select()
    .from(repositorySuggestions)
    .where(eq(repositorySuggestions.repositoryId, repositoryId))
    .orderBy(desc(repositorySuggestions.createdAt), desc(repositorySuggestions.id))
    .limit(limit);
}

/**
 * How many calls this repository has had since `since`, and when the oldest of
 * them was.
 *
 * Both in one query because the rate limit needs both: the count decides
 * whether to refuse, and the oldest row in the window decides when the window
 * moves, which is the only honest answer to "when may I try again". Counting
 * alone would leave the caller telling every refused admin to wait the whole
 * window even when it lifts in four seconds.
 *
 * Rows, not tokens: the cap exists to stop a stuck screen from making calls in
 * a loop, and a loop is visible in the row count long before it is visible in
 * a bill.
 */
export async function countRepositorySuggestionsSince(
  db: Db,
  repositoryId: number,
  since: Date,
): Promise<{ count: number; oldestAt: Date | null }> {
  const rows = await db
    .select({ createdAt: repositorySuggestions.createdAt })
    .from(repositorySuggestions)
    .where(
      and(
        eq(repositorySuggestions.repositoryId, repositoryId),
        gte(repositorySuggestions.createdAt, since),
      ),
    )
    .orderBy(asc(repositorySuggestions.createdAt));
  return { count: rows.length, oldestAt: rows[0]?.createdAt ?? null };
}

export function countConnectedRepositorySuggestionsSince(
  repositoryId: number,
  since: Date,
) {
  return countRepositorySuggestionsSince(getDb(), repositoryId, since);
}

export function insertConnectedRepositorySuggestion(
  input: InsertRepositorySuggestionInput,
) {
  return insertRepositorySuggestion(getDb(), input);
}
