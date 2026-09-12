/**
 * A repository's profile history, one page at a time, and how long it is.
 *
 * `versions.ts` and `authoring.ts` answer "the newest rows, up to a limit",
 * which is what the History tab renders and all it needs: a person scrolling a
 * screen can see there is more. An agent cannot. So this adds the two facts a
 * protocol has to carry instead of show -- whether older versions exist, and
 * how many there are in total -- without changing what either of those does.
 *
 * The count is a count, not the length of a list. A surface that reported
 * `versions.length` for "how many versions exist" would answer 50 for a
 * repository with four hundred, and it would be wrong precisely on the
 * repositories somebody has been configuring hardest.
 */
import {
  REPOSITORY_VERSION_PAGE_DEFAULT,
  type RepositoryCatalogVersionsResponse,
  type RepositoryProfileVersion,
} from "@shared/contracts";
import {
  countConnectedRepositoryProfileVersionRows,
  listConnectedRepositoryProfileVersionPageRows,
} from "../../db/repositories/repository-catalog-history.js";
import { readRepositoryCatalogEntry } from "./authoring.js";
import { serializeRepositoryProfileVersion } from "./versions.js";

export interface RepositoryProfileVersionPage {
  versions: RepositoryProfileVersion[];
  /** Whether versions older than the last one on this page exist. */
  hasMore: boolean;
}

/**
 * One page of a repository's profile versions, newest first.
 *
 * `before` takes a version number and means "older than this", so the pages of
 * a history somebody is still writing to do not overlap or skip.
 *
 * An empty page is the one case that needs a second question: a repository the
 * catalog has never held and a repository nobody has configured both have no
 * versions, and only one of them is a mistake the caller should hear about. So
 * the 404 is raised there and nowhere else, rather than paying for an existence
 * check on every page of every history.
 */
export async function readRepositoryProfileVersionPage(input: {
  repositoryId: number;
  limit: number;
  before?: number;
}): Promise<RepositoryProfileVersionPage> {
  // One row past the page, to answer "is there more" without a second count:
  // it is read and then dropped, never returned.
  const rows = await listConnectedRepositoryProfileVersionPageRows({
    repositoryId: input.repositoryId,
    limit: input.limit + 1,
    before: input.before,
  });
  if (rows.length === 0) {
    await readRepositoryCatalogEntry(input.repositoryId);
    return { versions: [], hasMore: false };
  }
  return {
    versions: rows.slice(0, input.limit).map(serializeRepositoryProfileVersion),
    hasMore: rows.length > input.limit,
  };
}

/**
 * One page of a repository's history, as the HTTP versions route answers it.
 *
 * The same page the MCP tool reads, through the same function, with the same
 * default and the same ceiling: an unpaged route was a latency and payload
 * cliff the agent surface did not have, and two pagers over one table is how
 * the two answers start disagreeing about where a page ends.
 *
 * The BOUND is not restated here. `repositoryCatalogVersionsQuerySchema` owns
 * it for both callers, and a second clamp in this function would be a second
 * place the ceiling could be raised in, quietly disagreeing with the number the
 * query is refused against. Only the default is applied, because a caller that
 * names no limit gives the schema nothing to refuse.
 */
export async function readRepositoryCatalogVersions(input: {
  id: number;
  limit?: number;
  before?: number;
}): Promise<RepositoryCatalogVersionsResponse> {
  const limit = input.limit ?? REPOSITORY_VERSION_PAGE_DEFAULT;
  const page = await readRepositoryProfileVersionPage({
    repositoryId: input.id,
    limit,
    ...(input.before === undefined ? {} : { before: input.before }),
  });
  return { versions: page.versions, hasMore: page.hasMore };
}

/** How many profile versions a repository has. Counted in the database. */
export function countRepositoryProfileVersions(repositoryId: number): Promise<number> {
  return countConnectedRepositoryProfileVersionRows(repositoryId);
}
