/**
 * The failures the harness surfaces answer with, named where the app tier can
 * reach them.
 *
 * All three are thrown by modules the engine and db tiers own
 * (`harness-profiles/capability-catalog.ts`, `harness-profiles/github-skills.ts`
 * and `harness-profiles/store.ts`), and a route may not import those tiers. So a
 * route that only has to map one of these to a status names this module instead
 * of the cluster's whole interface.
 */
export {
  HarnessCapabilityCatalogError,
} from "../../harness-profiles/capability-catalog.js";
export {
  HarnessSkillImportError,
} from "../../harness-profiles/github-skills.js";
export {
  HarnessProfileStoreError,
} from "../../harness-profiles/store.js";
