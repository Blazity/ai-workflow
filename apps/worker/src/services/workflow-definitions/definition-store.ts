/**
 * The stored definition as the app tier reads it: the store's error classes,
 * its row types and the serializer that turns a version row into the shape the
 * editor renders.
 *
 * Rows and their errors are owned by the db tier (`db/repositories/definitions.ts`),
 * which the app tier may not import. Naming that surface here gives a route the
 * one module it needs instead of the cluster barrel, which reaches the engine
 * through deployment and manual dispatch and so would pull 35 step modules into
 * a request that only reads a row and maps a store error to a status.
 */
export {
  runnableDefinitionOf,
  serializeWorkflowDefinitionVersion,
  WorkflowDefinitionStoreError,
  WorkflowDefinitionValidationError,
} from "../../db/repositories/definitions.js";
export type {
  WorkflowDefinitionDraftRow,
  WorkflowDefinitionRow,
  WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
