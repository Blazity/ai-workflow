import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowDefinition,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
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
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));
import { env } from "../../env.js";
import {
  webhookTriggerEndpoints,
  workflowDefinitions,
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
  workflowSchedules,
  scheduleOccurrences,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowDefinitionDraft,
  deployWorkflowDefinition,
  getCurrentWorkflowDefinitionVersion,
  getEnabledWorkflowDefinitionForTrigger,
  getRawWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
  listWorkflowDefinitions,
  listWorkflowDefinitionVersionRows,
  listWorkflowDefinitionVersions,
  restoreWorkflowDefinitionVersion,
  rollbackWorkflowDefinition,
  saveWorkflowDefinitionDraft,
  saveWorkflowDefinitionVersion,
  updateWorkflowDefinition,
  WorkflowDefinitionStoreError,
  type WorkflowDefinitionActor,
} from "./store.js";
import { seedWorkflowDefinitionTemplates } from "./template-seed.js";

const ADMIN: WorkflowDefinitionActor = { role: "admin", id: "u_admin", label: "Admin" };
const MEMBER: WorkflowDefinitionActor = { role: "member", id: "u_member", label: "Member" };

/** Minimal definition the store's write validation accepts: a bare trigger is a
 *  complete graph. The store reads node types to derive trigger_types. A
 *  trigger-less graph is not valid, so a definition with no trigger is made with
 *  `seed: null` (no version) instead. */
function def(
  triggers: WorkflowBlockTypeV1[] = ["trigger_ticket_ai"],
): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    nodes: triggers.map((type, i) => ({ id: `n${i}`, type, x: 0, y: 0, params: {}, inputs: {} })),
    edges: [],
  };
}

/** A graph that is well-shaped but structurally invalid (an unreachable block),
 *  standing in for a version stored before a schema/rule tightened. */
function invalidDef(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
      { id: "orphan", type: "open_pr", x: 0, y: 0, params: {}, inputs: {} },
    ],
    edges: [],
  };
}

function invalidBindingDef(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
      { id: "approval", type: "send_plan_approval", x: 0, y: 0, params: {}, inputs: {} },
    ],
    edges: [{ from: "t", to: "approval" }],
  };
}

function legacyStructuredOutputDef(
  trigger: WorkflowBlockTypeV1 = "trigger_pr_review",
): WorkflowDefinitionV1 {
  const outputSchema = JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Legacy classifier",
    type: "object",
    properties: {
      state: { title: "State", type: "string" },
      metadata: {
        type: "object",
        properties: { note: { type: "string" } },
      },
    },
    required: ["state"],
    additionalProperties: false,
  });
  return {
    schemaVersion: 1,
    nodes: [
      { id: "trigger", type: trigger, x: 0, y: 0, params: {}, inputs: {} },
      {
        id: "classify",
        type: "call_llm",
        x: 0,
        y: 0,
        params: { prompt: "Classify", outputSchema },
        inputs: {},
      },
    ],
    edges: [{ from: "trigger", to: "classify" }],
  };
}

/** The definition the 0013 migration seeds. */
const SEEDED_DEFAULT_ID = 1;

async function triggerTypesOf(db: Db, definitionId: number): Promise<string[]> {
  const row = await getWorkflowDefinition(db, definitionId);
  return row!.triggerTypes;
}

async function createDeployed(
  name: string,
  definition: WorkflowDefinition,
): Promise<Awaited<ReturnType<typeof getWorkflowDefinition>> & {}> {
  const created = (await createWorkflowDefinition(db, { name, seed: null, actor: ADMIN })).definition;
  await saveWorkflowDefinitionDraft(db, {
    definitionId: created.id,
    definition,
    expectedDraftRevision: 0,
    actor: ADMIN,
  });
  await deployWorkflowDefinition(db, {
    definitionId: created.id,
    expectedDraftRevision: 1,
    expectedDeployedVersion: null,
    actor: ADMIN,
  });
  return (await getWorkflowDefinition(db, created.id))!;
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  loggerMock.warn.mockClear();
});

describe("migration seed", () => {
  it("seeds one enabled default definition handling trigger_ticket_ai with no versions", async () => {
    const defs = await listWorkflowDefinitions(db);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({
      id: SEEDED_DEFAULT_ID,
      name: "Ticket workflow",
      enabled: true,
      triggerTypes: ["trigger_ticket_ai"],
      currentVersion: null,
      createdById: "system",
      createdByLabel: "System migration",
    });
  });
});

