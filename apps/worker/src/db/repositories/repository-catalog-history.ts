/**
 * Paging a repository's profile history, and counting it.
 *
 * Its own file rather than two functions appended to `repository-catalog.ts`:
 * it arrived with the MCP parity stage while the catalog stage owned that file,
 * and a later change may fold the two together. The three tables stay behind
 * the repository tier either way, which is what keeps the client fence at zero.
 *
 * Only the connected halves are exported: nothing in this stage passes its own
 * handle, and an export nobody imports is one more thing the unused-code gate
 * has to be told about.
 *
 * `repository-catalog.ts` already lists versions with a limit. What it cannot
 * do is answer "and is there more", or "how many are there in total", and a
 * surface that hands an agent the newest 50 rows without either is telling it
 * the history is 50 long.
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "../client.js";
import { repositoryProfileVersions } from "../schema.js";

/**
 * One page of profile versions, newest first.
 *
 * `before` is a version NUMBER and not an offset, because a page read while
 * somebody saves would otherwise repeat or skip a row: versions are immutable
 * once written, so "older than this version" answers the same rows whatever
 * lands in the meantime.
 */
function listRepositoryProfileVersionPageRows(
  db: Db,
  input: { repositoryId: number; limit: number; before?: number },
) {
  const olderThan =
    input.before === undefined
      ? undefined
      : lt(repositoryProfileVersions.version, input.before);
  return db
    .select()
    .from(repositoryProfileVersions)
    .where(
      olderThan === undefined
        ? eq(repositoryProfileVersions.repositoryId, input.repositoryId)
        : and(eq(repositoryProfileVersions.repositoryId, input.repositoryId), olderThan),
    )
    .orderBy(desc(repositoryProfileVersions.version))
    .limit(input.limit);
}

/** How many profile versions this repository has, whatever page the caller is
 *  holding. Counted in the database rather than by measuring a list, which is
 *  the number of rows somebody asked for and not the number that exist. */
async function countRepositoryProfileVersionRows(
  db: Db,
  repositoryId: number,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(repositoryProfileVersions)
    .where(eq(repositoryProfileVersions.repositoryId, repositoryId));
  return rows[0]?.total ?? 0;
}

export function listConnectedRepositoryProfileVersionPageRows(input: {
  repositoryId: number;
  limit: number;
  before?: number;
}) {
  return listRepositoryProfileVersionPageRows(getDb(), input);
}

export function countConnectedRepositoryProfileVersionRows(
  repositoryId: number,
): Promise<number> {
  return countRepositoryProfileVersionRows(getDb(), repositoryId);
}
