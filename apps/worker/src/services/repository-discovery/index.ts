/**
 * Repository catalog and the expansion protocol the agent answers with.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  MAX_ACCESSIBLE_REPOSITORIES,
  buildRepositoryCatalog,
  buildRepositoryCatalogEntries,
} from "./catalog.js";
export type {
  RepositoryCatalogEntry,
} from "./catalog.js";
export {
  listCachedRepositoryDirectory,
  listRepositoryDirectory,
  resetRepositoryDirectoryCacheForTests,
} from "./directory.js";
export {
  validateRepositoryDiscoveryResult,
} from "./protocol.js";
export {
  EXPANSION_LIMIT_CLARIFICATION_PREFIX,
  parseRepositoryExpansionAnswer,
  validateHumanRepositoryExpansion,
  validateRepositoryExpansionRequests,
} from "./runner.js";
export type {
  ParsedRepositoryIdentity,
} from "./runner.js";
