/**
 * What is left of the file that used to own both halves of definition
 * validation: a re-export, kept alive only for importers this stage did not
 * own.
 *
 * The structural rules now live in `@shared/workflow-graph` and the deployment
 * half in `./deployment-validation.js`. Everything listed below is re-exported
 * for exactly two files under `apps/worker/src/engine`, which parallel lanes
 * hold: `engine/definition/block-params-schemas.ts` (the five shapes the params
 * map composes from) and `engine/steps/clarification.ts` (the any-scope review
 * check, loaded through a dynamic import inside a step function; the directive
 * is deliberately not spelled here, because the builder and the repository
 * guards find step files by scanning text).
 *
 * Stage 7 of the workflow-graph plan deletes this file. Nothing new may import
 * it: the package and `./deployment-validation.js` are the addresses.
 */
export {
  transformConfigurationSchema,
  v2BranchConfigurationSchema,
  v2LoopConfiguration,
  validateAnyScopeReviewSafety,
  vcsProviderSelection,
  workflowInputBindingV2Schema,
} from "@shared/workflow-graph";
