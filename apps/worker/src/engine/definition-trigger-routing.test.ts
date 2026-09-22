import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { getEnabledWorkflowDefinitionForTrigger } from "./definition-trigger-routing.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/**
 * Dispatch decides trust from the graph routing hands it, so routing is where
 * a check trigger published before S10 has to be upgraded. The row itself is
 * deliberately left as it was written.
 */
describe("routing a check trigger published before S10", () => {
  it("hands dispatch the one trust list the stored filters meant", async () => {
    const published = {
      schemaVersion: 2,
      nodes: [{
        id: "trigger",
        type: "trigger_pr_checks_failed",
        x: 0,
        y: 0,
        // GitHub narrowed to one app; GitLab never touched, so it still
        // trusted GitLab's default source.
        configuration: { scope: "any", checkNames: ["ci / build"], githubAppSlugs: ["circleci"] },
        inputs: {},
        additionalInputs: [],
      }],
      edges: [],
    };
    await db.insert(workflowDefinitions).values({
      id: 7,
      name: "Fix failed checks",
      enabled: true,
      triggerTypes: ["trigger_pr_checks_failed"],
      createdById: "test",
      createdByLabel: "Test",
    });
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 7,
      version: 1,
      definition: published,
      createdById: "test",
      createdByLabel: "Test",
    });
    await db
      .update(workflowDefinitions)
      .set({ deployedVersion: 1 })
      .where(eq(workflowDefinitions.id, 7));

    const routed = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_checks_failed");

    expect(routed?.definition.id).toBe(7);
    const configuration = (routed?.current?.definition as typeof published | undefined)?.nodes[0]
      ?.configuration;
    expect(configuration).toEqual({
      scope: "any",
      checkNames: ["ci / build"],
      trustedProducers: ["circleci", "merge_request_event"],
    });
    const [row] = await db
      .select({ definition: workflowDefinitionVersions.definition })
      .from(workflowDefinitionVersions)
      .where(eq(workflowDefinitionVersions.definitionId, 7));
    expect(row?.definition).toEqual(published);
  });
});
