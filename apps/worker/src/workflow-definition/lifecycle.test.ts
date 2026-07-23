import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  WorkflowBlockTypeV1,
  WorkflowDefinitionV1,
} from "@shared/contracts";
import type { Db } from "../db/client.js";

vi.mock("../../env.js", () => ({
  env: {
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test",
    CODEX_MODEL: "codex-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    GITLAB_TOKEN: "gitlab-token",
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
    GENAI_ENGINE_API_KEY: "arthur-key",
    GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/traces",
  },
}));

import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinition,
  deployWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowDefinitionDraft,
  getEnabledWorkflowDefinitionForTrigger,
  listWorkflowDefinitions,
  listWorkflowDefinitionVersionRows,
  rollbackWorkflowDefinition,
  saveWorkflowDefinitionDraft,
  saveWorkflowDefinitionLayout,
  saveWorkflowDefinitionVersion,
  updateWorkflowDefinition,
  type WorkflowDefinitionActor,
} from "./store.js";

const ADMIN: WorkflowDefinitionActor = { role: "admin", id: "u_admin", label: "Admin" };

function graph(trigger: WorkflowBlockTypeV1, x = 10): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    nodes: [{ id: "trigger", type: trigger, x, y: 20, params: {}, inputs: {} }],
    edges: [],
  };
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("workflow definition lifecycle", () => {
  it("saves semantic drafts and layout through independent CAS revisions", async () => {
    const created = await createWorkflowDefinition(db, { name: "Draft", seed: null, actor: ADMIN });
    const saved = await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_created", 25),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });

    expect(saved.draftRevision).toBe(1);
    expect(saved.draft.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect((await listWorkflowDefinitionVersionRows(db, created.definition.id)).map((v) => v.version)).toEqual([1]);

    await expect(
      saveWorkflowDefinitionDraft(db, {
        definitionId: created.definition.id,
        definition: graph("trigger_pr_created"),
        expectedDraftRevision: 0,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const layout = await saveWorkflowDefinitionLayout(db, {
      definitionId: created.definition.id,
      layout: {
        nodes: { trigger: { x: 99, y: 101 } },
        edges: {
          "stable-edge": { bend: { x: 150, y: 175 } },
        },
      },
      expectedLayoutRevision: 0,
      actor: ADMIN,
    });
    expect(layout.layoutRevision).toBe(1);
    expect(layout.layout.edges).toEqual({
      "stable-edge": { bend: { x: 150, y: 175 } },
    });
    expect((await getWorkflowDefinitionDraft(db, created.definition.id))?.draft.nodes[0]).toMatchObject({
      x: 99,
      y: 101,
    });
    expect((await getWorkflowDefinition(db, created.definition.id))?.draftRevision).toBe(1);
  });

  it("normalizes legacy layout writes and rejects malformed edge geometry", async () => {
    const created = await createWorkflowDefinition(db, {
      name: "Legacy layout",
      seed: null,
      actor: ADMIN,
    });
    await db
      .update(workflowDefinitions)
      .set({ layout: { nodes: { trigger: { x: 5, y: 15 } } } })
      .where(eq(workflowDefinitions.id, created.definition.id));
    expect(
      (await getWorkflowDefinition(db, created.definition.id))?.layout,
    ).toEqual({
      nodes: { trigger: { x: 5, y: 15 } },
      edges: {},
    });
    const legacy = await saveWorkflowDefinitionLayout(db, {
      definitionId: created.definition.id,
      layout: { nodes: { trigger: { x: 10, y: 20 } } },
      expectedLayoutRevision: 0,
      actor: ADMIN,
    });
    expect(legacy.layout).toEqual({
      nodes: { trigger: { x: 10, y: 20 } },
      edges: {},
    });

    await expect(
      saveWorkflowDefinitionLayout(db, {
        definitionId: created.definition.id,
        layout: {
          nodes: {},
          edges: {
            broken: {
              bend: { x: Number.NaN, y: 20 },
            },
          },
        },
        expectedLayoutRevision: 1,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("deploys immutable snapshots, leaves the draft live-neutral, and rollback selects without copying", async () => {
    const created = await createWorkflowDefinition(db, { name: "Deploy", seed: null, actor: ADMIN });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_created"),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });
    const first = await deployWorkflowDefinition(db, {
      definitionId: created.definition.id,
      expectedDraftRevision: 1,
      expectedDeployedVersion: null,
      actor: ADMIN,
    });
    expect(first.version.version).toBe(1);
    expect(first.definition.deployedVersion).toBe(1);

    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_review"),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    const second = await deployWorkflowDefinition(db, {
      definitionId: created.definition.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });
    expect(second.version.version).toBe(2);

    const rolledBack = await rollbackWorkflowDefinition(db, {
      definitionId: created.definition.id,
      version: 1,
      expectedDeployedVersion: 2,
      actor: ADMIN,
    });
    expect(rolledBack.version.version).toBe(1);
    expect(await listWorkflowDefinitionVersionRows(db, created.definition.id)).toHaveLength(2);
    expect((await getWorkflowDefinition(db, created.definition.id))?.deployedVersion).toBe(1);
  });

  it("rejects enabling definitions without a deployment but preserves the fresh seed fallback", async () => {
    const created = await createWorkflowDefinition(db, { name: "Not deployed", seed: null, actor: ADMIN });
    await expect(
      updateWorkflowDefinition(db, { definitionId: created.definition.id, enabled: true, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const fallback = await getWorkflowDefinition(db, 1);
    expect(fallback).toMatchObject({ enabled: true, deployedVersion: null, draftRevision: 0 });
  });

  it("keeps fallback identity across rename and does not infer it for a lookalike", async () => {
    await updateWorkflowDefinition(db, { definitionId: 1, name: "Renamed fallback", actor: ADMIN });
    expect((await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai"))?.definition.id).toBe(1);

    const lookalike = await createWorkflowDefinition(db, {
      name: "Ticket workflow",
      seed: null,
      actor: ADMIN,
    });
    await expect(
      updateWorkflowDefinition(db, { definitionId: lookalike.definition.id, enabled: true, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Deploy a valid draft before enabling" });
  });

  it("rejects stale deploy state without appending a snapshot", async () => {
    const created = await createWorkflowDefinition(db, { name: "CAS", seed: null, actor: ADMIN });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_created"),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });
    await expect(
      deployWorkflowDefinition(db, {
        definitionId: created.definition.id,
        expectedDraftRevision: 0,
        expectedDeployedVersion: null,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.select().from(workflowDefinitionVersions)).toHaveLength(1);
  });

  it("keeps enabled dispatch pinned while a new draft and legacy snapshot are saved", async () => {
    const created = await createWorkflowDefinition(db, { name: "Live neutral", seed: null, actor: ADMIN });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_created"),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: created.definition.id,
      expectedDraftRevision: 1,
      expectedDeployedVersion: null,
      actor: ADMIN,
    });
    await updateWorkflowDefinition(db, { definitionId: created.definition.id, enabled: true, actor: ADMIN });

    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_review"),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await saveWorkflowDefinitionVersion(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_review"),
      actor: ADMIN,
    });

    const live = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created");
    expect(live?.current?.version).toBe(1);
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).toBeNull();
    expect(await getWorkflowDefinition(db, created.definition.id)).toMatchObject({
      deployedVersion: 1,
      triggerTypes: ["trigger_pr_created"],
    });
  });

  it("refuses to enable with trigger claims derived from a stale deployed pointer", async () => {
    const created = await createWorkflowDefinition(db, { name: "Enable CAS", seed: null, actor: ADMIN });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_created"),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: created.definition.id,
      expectedDraftRevision: 1,
      expectedDeployedVersion: null,
      actor: ADMIN,
    });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.definition.id,
      definition: graph("trigger_pr_review"),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });

    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "execute") return Reflect.get(target, property, receiver);
        return async (...args: unknown[]) => {
          if (!raced) {
            raced = true;
            await deployWorkflowDefinition(db, {
              definitionId: created.definition.id,
              expectedDraftRevision: 2,
              expectedDeployedVersion: 1,
              actor: ADMIN,
            });
          }
          // The proxy is only a scheduling seam for this race regression. The
          // real SQL still executes through the same database handle.
          return (db.execute as (...executeArgs: unknown[]) => unknown)(...args);
        };
      },
    }) as Db;

    await expect(
      updateWorkflowDefinition(racingDb, {
        definitionId: created.definition.id,
        enabled: true,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Definition changed; reload before updating",
    });

    expect(raced).toBe(true);
    expect(await getWorkflowDefinition(db, created.definition.id)).toMatchObject({
      enabled: false,
      deployedVersion: 2,
      triggerTypes: ["trigger_pr_review"],
    });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created")).toBeNull();
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).toBeNull();
  });

  it("atomically preserves one active definition across concurrent archives", async () => {
    const second = await createWorkflowDefinition(db, {
      name: "Second active definition",
      seed: null,
      actor: ADMIN,
    });
    await updateWorkflowDefinition(db, { definitionId: 1, enabled: false, actor: ADMIN });

    const results = await Promise.allSettled([
      archiveWorkflowDefinition(db, { definitionId: 1, actor: ADMIN }),
      archiveWorkflowDefinition(db, { definitionId: second.definition.id, actor: ADMIN }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          statusCode: 409,
          message: "Cannot archive the last workflow definition",
        }),
      }),
    ]);
    expect(await listWorkflowDefinitions(db)).toHaveLength(1);
  });
});
