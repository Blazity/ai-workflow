/**
 * Repository catalog and the expansion protocol the agent answers with.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
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
