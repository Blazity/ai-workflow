/**
 * May this repository be dispatched? One synchronous answer, from a catalog
 * snapshot somebody already loaded.
 *
 * This file used to re-export the environment-backed allowlist
 * (`engine/support/repo-allowlist.ts`), which read the allowlist variable on
 * every call and let a workflow definition's repository pin EXTEND that list.
 * Neither is true here any more:
 *
 *   - the decision comes from the repository catalog, read once per invocation
 *     (an HTTP request, a cron tick, an MCP call) and handed in;
 *   - a pin is a selection INSIDE the catalog. A definition that pins a
 *     repository the catalog does not enable no longer has its EVENTS
 *     dispatched, which is why stage C's seed imported every pinned repository
 *     as an enabled row: no deployment loses a repository at the switchover.
 *     The pin is not dead yet, and this comment must not pretend otherwise:
 *     until the engine wave (stage X) `engine/support/repo-allowlist.ts` still
 *     reads it inside a run, so a run that starts some other way reaches a
 *     pinned repository whatever the catalog says.
 *
 * While the catalog is not activated every repository passes, which is the
 * bridge `services/repository-catalog/policy.ts` describes and the behaviour a
 * deployment that has never opened the Repositories page still has.
 *
 * The engine keeps its own allowlist module until the engine wave (stage X)
 * gives a run its enabled list at run start; nothing here imports it.
 */
import { repositoryCatalogKey, type VcsProviderKind } from "@shared/contracts";
import {
  isRepositoryEnabled,
  type RepositoryCatalogSnapshot,
} from "../repository-catalog/index.js";

/**
 * What a caller refused by the catalog is told.
 *
 * One string, because the operator's next action is the same everywhere it is
 * shown: open Repositories and enable the row. It deliberately does not name an
 * environment variable, which is what the message it replaced did.
 */
export const REPOSITORY_NOT_IN_CATALOG_REASON =
  "This repository is not enabled in the repository catalog.";

/**
 * True when the catalog lets this repository be dispatched.
 *
 * Synchronous by design: the callers are inside loops over candidate events and
 * over repository listings, and an await per element would be a database round
 * trip per element.
 */
export function isRepositoryDispatchable(
  snapshot: RepositoryCatalogSnapshot,
  repository: { provider: VcsProviderKind; path: string },
): boolean {
  return isRepositoryEnabled(snapshot, repositoryCatalogKey(repository));
}
