/**
 * The catalog gate: one synchronous answer to "may the agent touch this
 * repository?", given a snapshot somebody already loaded.
 *
 * Synchronous on purpose. The existing allowlist predicate
 * (`engine/support/repo-allowlist.ts`) is synchronous and is called from inside
 * loops over repository listings, expansion protocols and workflow bodies; an
 * async catalog read there would be a database round trip per element, and a
 * workflow body may not read a database at all. So the shape of this file is
 * the shape that file can accept: snapshot in, boolean out, no I/O.
 *
 * The wiring landed in the catalog consumers stage, one file up the tier rather
 * than in the engine as this comment once predicted:
 * `services/dispatch/repo-allowlist.ts` exports
 * `isRepositoryDispatchable(snapshot, { provider, path })` over this function,
 * and each entry point that dispatches (the two webhook handlers, manual
 * dispatch, the poll's dispatch phases, MCP) loads one snapshot per invocation
 * and hands it in. `engine/support/repo-allowlist.ts` is untouched and still
 * guards discovery, branch and pull request creation inside a run from the
 * environment, until the engine wave gives a run its own enabled list.
 */
import type { RepositoryCatalogSnapshot } from "./store.js";

/**
 * True while the catalog is not activated, whatever the tables hold.
 *
 * Row counting is the wrong test and was never offered: a deployment whose
 * catalog is empty because nobody has filled it in yet, and a deployment whose
 * admin has switched the catalog on and enabled nothing, are different states,
 * and only the first may leave the agent unrestricted. Activation is the one
 * explicit action that ends the bridge.
 */
export function isRepositoryEnabled(
  snapshot: RepositoryCatalogSnapshot,
  key: string,
): boolean {
  if (!snapshot.activated) return true;
  return snapshot.enabled.has(key.toLowerCase());
}

export interface RepositoryCatalogBridgeReport {
  bridge: boolean;
  /** What the dashboard banner says, or null when there is nothing to say. */
  message: string | null;
}

/**
 * Say out loud that the catalog is not deciding anything yet.
 *
 * A silent bridge is the failure this reports: an operator who has filled in a
 * catalog reasonably reads it as the list of repositories the agent may touch,
 * and until activation it is not that list at all.
 */
export function reportBridge(
  snapshot: RepositoryCatalogSnapshot,
): RepositoryCatalogBridgeReport {
  if (snapshot.activated) return { bridge: false, message: null };
  return {
    bridge: true,
    message:
      "The repository catalog is not activated: the agent sees everything the installation sees. " +
      "Activate it on Repositories to make the enabled list decide.",
  };
}
