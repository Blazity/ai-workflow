/**
 * What `@shared/workflow-graph`'s scheduler borrows from this worker, bound
 * once.
 *
 * The walk has to measure two things it cannot judge on its own: a carried loop
 * value against its declared JSON Schema, and a produced block output against
 * the contract its own params resolve to. Both answers come from worker modules
 * the package may not import (ajv in `workflow-definition/json-schema.ts`, the
 * block registry in `workflow-definition/block-registry.ts`), so the package
 * declares the shape and this is the whole adapter. The functions already have
 * the shape it declares, so nothing is converted here.
 *
 * Sibling of `json-schema-support.ts`, and bound for the same reason.
 */
import type { SchedulerDependencies } from "@shared/workflow-graph";
import { validateBlockOutputForDefinition } from "../../workflow-definition/block-registry.js";
import { validateJsonSchemaValue } from "../../workflow-definition/json-schema.js";

export const SCHEDULER_DEPENDENCIES: SchedulerDependencies = {
  validateBlockOutput: validateBlockOutputForDefinition,
  validateJsonSchemaValue,
};
