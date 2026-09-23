import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import type { Db } from "../../db/client.js";

vi.mock("../../infra/vcs-config.js", () => ({
  env: { ANTHROPIC_API_KEY: "sk-ant-test", CODEX_API_KEY: "sk-codex-test" },
}));

import { createTestDb } from "../../db/test-db.js";
import {
  createDefinitionsRepository,
  getWorkflowDefinition,
  type WorkflowDefinitionActor,
} from "../../db/repositories/definitions.js";
import {
  createWorkflowDefinitionDraft,
  deployWorkflowDefinition,
  restoreWorkflowDefinitionVersion,
  rollbackWorkflowDefinition,
  saveWorkflowDefinitionDraft,
  saveWorkflowDefinitionVersion,
  updateWorkflowDefinition,
} from "./policy-operations.js";

/**
 * What the issue tracker's query rule may take away, on a real database.
 *
 * Jira's adapter always dropped a template like `labels = 'backend` (a quote
 * never closed) at run time, and core's old check let it be saved. Such
 * templates are deployed today. The rule refuses a template an author is
 * writing now; it must never cost a definition that already runs one its
 * incident tools (disable and re-enable, rollback, restore) or an edit to
 * another block.
 */

const ADMIN: WorkflowDefinitionActor = { role: "admin", id: "u_admin", label: "Admin" };
const LIVE_TEMPLATE = "labels = 'backend";

// Jira connected the way a deployment connects it from its environment, so
// it is the one usable tracker and its rule is the one asked.
Object.assign(process.env, {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_API_TOKEN: "jira-token",
  JIRA_PROJECT_KEY: "OPS",
});

function graph(template: string, maxResults = 5): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "start",
        type: "trigger_plan_approved",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "look",
        type: "investigate",
        x: 0,
        y: 0,
        configuration: { sources: ["issue_tracker"], issueTrackerQueryTemplate: template, maxResults },
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [{ id: "start-look", from: "start", to: "look" }],
  };
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/** A definition deployed before the rule existed: stored as data, past every check. */
async function deployedWithLiveTemplate(): Promise<number> {
  const created = await createWorkflowDefinitionDraft(db, {
    name: "Triage",
    seed: graph(LIVE_TEMPLATE),
    actor: ADMIN,
  });
  const selected = await createDefinitionsRepository(db).selectDeployment({
    definitionId: created.definition.id,
    expectedDraftRevision: created.draftRevision,
    expectedDeployedVersion: null,
    triggerTypes: ["trigger_plan_approved"],
    bindingTriggerTypes: ["trigger_plan_approved"],
  });
  expect(selected).not.toBeNull();
  return created.definition.id;
}

describe("the tracker's query rule against a template that is already live", () => {
  it("does not stop the definition being disabled and enabled again", async () => {
    const id = await deployedWithLiveTemplate();
    await updateWorkflowDefinition(db, { definitionId: id, enabled: false, actor: ADMIN });
    const enabled = await updateWorkflowDefinition(db, { definitionId: id, enabled: true, actor: ADMIN });
    expect(enabled.enabled).toBe(true);
  });

  it("saves and deploys a change to another setting of the same definition", async () => {
    const id = await deployedWithLiveTemplate();
    const version = await saveWorkflowDefinitionVersion(db, {
      definitionId: id,
      definition: graph(LIVE_TEMPLATE, 7),
      actor: ADMIN,
    });
    expect(version.version).toBeGreaterThan(1);

    const current = (await getWorkflowDefinition(db, id))!;
    const draft = await saveWorkflowDefinitionDraft(db, {
      definitionId: id,
      definition: graph(LIVE_TEMPLATE, 8),
      expectedDraftRevision: current.draftRevision,
      actor: ADMIN,
    });
    const deployed = await deployWorkflowDefinition(db, {
      definitionId: id,
      expectedDraftRevision: draft.draftRevision,
      expectedDeployedVersion: current.deployedVersion,
      actor: ADMIN,
    });
    expect(deployed.definition.deployedVersion).toBe(draft.draftRevision);
  });

  it("rolls back to and restores the version that carries it", async () => {
    const id = await deployedWithLiveTemplate();
    await saveWorkflowDefinitionVersion(db, { definitionId: id, definition: graph("labels = support"), actor: ADMIN });
    const current = (await getWorkflowDefinition(db, id))!;
    const draft = await saveWorkflowDefinitionDraft(db, {
      definitionId: id,
      definition: graph("labels = support"),
      expectedDraftRevision: current.draftRevision,
      actor: ADMIN,
    });
    const moved = await deployWorkflowDefinition(db, {
      definitionId: id,
      expectedDraftRevision: draft.draftRevision,
      expectedDeployedVersion: current.deployedVersion,
      actor: ADMIN,
    });
    // The deployed version no longer carries the template, so only the paths
    // that bring a stored version back are left, and neither asks the rule.
    const rolledBack = await rollbackWorkflowDefinition(db, {
      definitionId: id,
      version: 1,
      expectedDeployedVersion: moved.definition.deployedVersion,
      actor: ADMIN,
    });
    expect(rolledBack.definition.deployedVersion).toBe(1);
    const restored = await restoreWorkflowDefinitionVersion(db, { definitionId: id, version: 1, actor: ADMIN });
    expect((restored.definition as WorkflowDefinitionV2).nodes[1]?.configuration.issueTrackerQueryTemplate).toBe(LIVE_TEMPLATE);
  });

  it("refuses a template the author changes to one Jira would not run, on save and on deploy", async () => {
    const id = await deployedWithLiveTemplate();
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: id, definition: graph("labels = 'x"), actor: ADMIN }),
    ).rejects.toThrow(/Jira would not run this query/u);

    const current = (await getWorkflowDefinition(db, id))!;
    const draft = await saveWorkflowDefinitionDraft(db, {
      definitionId: id,
      definition: graph("labels = 'x"),
      expectedDraftRevision: current.draftRevision,
      actor: ADMIN,
    });
    await expect(
      deployWorkflowDefinition(db, {
        definitionId: id,
        expectedDraftRevision: draft.draftRevision,
        expectedDeployedVersion: current.deployedVersion,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "tracker_query_refused" })] });
    expect((await getWorkflowDefinition(db, id))?.deployedVersion).toBe(current.deployedVersion);
  });
});
