/**
 * The gap between "enabled in the catalog" and "reachable inside a run".
 *
 * REMOVED IN STAGE X together with `engine/support/repo-allowlist.ts`. Until
 * that stage gives a run its own enabled list, dispatch and the run obey two
 * different lists: the catalog decides whether an event is dispatched at all,
 * and `AGENT_ALLOWED_REPOS` still decides what the run may then read, branch and
 * open a pull request on. Enabling a repository the variable omits therefore
 * buys a run that starts and fails late, at promotion or at PR creation, which
 * is the worst of the three possible behaviours because it costs an agent
 * invocation before it says no.
 *
 * So the enable route says it out loud at the moment an operator flips the
 * switch. It asks the engine's own predicate rather than re-deriving the answer
 * from the variable: a second parser would eventually disagree with the guard
 * that actually refuses the run, and the empty-means-unrestricted default (no
 * variable, no gap, no warning) is already encoded there.
 *
 * It lives here, in the services tier, only because the tier gate has no
 * app-to-infra and no app-to-engine edge (scripts/gates/tiers.json); nothing in
 * the catalog service itself consults it, and the route is its only caller.
 */
import { isRepoAllowed } from "../../engine/support/repo-allowlist.js";

/** What the operator is told, naming both halves they now have to keep in step. */
export const ENGINE_ALLOWLIST_GAP_WARNING =
  "This repository is not in AGENT_ALLOWED_REPOS, so a run dispatched for it " +
  "still fails inside the engine, at promotion or pull request creation. Add it " +
  "there as well until the engine stage removes that variable.";

/**
 * The warnings an enable answers with. Empty for a disable (nothing starts), and
 * empty while the variable is unset, where the engine guard already lets
 * everything through.
 */
export function engineAllowlistWarnings(input: {
  enabled: boolean;
  path: string;
}): string[] {
  if (!input.enabled) return [];
  return isRepoAllowed(input.path) ? [] : [ENGINE_ALLOWLIST_GAP_WARNING];
}
