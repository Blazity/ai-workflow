/**
 * Repository catalog: which repositories this deployment knows, whether the catalog decides access yet, and the versioned profile each repository carries.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  activateRepositoryCatalog,
  readRepositoryCatalog,
  readRepositoryCatalogEntry,
  readRepositoryCatalogVersions,
  saveRepositoryProfile,
  setRepositoryCatalogEnabled,
} from "./authoring.js";
export type {
  RepositoryCatalogActivateOutcome,
  RepositoryCatalogActor,
} from "./authoring.js";
export { isRepositoryEnabled, reportBridge } from "./policy.js";
export type { RepositoryCatalogBridgeReport } from "./policy.js";
export {
  loadRepositoryCatalogSnapshot,
  serializeRepositoryCatalogEntry,
} from "./store.js";
export type { RepositoryCatalogSnapshot } from "./store.js";
export {
  getCurrentRepositoryProfile,
  listRepositoryProfileVersions,
  serializeRepositoryProfileVersion,
} from "./versions.js";