describe("starter template seed", () => {
  it("adds the eight disabled starter workflows exactly once", async () => {
    await seedWorkflowDefinitionTemplates(db, { includeReview: true });
    await seedWorkflowDefinitionTemplates(db, { includeReview: true });

    const defs = await listWorkflowDefinitions(db);
    expect(defs.map((definition) => definition.name)).toEqual([
      "Ticket workflow",
      "Human-approved plan",
      "Review & fix after PR",
      "Reviewed ticket workflow",
      "Post-PR review",
      "Post-PR review with autofix",
      "Fully modular",
      "Ticket triage (webhook)",
      "Support investigation (Zendesk + Sentry)",
    ]);
    expect(defs.map((definition) => definition.enabled)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(defs.slice(1).map((definition) => definition.draftRevision)).toEqual([
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
    ]);
    expect(defs.slice(1).map((definition) => definition.deployedVersion)).toEqual([
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
    ]);
    expect(defs.slice(1).map((definition) => definition.triggerTypes)).toEqual([
      ["trigger_ticket_ai", "trigger_plan_approved"],
      ["trigger_pr_checks_failed", "trigger_pr_review"],
      ["trigger_ticket_ai"],
      ["trigger_pr_ready", "trigger_pr_updated"],
      ["trigger_pr_ready", "trigger_pr_updated"],
      ["trigger_ticket_ai"],
      ["trigger_webhook"],
      ["trigger_webhook", "trigger_webhook"],
    ]);
  });
});

describe("createWorkflowDefinition", () => {
  it("rejects a structurally valid seed with invalid typed bindings", async () => {
    await expect(
      createWorkflowDefinition(db, { name: "Invalid bindings", seed: invalidBindingDef(), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates a disabled definition with an optional v1 without claiming live triggers", async () => {
    const created = await createWorkflowDefinition(db, {
      name: "With seed",
      seed: def(["trigger_ticket_ai"]),
      actor: ADMIN,
    });
    expect(created.definition.enabled).toBe(false);
    expect(created.definition.triggerTypes).toEqual([]);
    expect(created.current?.version).toBe(1);
    expect(created.current?.definitionId).toBe(created.definition.id);

    const noSeed = await createWorkflowDefinition(db, { name: "No seed", seed: null, actor: ADMIN });
    expect(noSeed.current).toBeNull();
    expect(noSeed.definition.triggerTypes).toEqual([]);
  });
});

describe("per-definition version numbering", () => {
  it("numbers versions 1..n independently per definition even when interleaved", async () => {
    const a = (await createWorkflowDefinition(db, { name: "A", seed: null, actor: ADMIN })).definition;
    const b = (await createWorkflowDefinition(db, { name: "B", seed: null, actor: ADMIN })).definition;

    const save = (id: number) => saveWorkflowDefinitionVersion(db, { definitionId: id, definition: def(), actor: ADMIN });
    expect((await save(a.id)).version).toBe(1);
    expect((await save(b.id)).version).toBe(1);
    expect((await save(a.id)).version).toBe(2);
    expect((await save(b.id)).version).toBe(2);
    expect((await save(a.id)).version).toBe(3);

    const aVersions = await listWorkflowDefinitionVersionRows(db, a.id);
    const bVersions = await listWorkflowDefinitionVersionRows(db, b.id);
    expect(aVersions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(bVersions.map((v) => v.version)).toEqual([2, 1]);
    expect(aVersions.every((v) => v.definitionId === a.id)).toBe(true);
  });
});

describe("legacy version read normalization", () => {
  it("returns canonical inputs from current, exact-version, and list reads", async () => {
    const created = await createWorkflowDefinition(db, { name: "Legacy inputs", seed: null, actor: ADMIN });
    const legacyDefinition = {
      schemaVersion: 1,
      nodes: [{ id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {} }],
      edges: [],
    };
    await db.insert(workflowDefinitionVersions).values({
      definitionId: created.definition.id,
      version: 1,
      definition: legacyDefinition,
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const current = await getCurrentWorkflowDefinitionVersion(db, created.definition.id);
    const exact = await getWorkflowDefinitionVersion(db, created.definition.id, 1);
    const listed = await listWorkflowDefinitionVersionRows(db, created.definition.id);

    expect(current?.definition.nodes[0].inputs).toEqual({});
    expect(exact?.definition.nodes[0].inputs).toEqual({});
    expect(listed[0]?.definition.nodes[0].inputs).toEqual({});
  });

  it("removes a retired arthur_trace block and preserves the surrounding path", async () => {
    const created = await createWorkflowDefinition(db, { name: "Legacy trace", seed: null, actor: ADMIN });
    await db.insert(workflowDefinitionVersions).values({
      definitionId: created.definition.id,
      version: 1,
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
          { id: "trace", type: "arthur_trace", x: 1, y: 0, params: {} },
          { id: "open", type: "open_pr", x: 2, y: 0, params: {} },
        ],
        edges: [
          { from: "trigger", to: "trace" },
          { from: "trace", to: "open", fromPort: "out" },
        ],
      },
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const raw = await getRawWorkflowDefinitionVersion(
      db,
      created.definition.id,
      1,
    );
    const current = await getCurrentWorkflowDefinitionVersion(db, created.definition.id);
    expect(
      (raw?.definition as { nodes: Array<{ type: string }> }).nodes.map(
        (node) => node.type,
      ),
    ).toEqual(["trigger_ticket_ai", "arthur_trace", "open_pr"]);
    expect(current?.definition.nodes.map((node) => node.type)).toEqual([
      "trigger_ticket_ai",
      "finalize_workspace",
      "open_pr",
    ]);
    expect(current?.definition.nodes.find((node) => node.id === "open")?.inputs).toEqual({
      repositories: "steps.open-finalize.output.repositories",
    });
    expect(current?.definition.edges).toEqual([
      { from: "trigger", to: "open-finalize" },
      { from: "open-finalize", to: "open" },
    ]);
  });
});

describe("restoreWorkflowDefinitionVersion", () => {
  it("appends a copy of an earlier version with restoredFromVersion set", async () => {
    const d = (await createWorkflowDefinition(db, { name: "R", seed: null, actor: ADMIN })).definition;
    await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(["trigger_ticket_ai"]), actor: ADMIN });
    await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(["trigger_pr_created"]), actor: ADMIN });

    const restored = await restoreWorkflowDefinitionVersion(db, { definitionId: d.id, version: 1, actor: ADMIN });
    expect(restored.version).toBe(3);
    expect(restored.restoredFromVersion).toBe(1);
    expect(restored.definition).toEqual(def(["trigger_ticket_ai"]));
  });

  it("404s on a version that does not belong to the definition", async () => {
    const d = (await createWorkflowDefinition(db, { name: "R2", seed: null, actor: ADMIN })).definition;
    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: d.id, version: 99, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not see another definition's versions", async () => {
    const a = (await createWorkflowDefinition(db, { name: "RA", seed: null, actor: ADMIN })).definition;
    const b = (await createWorkflowDefinition(db, { name: "RB", seed: null, actor: ADMIN })).definition;
    await saveWorkflowDefinitionVersion(db, { definitionId: a.id, definition: def(), actor: ADMIN });
    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: b.id, version: 1, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("VERSION_LIST_LIMIT", () => {
  it("returns at most 50 versions per definition, newest first", async () => {
    const d = (await createWorkflowDefinition(db, { name: "Many", seed: null, actor: ADMIN })).definition;
    for (let i = 0; i < 55; i++) {
      await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(), actor: ADMIN });
    }
    const versions = await listWorkflowDefinitionVersionRows(db, d.id);
    expect(versions).toHaveLength(50);
    expect(versions[0].version).toBe(55);
    expect(versions[49].version).toBe(6);
  });
});

describe("name uniqueness", () => {
  it("rejects a duplicate active name with 409 and frees the name once archived", async () => {
    await createWorkflowDefinition(db, { name: "Alpha", seed: null, actor: ADMIN });
    await expect(
      createWorkflowDefinition(db, { name: "Alpha", seed: null, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Archive the first Alpha (the seeded default keeps count > 1), then reuse.
    const alpha = (await listWorkflowDefinitions(db)).find((d) => d.name === "Alpha")!;
    await archiveWorkflowDefinition(db, { definitionId: alpha.id, actor: ADMIN });
    const reused = await createWorkflowDefinition(db, { name: "Alpha", seed: null, actor: ADMIN });
    expect(reused.definition.name).toBe("Alpha");
  });

  it("rejects a rename onto an existing active name with 409", async () => {
    const a = (await createWorkflowDefinition(db, { name: "One", seed: null, actor: ADMIN })).definition;
    await createWorkflowDefinition(db, { name: "Two", seed: null, actor: ADMIN });
    await expect(
      updateWorkflowDefinition(db, { definitionId: a.id, name: "Two", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("enabled-per-trigger overlap", () => {
  it("409s when enabling a definition whose trigger another enabled definition handles", async () => {
    // The seeded default is enabled and handles trigger_ticket_ai.
    const b = await createDeployed("B", def(["trigger_ticket_ai"]));
    await expect(
      updateWorkflowDefinition(db, { definitionId: b.id, enabled: true, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows two definitions with disjoint triggers to both be enabled", async () => {
    const c = await createDeployed("C", def(["trigger_pr_created"]));
    const d = await createDeployed("D", def(["trigger_pr_review"]));
    expect((await updateWorkflowDefinition(db, { definitionId: c.id, enabled: true, actor: ADMIN })).enabled).toBe(true);
    expect((await updateWorkflowDefinition(db, { definitionId: d.id, enabled: true, actor: ADMIN })).enabled).toBe(true);
  });

  it("allows two webhook definitions to both be enabled at once", async () => {
    // AIW-238: trigger_webhook routes per endpoint, not as a global singleton, so
    // enabling a second webhook definition never conflicts with the first. Every
    // other trigger stays a singleton (see the trigger_ticket_ai case above).
    const webhookGraph = (): WorkflowDefinitionV2 => ({
      schemaVersion: 2,
      nodes: [
        {
          id: "hook",
          type: "trigger_webhook",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [],
    });
    // The webhook block is only deployable when the encryption key is configured,
    // so set it on the mocked env for this test's duration (mirrors the minting
    // suite). Enabling itself needs no key: minting is best-effort.
    const mutableEnv = env as { WEBHOOK_TRIGGER_ENCRYPTION_KEY?: string };
    mutableEnv.WEBHOOK_TRIGGER_ENCRYPTION_KEY = "a".repeat(64);
    try {
      const a = await createDeployed("Webhook A", webhookGraph());
      const b = await createDeployed("Webhook B", webhookGraph());

      expect(
        (await updateWorkflowDefinition(db, { definitionId: a.id, enabled: true, actor: ADMIN })).enabled,
      ).toBe(true);
      expect(
        (await updateWorkflowDefinition(db, { definitionId: b.id, enabled: true, actor: ADMIN })).enabled,
      ).toBe(true);

      // "at once": re-read confirms enabling B did not disable A. Both remain
      // enabled webhook owners at the same time, which a singleton would forbid.
      const enabledWebhookDefs = (await listWorkflowDefinitions(db)).filter(
        (definition) =>
          definition.enabled && definition.triggerTypes.includes("trigger_webhook"),
      );
      expect(enabledWebhookDefs.map((definition) => definition.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
    } finally {
      delete mutableEnv.WEBHOOK_TRIGGER_ENCRYPTION_KEY;
    }
  });

  it("keeps an overlapping draft live-neutral and 409s only when it is deployed", async () => {
    const d = await createDeployed("Draft overlap", def(["trigger_pr_created"]));
    await updateWorkflowDefinition(db, { definitionId: d.id, enabled: true, actor: ADMIN });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: d.id,
      definition: def(["trigger_ticket_ai"]),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await expect(
      deployWorkflowDefinition(db, {
        definitionId: d.id,
        expectedDraftRevision: 2,
        expectedDeployedVersion: 1,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("recomputes trigger_types on deploy and rollback", async () => {
    const e = await createDeployed("E", def(["trigger_pr_review"]));
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_pr_review"]);
    await saveWorkflowDefinitionDraft(db, {
      definitionId: e.id,
      definition: def(["trigger_pr_created"]),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: e.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_pr_created"]);
    await rollbackWorkflowDefinition(db, {
      definitionId: e.id,
      version: 1,
      expectedDeployedVersion: 2,
      actor: ADMIN,
    });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_pr_review"]);
  });
});

describe("stored v1 structured-output compatibility", () => {
  it("rolls back to and re-enables a deployed schema accepted before strict validation", async () => {
    const current = await createDeployed("Legacy rollback", def(["trigger_pr_review"]));
    const legacy = legacyStructuredOutputDef();
    await db.insert(workflowDefinitionVersions).values({
      definitionId: current.id,
      version: 2,
      definition: legacy,
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const selected = await rollbackWorkflowDefinition(db, {
      definitionId: current.id,
      version: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });
    expect(selected.version.definition).toMatchObject(legacy);

    await updateWorkflowDefinition(db, {
      definitionId: current.id,
      enabled: false,
      actor: ADMIN,
    });
    await expect(
      updateWorkflowDefinition(db, {
        definitionId: current.id,
        enabled: true,
        actor: ADMIN,
      }),
    ).resolves.toMatchObject({ enabled: true, deployedVersion: 2 });
  });

  it("restores and duplicates an immutable legacy schema without weakening new deployment checks", async () => {
    const source = await createDeployed("Legacy stored source", def(["trigger_pr_review"]));
    const legacy = legacyStructuredOutputDef();
    await db.insert(workflowDefinitionVersions).values({
      definitionId: source.id,
      version: 2,
      definition: legacy,
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const restored = await restoreWorkflowDefinitionVersion(db, {
      definitionId: source.id,
      version: 2,
      actor: ADMIN,
    });
    expect(restored.definition).toMatchObject(legacy);

    const duplicate = await createWorkflowDefinitionDraft(db, {
      name: "Legacy stored copy",
      seed: legacy,
      actor: ADMIN,
    });
    expect(duplicate.draft).toMatchObject(legacy);
    await expect(
      deployWorkflowDefinition(db, {
        definitionId: duplicate.definition.id,
        expectedDraftRevision: 1,
        expectedDeployedVersion: null,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("atomic trigger bindings (one-enabled-per-trigger race, #2)", () => {
  async function bindingsFor(triggerType: WorkflowBlockType) {
    return db
      .select()
      .from(workflowDefinitionTriggers)
      .where(eq(workflowDefinitionTriggers.triggerType, triggerType));
  }

  it("rejects a second enabled binding for the same trigger at the DB level", async () => {
    // The seeded default already owns trigger_ticket_ai; a raw duplicate binding
    // must fail on the trigger_type primary key — the guarantee behind the 409.
    await expect(
      db
        .insert(workflowDefinitionTriggers)
        .values({ triggerType: "trigger_ticket_ai", definitionId: SEEDED_DEFAULT_ID }),
    ).rejects.toBeDefined();
  });

  it("lets only one of two concurrent enables win the same trigger", async () => {
    const c = await createDeployed("C", def(["trigger_pr_created"]));
    const d = await createDeployed("D", def(["trigger_pr_created"]));

    const results = await Promise.allSettled([
      updateWorkflowDefinition(db, { definitionId: c.id, enabled: true, actor: ADMIN }),
      updateWorkflowDefinition(db, { definitionId: d.id, enabled: true, actor: ADMIN }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409 });

    // Exactly one enabled definition ends up owning the trigger.
    expect(await bindingsFor("trigger_pr_created")).toHaveLength(1);
    const hit = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created");
    expect(hit?.definition.enabled).toBe(true);
  });

  it("releases the trigger binding when a definition is disabled", async () => {
    const r = await createDeployed("Rel", def(["trigger_pr_review"]));
    await updateWorkflowDefinition(db, { definitionId: r.id, enabled: true, actor: ADMIN });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).not.toBeNull();

    await updateWorkflowDefinition(db, { definitionId: r.id, enabled: false, actor: ADMIN });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).toBeNull();
    expect(await bindingsFor("trigger_pr_review")).toHaveLength(0);
  });

  it("re-syncs bindings when an enabled definition deploys a new trigger", async () => {
    const s = await createDeployed("Swap", def(["trigger_pr_review"]));
    await updateWorkflowDefinition(db, { definitionId: s.id, enabled: true, actor: ADMIN });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: s.id,
      definition: def(["trigger_pr_created"]),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: s.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });

    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).toBeNull();
    expect((await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created"))?.definition.id).toBe(s.id);
  });
});

describe("dispatch derives from the deployed version, not mutable metadata", () => {
  it("routes by the deployed graph even when trigger_types drifts", async () => {
    const p = await createDeployed("Drift", def(["trigger_pr_created"]));
    await updateWorkflowDefinition(db, { definitionId: p.id, enabled: true, actor: ADMIN });

    // Simulate a save that stored the version but crashed before refreshing the
    // denormalized trigger_types column: the head graph still declares the trigger.
    await db.update(workflowDefinitions).set({ triggerTypes: [] }).where(eq(workflowDefinitions.id, p.id));

    const hit = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created");
    expect(hit?.definition.id).toBe(p.id);
  });

  it("repairs a stale binding on read when the head graph no longer declares the trigger", async () => {
    // An enabled definition whose head does NOT declare trigger_pr_created, plus
    // an injected stale binding (as a crashed write might leave): the read must
    // ignore and drop it.
    const q = await createDeployed("Stale", def(["trigger_pr_review"]));
    await updateWorkflowDefinition(db, { definitionId: q.id, enabled: true, actor: ADMIN });
    await db
      .insert(workflowDefinitionTriggers)
      .values({ triggerType: "trigger_pr_created", definitionId: q.id });

    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created")).toBeNull();
    const rows = await db
      .select()
      .from(workflowDefinitionTriggers)
      .where(eq(workflowDefinitionTriggers.triggerType, "trigger_pr_created"));
    expect(rows).toHaveLength(0);
  });

  it("does not delete a newly valid binding when stale-read repair races a deployment", async () => {
    const q = await createDeployed("Stale race", def(["trigger_pr_review"]));
    await updateWorkflowDefinition(db, { definitionId: q.id, enabled: true, actor: ADMIN });
    await db
      .insert(workflowDefinitionTriggers)
      .values({ triggerType: "trigger_pr_created", definitionId: q.id });
    await saveWorkflowDefinitionDraft(db, {
      definitionId: q.id,
      definition: def(["trigger_pr_created"]),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });

    const originalDelete = db.delete.bind(db);
    let deploymentRacedCleanup = false;
    const deleteSpy = vi.spyOn(db, "delete").mockImplementation(((table: unknown) => {
      const query = originalDelete(table as never) as unknown as {
        where(condition: unknown): unknown;
      };
      if (table !== workflowDefinitionTriggers || deploymentRacedCleanup) return query as never;
      const originalWhere = query.where.bind(query);
      query.where = (condition: unknown) => {
        deploymentRacedCleanup = true;
        return (async () => {
          await deployWorkflowDefinition(db, {
            definitionId: q.id,
            expectedDraftRevision: 2,
            expectedDeployedVersion: 1,
            actor: ADMIN,
          });
          return originalWhere(condition);
        })();
      };
      return query as never;
    }) as typeof db.delete);

    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created")).toBeNull();
    deleteSpy.mockRestore();

    expect(deploymentRacedCleanup).toBe(true);
    expect((await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created"))?.definition.id).toBe(q.id);
  });
});

describe("archiveWorkflowDefinition", () => {
  it("409s when the definition is still enabled", async () => {
    await expect(
      archiveWorkflowDefinition(db, { definitionId: SEEDED_DEFAULT_ID, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s when it is the last non-archived definition", async () => {
    // Disable the only definition, then attempt to archive it.
    await updateWorkflowDefinition(db, { definitionId: SEEDED_DEFAULT_ID, enabled: false, actor: ADMIN });
    await expect(
      archiveWorkflowDefinition(db, { definitionId: SEEDED_DEFAULT_ID, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("hides an archived definition from the list", async () => {
    const g = (await createWorkflowDefinition(db, { name: "G", seed: null, actor: ADMIN })).definition;
    await archiveWorkflowDefinition(db, { definitionId: g.id, actor: ADMIN });
    const names = (await listWorkflowDefinitions(db)).map((d) => d.name);
    expect(names).not.toContain("G");
  });
});

describe("archived definition write guards", () => {
  /** Create a disabled definition (optionally with a v1) and archive it; the
   *  seeded default keeps the non-archived count above one. */
  async function archived(name: string, seed: WorkflowDefinition | null = null): Promise<number> {
    const d = (await createWorkflowDefinition(db, { name, seed, actor: ADMIN })).definition;
    await archiveWorkflowDefinition(db, { definitionId: d.id, actor: ADMIN });
    return d.id;
  }

  it("409s a save of a new version to an archived definition", async () => {
    const id = await archived("Arch save");
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: id, definition: def(), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Definition is archived" });
  });

  it("409s a restore into an archived definition", async () => {
    const id = await archived("Arch restore", def());
    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: id, version: 1, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Definition is archived" });
  });

  it("409s rename and enable on an archived definition", async () => {
    const id = await archived("Arch update");
    await expect(
      updateWorkflowDefinition(db, { definitionId: id, name: "Fresh name", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Definition is archived" });
    await expect(
      updateWorkflowDefinition(db, { definitionId: id, enabled: true, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Definition is archived" });
  });
});

describe("write-path validation", () => {
  it("400s a save whose graph fails the schema or the structural rules", async () => {
    await expect(
      saveWorkflowDefinitionVersion(db, {
        definitionId: SEEDED_DEFAULT_ID,
        // A param the strict schema does not know.
        definition: { schemaVersion: 1, nodes: [{ id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: { nope: 1 } }], edges: [] } as unknown as WorkflowDefinition,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: /^Invalid definition:/ });

    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: SEEDED_DEFAULT_ID, definition: invalidDef(), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400, message: /^Invalid workflow:/ });
  });

  it("400s a create whose seed is invalid, leaving no definition behind", async () => {
    await expect(
      createWorkflowDefinition(db, { name: "Bad seed", seed: invalidDef(), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400, message: /^Invalid workflow:/ });
    expect((await listWorkflowDefinitions(db)).map((d) => d.name)).not.toContain("Bad seed");
  });

  it("400s a restore of a stored version that no longer validates, keeping the head intact", async () => {
    const d = (await createWorkflowDefinition(db, { name: "Legacy", seed: def(), actor: ADMIN })).definition;
    // Inject an invalid v2 the way a version stored before a rule tightened would
    // look, then make a valid v3 the head.
    await db.insert(workflowDefinitionVersions).values({
      definitionId: d.id,
      version: 2,
      definition: invalidDef(),
      createdById: "u_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });
    await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(), actor: ADMIN });

    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: d.id, version: 2, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400, message: /^Invalid workflow:/ });
    // No new head: the operator gets the 400 instead of an unloadable head.
    const head = await getCurrentWorkflowDefinitionVersion(db, d.id);
    expect(head?.version).toBe(3);
    expect(head?.definition).toEqual(def());
  });

  it("still reads a legacy invalid row (validation is write-only)", async () => {
    const d = (await createWorkflowDefinition(db, { name: "Readable", seed: def(), actor: ADMIN })).definition;
    const legacyInvalid = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "orphan", type: "open_pr", x: 0, y: 0, params: {} },
      ],
      edges: [],
    };
    await db.insert(workflowDefinitionVersions).values({
      definitionId: d.id,
      version: 2,
      definition: legacyInvalid,
      createdById: "u_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });
    const head = await getCurrentWorkflowDefinitionVersion(db, d.id);
    expect(head?.definition).toEqual({
      ...legacyInvalid,
      nodes: [
        { ...legacyInvalid.nodes[0], inputs: {} },
        {
          id: "orphan-finalize",
          type: "finalize_workspace",
          x: -220,
          y: 0,
          params: {},
          inputs: {},
        },
        {
          ...legacyInvalid.nodes[1],
          inputs: {
            repositories: "steps.orphan-finalize.output.repositories",
          },
        },
      ],
      edges: [{ from: "orphan-finalize", to: "orphan" }],
    });
    expect(await getWorkflowDefinitionVersion(db, d.id, 2)).not.toBeNull();
    expect((await listWorkflowDefinitionVersionRows(db, d.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it("rejects deploying a pin whose repositories contradict its own provider list", async () => {
    const contradictory: WorkflowDefinitionV1 = {
      ...def(),
      repositoryScope: {
        providers: ["github"],
        repositories: [{ provider: "gitlab", repoPath: "acme/shared" }],
      },
    };
    const created = (
      await createWorkflowDefinition(db, { name: "Pinned", seed: null, actor: ADMIN })
    ).definition;
    // The draft still saves: the pin is an authoring issue reported to the editor,
    // and only deployment is gated on it.
    await saveWorkflowDefinitionDraft(db, {
      definitionId: created.id,
      definition: contradictory,
      expectedDraftRevision: 0,
      actor: ADMIN,
    });

    await expect(
      deployWorkflowDefinition(db, {
        definitionId: created.id,
        expectedDraftRevision: 1,
        expectedDeployedVersion: null,
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      issues: [
        expect.objectContaining({
          nodeId: null,
          path: "/repositoryScope",
          message: expect.stringContaining("excluded by the pinned provider list"),
        }),
      ],
    });
  });

  it("checks the role before the graph, so a member never learns the graph is invalid", async () => {
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: SEEDED_DEFAULT_ID, definition: invalidDef(), actor: MEMBER }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("role gating", () => {
  it("rejects a member on every write with 403", async () => {
    const d = (await createWorkflowDefinition(db, { name: "H", seed: null, actor: ADMIN })).definition;

    await expect(
      createWorkflowDefinition(db, { name: "Nope", seed: null, actor: MEMBER }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(), actor: MEMBER }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(
      updateWorkflowDefinition(db, { definitionId: d.id, name: "X", actor: MEMBER }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(
      archiveWorkflowDefinition(db, { definitionId: d.id, actor: MEMBER }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: d.id, version: 1, actor: MEMBER }),
    ).rejects.toBeInstanceOf(DashboardAuthError);

    for (const p of [
      createWorkflowDefinition(db, { name: "N2", seed: null, actor: MEMBER }),
      updateWorkflowDefinition(db, { definitionId: d.id, name: "X", actor: MEMBER }),
    ]) {
      await expect(p).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

describe("getEnabledWorkflowDefinitionForTrigger", () => {
  it("returns the enabled definition and its current head for a handled trigger", async () => {
    const hit = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai");
    expect(hit?.definition.id).toBe(SEEDED_DEFAULT_ID);
    expect(hit?.current).toBeNull();

    await saveWorkflowDefinitionDraft(db, {
      definitionId: SEEDED_DEFAULT_ID,
      definition: def(["trigger_ticket_ai"]),
      expectedDraftRevision: 0,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: SEEDED_DEFAULT_ID,
      expectedDraftRevision: 1,
      expectedDeployedVersion: null,
      actor: ADMIN,
    });
    const withHead = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai");
    expect(withHead?.current?.version).toBe(1);
  });

  it("returns null when no enabled definition handles the trigger", async () => {
    await updateWorkflowDefinition(db, { definitionId: SEEDED_DEFAULT_ID, enabled: false, actor: ADMIN });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai")).toBeNull();
  });

  it("re-claims the trigger for the only enabled definition that lost its binding", async () => {
    // AWP-49: enabling a second definition moves the single owning row to it and
    // disabling that one deletes the row. Both writers are scoped to one
    // definition id, so the definition that stayed enabled throughout never gets
    // the row back and every ticket dispatch silently finds nothing.
    // The direct updates below forge that state: assertNoTriggerOverlap 409s a
    // second enable through the public API, so this models the orphaned end
    // state, not a literal API sequence.
    const stealer = await createDeployed("Legacy", def(["trigger_ticket_ai"]));
    await db
      .update(workflowDefinitions)
      .set({ enabled: true })
      .where(eq(workflowDefinitions.id, stealer.id));
    await db
      .update(workflowDefinitionTriggers)
      .set({ definitionId: stealer.id })
      .where(eq(workflowDefinitionTriggers.triggerType, "trigger_ticket_ai"));
    await updateWorkflowDefinition(db, { definitionId: stealer.id, enabled: false, actor: ADMIN });
    expect(await db.select().from(workflowDefinitionTriggers)).toEqual([]);

    const hit = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai");
    expect(hit?.definition.id).toBe(SEEDED_DEFAULT_ID);
    expect(await db.select().from(workflowDefinitionTriggers)).toEqual([
      { triggerType: "trigger_ticket_ai", definitionId: SEEDED_DEFAULT_ID },
    ]);
  });

  it("creates no binding when no enabled definition declares the trigger", async () => {
    await updateWorkflowDefinition(db, { definitionId: SEEDED_DEFAULT_ID, enabled: false, actor: ADMIN });

    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai")).toBeNull();
    expect(await db.select().from(workflowDefinitionTriggers)).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { triggerType: "trigger_ticket_ai", candidates: [] },
      "trigger_binding_unclaimed",
    );
  });

  it("never guesses an owner when two enabled definitions declare the trigger", async () => {
    // Direct writes forge the ambiguous state (two enabled declarers, no owner
    // row) that assertNoTriggerOverlap forbids through the public API.
    const rival = await createDeployed("Rival", def(["trigger_ticket_ai"]));
    await db
      .update(workflowDefinitions)
      .set({ enabled: true })
      .where(eq(workflowDefinitions.id, rival.id));
    await db
      .delete(workflowDefinitionTriggers)
      .where(eq(workflowDefinitionTriggers.triggerType, "trigger_ticket_ai"));

    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai")).toBeNull();
    expect(await db.select().from(workflowDefinitionTriggers)).toEqual([]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { triggerType: "trigger_ticket_ai", candidates: [SEEDED_DEFAULT_ID, rival.id] },
      "trigger_binding_unclaimed",
    );
  });
});

describe("back-compat wrappers on a single-definition db", () => {
  it("surfaces DashboardAuthError 500 from the read wrappers when no definition exists", async () => {
    // Unreachable in production (migration seeds one row and the last-archive
    // guard keeps it), but the read wrappers have no error mapping of their
    // own, so the resolver must throw a type toHttpError already maps.
    await db.delete(workflowDefinitionVersions);
    await db.delete(workflowDefinitions);
    await expect(listWorkflowDefinitionVersions(db)).rejects.toMatchObject({
      statusCode: 500,
      message: "No workflow definition",
    });
  });

  it("keeps the store error type distinct from the wrapper's DashboardAuthError", async () => {
    // Direct store call surfaces WorkflowDefinitionStoreError (routes map it in B3)...
    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: SEEDED_DEFAULT_ID, version: 42, actor: ADMIN }),
    ).rejects.toBeInstanceOf(WorkflowDefinitionStoreError);

    // sanity: the seeded default row is reachable directly.
    const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, SEEDED_DEFAULT_ID));
    expect(rows).toHaveLength(1);
  });
});

describe("webhook endpoint minting", () => {
  const KEY = "a".repeat(64);
  // The block is only available (and only mintable) when the key is configured,
  // so these tests set it on the mocked env for their duration.
  const mutableEnv = env as { WEBHOOK_TRIGGER_ENCRYPTION_KEY?: string };

  function webhookDefV2(nodeId = "hook"): WorkflowDefinitionV2 {
    return {
      schemaVersion: 2,
      nodes: [
        { id: nodeId, type: "trigger_webhook", x: 0, y: 0, configuration: {}, inputs: {}, additionalInputs: [] },
      ],
      edges: [],
    };
  }

  beforeEach(() => {
    mutableEnv.WEBHOOK_TRIGGER_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    delete mutableEnv.WEBHOOK_TRIGGER_ENCRYPTION_KEY;
  });

  it("mints an endpoint for every webhook trigger node on deploy, once", async () => {
    const definition = await createDeployed("Webhook deploy", webhookDefV2());

    const minted = await db.select().from(webhookTriggerEndpoints);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ definitionId: definition.id, nodeId: "hook", revokedAt: null });

    // Re-deploying the same graph keeps the endpoint and its secret.
    await saveWorkflowDefinitionDraft(db, {
      definitionId: definition.id,
      definition: webhookDefV2(),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: definition.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });
    const afterRedeploy = await db.select().from(webhookTriggerEndpoints);
    expect(afterRedeploy).toHaveLength(1);
    expect(afterRedeploy[0]!.id).toBe(minted[0]!.id);
    expect(afterRedeploy[0]!.secretCiphertext).toBe(minted[0]!.secretCiphertext);
  });

  it("mints endpoints the live head is missing when a definition is enabled", async () => {
    const definition = await createDeployed("Webhook enable", webhookDefV2());
    // Stands in for a version deployed before the endpoint existed.
    await db.delete(webhookTriggerEndpoints);

    await updateWorkflowDefinition(db, {
      definitionId: definition.id,
      enabled: true,
      actor: ADMIN,
    });

    const minted = await db.select().from(webhookTriggerEndpoints);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ definitionId: definition.id, nodeId: "hook" });
  });

  it("does not fail the deploy when minting fails", async () => {
    // A key that passes the availability check but not the cipher.
    mutableEnv.WEBHOOK_TRIGGER_ENCRYPTION_KEY = "not-a-valid-key";

    const definition = await createDeployed("Webhook mint failure", webhookDefV2());

    expect(definition.deployedVersion).toBe(1);
    expect(await db.select().from(webhookTriggerEndpoints)).toHaveLength(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ definitionId: definition.id }),
      "webhook_endpoint_mint_failed",
    );
  });
});

describe("schedule trigger rows", () => {
  function scheduleDefV2(
    nodeId = "schedule",
    configuration: Record<string, unknown> = {},
  ): WorkflowDefinitionV2 {
    return {
      schemaVersion: 2,
      nodes: [
        {
          id: nodeId,
          type: "trigger_schedule",
          x: 0,
          y: 0,
          configuration: {
            cron: "*/15 * * * *",
            timezone: "UTC",
            taskTitle: "Sweep the backlog",
            taskDescription: "Look for stale tickets.",
            ...configuration,
          },
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [],
    };
  }

  function webhookDefV2(nodeId = "hook"): WorkflowDefinitionV2 {
    return {
      schemaVersion: 2,
      nodes: [
        { id: nodeId, type: "trigger_webhook", x: 0, y: 0, configuration: {}, inputs: {}, additionalInputs: [] },
      ],
      edges: [],
    };
  }

  /** Deploy AND enable: a schedule row only exists for a live workflow, and the
   *  sync deliberately does nothing for a definition nobody has enabled. */
  async function createLiveSchedule(name: string, definition: WorkflowDefinitionV2) {
    const created = await createDeployed(name, definition);
    await updateWorkflowDefinition(db, {
      definitionId: created.id,
      enabled: true,
      actor: ADMIN,
    });
    return created;
  }

  async function schedulesOf(definitionId: number) {
    return await db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.definitionId, definitionId));
  }

  // workflow_definition_triggers has trigger_type as its PRIMARY KEY, so anything
  // claiming a row there is limited to one enabled definition system-wide. A
  // schedule has no incoming event to route, so if it claimed one, only a single
  // workflow in the whole product could ever carry a schedule.
  it("lets two definitions both deploy and both enable a schedule trigger", async () => {
    const first = await createDeployed("Schedule one", scheduleDefV2());
    const second = await createDeployed("Schedule two", scheduleDefV2());

    await expect(
      updateWorkflowDefinition(db, { definitionId: first.id, enabled: true, actor: ADMIN }),
    ).resolves.toMatchObject({ enabled: true });
    // The overlap precheck reads the denormalized trigger_types column rather than
    // the bindings table, so this is the assertion that would have failed with a
    // 409 while only the three claim inserts were fixed.
    await expect(
      updateWorkflowDefinition(db, { definitionId: second.id, enabled: true, actor: ADMIN }),
    ).resolves.toMatchObject({ enabled: true });

    // Displayed, not exclusive: the column still carries the trigger.
    expect(await triggerTypesOf(db, first.id)).toEqual(["trigger_schedule"]);
    expect(await triggerTypesOf(db, second.id)).toEqual(["trigger_schedule"]);
    // And no binding row was claimed by either of them.
    expect(
      await db
        .select()
        .from(workflowDefinitionTriggers)
        .where(eq(workflowDefinitionTriggers.triggerType, "trigger_schedule")),
    ).toEqual([]);
  });

  // The negative half: the exclusion must cover self-routed triggers and nothing
  // else. A singleton trigger still admits exactly one enabled definition, so the
  // schedule exclusion cannot have widened into the general rule.
  //
  // The subject is trigger_pr_created rather than trigger_webhook: AIW-238 made
  // webhooks self-routed too, so they are no longer a control. It is also not
  // trigger_ticket_ai, which the seeded default definition already claims.
  it("still refuses a second enabled definition handling a singleton trigger", async () => {
    const first = await createDeployed("PR one", def(["trigger_pr_created"]));
    const second = await createDeployed("PR two", def(["trigger_pr_created"]));
    await updateWorkflowDefinition(db, {
      definitionId: first.id,
      enabled: true,
      actor: ADMIN,
    });

    await expect(
      updateWorkflowDefinition(db, { definitionId: second.id, enabled: true, actor: ADMIN }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Its trigger is already handled by the enabled definition "PR one"',
    });
  });

  it("mints a row for a schedule node on deploy, keeping its id and pause across a redeploy", async () => {
    const definition = await createLiveSchedule("Schedule mint", scheduleDefV2());

    const minted = await schedulesOf(definition.id);
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      nodeId: "schedule",
      cron: "*/15 * * * *",
      timezone: "UTC",
      overlapPolicy: "skip",
      catchUpGraceMinutes: 60,
      revokedAt: null,
    });

    const pausedAt = new Date("2026-08-05T10:00:00.000Z");
    await db
      .update(workflowSchedules)
      .set({ pausedAt })
      .where(eq(workflowSchedules.id, minted[0]!.id));

    await saveWorkflowDefinitionDraft(db, {
      definitionId: definition.id,
      definition: scheduleDefV2(),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: definition.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });

    const afterRedeploy = await schedulesOf(definition.id);
    expect(afterRedeploy).toHaveLength(1);
    expect(afterRedeploy[0]!.id).toBe(minted[0]!.id);
    // A pause records a human intention, so a deploy has no business lifting it.
    expect(afterRedeploy[0]!.pausedAt).toEqual(pausedAt);
  });

  // Minting alone is conflict-do-nothing, so without the re-sync an edited cron
  // would never reach the row and the deployed graph would run on the old one.
  it("re-syncs the authored columns when a deploy changes them, without lifting a pause", async () => {
    const definition = await createLiveSchedule("Schedule resync", scheduleDefV2());
    const [before] = await schedulesOf(definition.id);
    const pausedAt = new Date("2026-08-05T10:00:00.000Z");
    await db
      .update(workflowSchedules)
      .set({ pausedAt })
      .where(eq(workflowSchedules.id, before!.id));

    await saveWorkflowDefinitionDraft(db, {
      definitionId: definition.id,
      definition: scheduleDefV2("schedule", {
        cron: "0 9 * * 1",
        timezone: "Europe/Warsaw",
        overlapPolicy: "queue",
        catchUpGraceMinutes: 30,
      }),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: definition.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });

    const [after] = await schedulesOf(definition.id);
    expect(after).toMatchObject({
      id: before!.id,
      cron: "0 9 * * 1",
      timezone: "Europe/Warsaw",
      overlapPolicy: "queue",
      catchUpGraceMinutes: 30,
      pausedAt,
    });
  });

  // Nothing else ever writes revoked_at, so without this the state is unreachable
  // and the editor's promise that restoring the node picks the schedule back up
  // has nothing behind it.
  it("revokes a row whose node left the head, and lifts it when the node returns", async () => {
    const definition = await createLiveSchedule("Schedule revoke", scheduleDefV2());
    const [minted] = await schedulesOf(definition.id);
    const pausedAt = new Date("2026-08-05T10:00:00.000Z");
    await db
      .update(workflowSchedules)
      .set({ pausedAt })
      .where(eq(workflowSchedules.id, minted!.id));
    // Waiting for capacity when the operator removes the node.
    await db.insert(scheduleOccurrences).values({
      scheduleId: minted!.id,
      occurrenceAt: new Date("2026-08-05T09:00:00.000Z"),
      definitionId: definition.id,
      definitionVersion: 1,
      pending: true,
    });

    await saveWorkflowDefinitionDraft(db, {
      definitionId: definition.id,
      definition: scheduleDefV2("moved"),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: definition.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });

    const revoked = (await schedulesOf(definition.id)).find(
      (row) => row.nodeId === "schedule",
    );
    expect(revoked!.revokedAt).toBeInstanceOf(Date);
    expect(revoked!.pausedAt).toEqual(pausedAt);
    // Revocation is reversible, so an occurrence left waiting would be started by
    // the drain hours later, the moment a deploy restores the node.
    const [occurrence] = await db
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.scheduleId, minted!.id));
    expect(occurrence).toMatchObject({
      pending: false,
      outcome: "cancelled",
      skipReason: "schedule_revoked",
    });

    await saveWorkflowDefinitionDraft(db, {
      definitionId: definition.id,
      definition: scheduleDefV2(),
      expectedDraftRevision: 2,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: definition.id,
      expectedDraftRevision: 3,
      expectedDeployedVersion: 2,
      actor: ADMIN,
    });

    const restored = (await schedulesOf(definition.id)).find(
      (row) => row.nodeId === "schedule",
    );
    expect(restored!.id).toBe(minted!.id);
    expect(restored!.revokedAt).toBeNull();
    // Still paused: only the structural question was answered.
    expect(restored!.pausedAt).toEqual(pausedAt);
  });

  // A rollback exists to restore an earlier version's behaviour. Leaving the row on
  // the newer version's cron would mean the old graph runs on the new schedule, so
  // the rollback would not actually roll anything back.
  it("re-syncs the authored columns on a rollback", async () => {
    const definition = await createLiveSchedule("Schedule rollback", scheduleDefV2());
    await saveWorkflowDefinitionDraft(db, {
      definitionId: definition.id,
      definition: scheduleDefV2("schedule", { cron: "0 9 * * 1" }),
      expectedDraftRevision: 1,
      actor: ADMIN,
    });
    await deployWorkflowDefinition(db, {
      definitionId: definition.id,
      expectedDraftRevision: 2,
      expectedDeployedVersion: 1,
      actor: ADMIN,
    });
    expect((await schedulesOf(definition.id))[0]!.cron).toBe("0 9 * * 1");

    await rollbackWorkflowDefinition(db, {
      definitionId: definition.id,
      version: 1,
      expectedDeployedVersion: 2,
      actor: ADMIN,
    });

    expect((await schedulesOf(definition.id))[0]!.cron).toBe("*/15 * * * *");
  });
});
