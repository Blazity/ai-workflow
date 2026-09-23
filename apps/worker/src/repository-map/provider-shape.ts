import { integrationsProviding } from "@integrations/registry";

/**
 * Whether a repository path under this provider may be deeper than
 * `owner/name`.
 *
 * Core used to answer this by asking whether the provider was called `github`,
 * in the link parser and again in the catalog's path validator. A fourth
 * provider would have had to be added to both. The manifest answers it now
 * (`repositories.nestedPaths`), so neither place names a provider.
 *
 * The general answer is yes, which is what an unknown provider and a provider
 * that declares nothing both get: cutting a nested path short would silently
 * point at a different repository, while one segment too many is only ever
 * refused by the catalog.
 */
export function providerNestsRepositoryPaths(provider: string | undefined): boolean {
  if (!provider) return true;
  const manifest = integrationsProviding("vcs").find(
    (candidate) => candidate.id === provider,
  );
  return manifest?.repositories?.nestedPaths !== false;
}
