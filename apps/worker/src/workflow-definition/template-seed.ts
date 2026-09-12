import {
  isTriggerBlockType,
  type HarnessProvider,
  type HarnessProfileReference,
} from "@shared/contracts";
import type { Db } from "../db/types.js";
import { seedWorkflowDefinitionTemplate } from "../db/repositories/definitions.js";
import { canonicalizeWorkflowDefinition, extractWorkflowDefinitionLayout } from "./layout.js";
import { workflowDefinitionTemplates } from "./templates.js";

/**
 * Adds the three optional starter workflows once. The ticket workflow is
 * created by migration 0013 and deliberately remains the only enabled one.
 * The system marker survives renames and archives, so deleting a starter does
 * not cause it to reappear on the next deployment.
 */
export async function seedWorkflowDefinitionTemplates(
  db: Db,
  options: {
    includeReview: boolean;
    includeLeakReview?: boolean;
    provider?: HarnessProvider;
    profileReference?: HarnessProfileReference;
  },
): Promise<number[]> {
  const definitionIds: number[] = [];
  for (const template of workflowDefinitionTemplates(options).slice(1)) {
    const marker = `System template:${template.id}`;
    definitionIds.push(await seedWorkflowDefinitionTemplate(db, {
      name: template.name,
      marker,
      layout: extractWorkflowDefinitionLayout(template.definition),
      definition: canonicalizeWorkflowDefinition(template.definition),
      triggerTypes: template.definition.nodes
        .map((node) => node.type)
        .filter(isTriggerBlockType),
    }));
  }
  return definitionIds;
}
