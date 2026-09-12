/**
 * Which repositories a workflow graph PINS that the catalog does not enable.
 *
 * One function, two callers: the MCP `workflows.save_draft` and
 * `workflows.publish` replies, and the REST deploy route the dashboard's Deploy
 * button calls. It used to live inside the MCP tool, which meant an operator
 * deploying from the editor was told nothing at all and the dashboard computed
 * its own answer from its own copy of the catalog. Two surfaces deriving one
 * fact is how they end up disagreeing about it.
 *
 * It lives in this cluster rather than beside `isRepositoryDispatchable`
 * because the question is about the CATALOG, and because the predicate it needs
 * is this cluster's own (`policy.ts`): `isRepositoryDispatchable` is that same
 * predicate with the key built for it, so composing it here adds no second
 * rule and no cross-cluster edge.
 */
import { repositoryCatalogKey } from "@shared/contracts";
import { isRepositoryEnabled } from "./policy.js";
import type { RepositoryCatalogSnapshot } from "./store.js";

/**
 * Takes `unknown` because one caller holds a graph nobody has parsed yet: on
 * the MCP draft path the schema has not run when the reply is composed, so a
 * pin whose provider is not even a string still has to produce a label rather
 * than a crash.
 *
 * On an activated catalog a pin without a usable provider is reported rather
 * than silently passed: the catalog is keyed by provider and path together, so
 * there is no enabled row such a pin could be matched against. While the
 * catalog is not activated nothing is reported at all, because the bridge
 * enables every repository and a field named "not enabled in the catalog" must
 * not accuse a catalog that is refusing nobody.
 */
export function pinnedRepositoriesNotEnabled(
  definition: unknown,
  catalog: RepositoryCatalogSnapshot,
): string[] {
  if (!catalog.activated) return [];
  const scope = (definition as { repositoryScope?: unknown } | null | undefined)
    ?.repositoryScope;
  const pinned = (scope as { repositories?: unknown } | null | undefined)?.repositories;
  if (!Array.isArray(pinned)) return [];
  const notEnabled: string[] = [];
  for (const entry of pinned) {
    const repository = entry as { provider?: unknown; repoPath?: unknown };
    if (typeof repository.repoPath !== "string") continue;
    if (
      (repository.provider === "github" || repository.provider === "gitlab") &&
      isRepositoryEnabled(
        catalog,
        repositoryCatalogKey({
          provider: repository.provider,
          path: repository.repoPath,
        }),
      )
    ) {
      continue;
    }
    notEnabled.push(
      typeof repository.provider === "string"
        ? `${repository.provider}:${repository.repoPath}`
        : repository.repoPath,
    );
  }
  return notEnabled;
}
