import { integrationsProviding } from "@integrations/registry";
import { providerNestsRepositoryPaths } from "./provider-shape.js";

/**
 * The example repository path a sentence shows when it teaches somebody, or
 * some model, how to name a repository.
 *
 * A repository is named `provider:owner/name`, and every sentence that asks for
 * one has to show what that looks like. Writing the example out meant writing
 * one provider's id into the sentence, and those sentences are read where being
 * wrong costs the most: in the ticket comment a person answers, and in the
 * prompt a model answers from. On a deployment that connected GitLab and no
 * GitHub, an example scoped to GitHub asks for a repository that cannot exist
 * there, and the answer it produces is refused by the catalog for naming a
 * provider the deployment does not have.
 *
 * THE PROVIDER COMES FROM WHAT THE CALLER IS LOOKING AT, not from what this
 * build ships. Every repository a caller holds, whether as a catalog entry, a
 * listing or a recorded key, came from a provider this deployment CONNECTED,
 * and the registry answers a different question: which providers this build
 * COULD serve. A build that ships GitHub and GitLab while one of them is
 * connected would otherwise show the other one's example, and the answer it
 * invites is refused by the catalog it came from.
 *
 * `observed` takes provider ids or whole `provider:path` keys, in the order the
 * caller holds them; the first is the example, and `repositoryPathExamples`
 * lists them all. Nothing observed falls back to the registry, which is right
 * for a deployment with one integration and a guess on a deployment with
 * several: a caller with repositories in hand should pass them.
 *
 * `provider` is what stands in when this build ships no version control
 * integration at all. Nothing can be worked on then and no such sentence is
 * reachable; the word keeps the shape readable instead of leaving a stray colon
 * if one ever is.
 *
 * This module is plain data on purpose: `repo-selection.ts` and the sandbox
 * context both run inside a Workflow DevKit step, where a Node module fails the
 * Vercel build and nothing local. Reading manifests imports none. It lives in
 * `repository-map/` with the path shape it reads for the same reason the map
 * does: the engine and the sandbox both use it, and a copy in either would
 * make the other import it (ADR-001).
 */
export function exampleRepositoryPath(
  repoPath: string,
  observed?: Iterable<string>,
): string {
  const provider = providerIds(observed)[0] ?? shippedProviderIds()[0] ?? "provider";
  return `${provider}:${repoPath}`;
}

/**
 * Every provider a person could name here, quoted and listed, for the one
 * sentence that teaches the format instead of showing an instance of it.
 *
 * A question asking somebody to attach a repository is answered by typing a
 * path, so the example has to be typeable. `"provider:owner/repo"` is not: the
 * word `provider` is a placeholder only the author of the sentence can see, and
 * an answer copying it names a provider that does not exist. So this lists what
 * the caller can actually offer, with each provider's own depth, because
 * `group/repo` and `owner/repo` are the difference between a path that resolves
 * and one the catalog refuses.
 */
export function repositoryPathExamples(observed?: Iterable<string>): string {
  const ids = providerIds(observed);
  const examples = (ids.length > 0 ? ids : shippedProviderIds()).map(
    (id) => `"${id}:${providerNestsRepositoryPaths(id) ? "group/repo" : "owner/repo"}"`,
  );
  if (examples.length === 0) return `"${exampleRepositoryPath("owner/repo")}"`;
  return examples.length === 1
    ? examples[0]!
    : `${examples.slice(0, -1).join(", ")} or ${examples.at(-1)}`;
}

/** Provider ids in the order the caller holds them, each once. Accepts a whole
 *  `provider:path` key, because that is the shape most callers already have. */
function providerIds(observed: Iterable<string> | undefined): string[] {
  if (!observed) return [];
  const ids: string[] = [];
  for (const value of observed) {
    const id = value.split(":")[0]?.trim().toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function shippedProviderIds(): string[] {
  return integrationsProviding("vcs").map((manifest) => manifest.id);
}
