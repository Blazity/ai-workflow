/**
 * The suggestions table's whole database surface: write one call, read a
 * repository's calls back, and count a recent window of them.
 *
 * Writes are inserts and nothing else. A suggestion is never updated: it
 * happened, it cost what it cost, and a later edit to the profile it proposed
 * does not change that.
 */
import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
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
  /** How long the call took, as the caller measured it. */
  durationMs?: number | null;
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
      durationMs: input.durationMs ?? null,
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
 * How a page of the history says where it stopped.
 *
 * The created timestamp AND the id, because two calls can land in the same
 * millisecond and the list orders by both. Opaque to the caller, which is what
 * lets the shape change without a contract change.
 */
export interface RepositorySuggestionCursor {
  createdAt: Date;
  id: number;
}

function encodeRepositorySuggestionCursor(
  cursor: RepositorySuggestionCursor,
): string {
  return `${cursor.createdAt.toISOString()}|${cursor.id}`;
}

/** Null for anything this function did not write. A cursor a client invented is
 *  a bad request, not a page of somebody else's rows. */
export function decodeRepositorySuggestionCursor(
  raw: string,
): RepositorySuggestionCursor | null {
  const separator = raw.lastIndexOf("|");
  if (separator <= 0) return null;
  const createdAt = new Date(raw.slice(0, separator));
  const id = Number(raw.slice(separator + 1));
  if (Number.isNaN(createdAt.getTime())) return null;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { createdAt, id };
}

/**
 * One page of a repository's suggestion calls, newest first.
 *
 * Keyset, not offset. Rows are only ever appended, so an offset page shifts
 * under a reader the moment somebody asks for a suggestion, and the two things
 * a cost history must never do are show a row twice and skip one. The keyset
 * predicate is the same pair the ordering uses, so the two cannot disagree.
 *
 * One row past the page is fetched and dropped, which is how "is there another
 * page" is answered without a second count query.
 */
async function listRepositorySuggestionsPage(
  db: Db,
  input: {
    repositoryId: number;
    limit?: number;
    cursor?: RepositorySuggestionCursor | null;
  },
): Promise<{ rows: RepositorySuggestionRow[]; nextCursor: string | null }> {
  const limit = input.limit ?? DEFAULT_SUGGESTION_LIST_LIMIT;
  const keyset = input.cursor
    ? or(
        lt(repositorySuggestions.createdAt, input.cursor.createdAt),
        and(
          sql`${repositorySuggestions.createdAt} = ${input.cursor.createdAt}`,
          lt(repositorySuggestions.id, input.cursor.id),
        ),
      )
    : undefined;
  const rows = await db
    .select()
    .from(repositorySuggestions)
    .where(
      keyset
        ? and(eq(repositorySuggestions.repositoryId, input.repositoryId), keyset)
        : eq(repositorySuggestions.repositoryId, input.repositoryId),
    )
    .orderBy(desc(repositorySuggestions.createdAt), desc(repositorySuggestions.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last
        ? encodeRepositorySuggestionCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
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

export function listConnectedRepositorySuggestionsPage(input: {
  repositoryId: number;
  limit?: number;
  cursor?: RepositorySuggestionCursor | null;
}) {
  return listRepositorySuggestionsPage(getDb(), input);
}
