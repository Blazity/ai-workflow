import { isTriggerBlockType } from "@shared/contracts";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../db/schema.js";
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
  options: { includeReview: boolean },
): Promise<void> {
  for (const template of workflowDefinitionTemplates(options).slice(1)) {
    const marker = `System template:${template.id}`;
    const findExisting = () =>
      db
        .select({ id: workflowDefinitions.id })
        .from(workflowDefinitions)
        .where(
          or(
            eq(workflowDefinitions.createdByLabel, marker),
            and(eq(workflowDefinitions.name, template.name), isNull(workflowDefinitions.archivedAt)),
          ),
        )
        .limit(1);
    const existing = await findExisting();
    if (existing.length > 0) continue;

    let definitionId: number;
    try {
      const created = await db
        .insert(workflowDefinitions)
        .values({
          name: template.name,
          enabled: false,
          triggerTypes: [],
          layout: extractWorkflowDefinitionLayout(template.definition),
          layoutRevision: 1,
          createdById: "system",
          createdByLabel: marker,
        })
        .returning({ id: workflowDefinitions.id });
      definitionId = created[0]!.id;
    } catch (error) {
      if ((await findExisting()).length > 0) continue;
      throw error;
    }

    try {
      await db.insert(workflowDefinitionVersions).values({
        definitionId,
        version: 1,
        definition: canonicalizeWorkflowDefinition(template.definition),
        createdById: "system",
        createdByLabel: marker,
        restoredFromVersion: null,
      });
      await db
        .update(workflowDefinitions)
        .set({
          deployedVersion: 1,
          triggerTypes: template.definition.nodes
            .map((node) => node.type)
            .filter(isTriggerBlockType),
        })
        .where(eq(workflowDefinitions.id, definitionId));
    } catch (error) {
      await db
        .delete(workflowDefinitionVersions)
        .where(eq(workflowDefinitionVersions.definitionId, definitionId));
      await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, definitionId));
      throw error;
    }
  }
}
