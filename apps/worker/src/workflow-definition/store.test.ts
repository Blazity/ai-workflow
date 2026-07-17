import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { WorkflowBlockType, WorkflowDefinition } from "@shared/contracts";
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
  workflowDefinitionTriggers,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinition,
  getCurrentWorkflowDefinition,
  getCurrentWorkflowDefinitionVersion,
  getEnabledWorkflowDefinitionForTrigger,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
  listWorkflowDefinitions,
  listWorkflowDefinitionVersionRows,
  listWorkflowDefinitionVersions,
  restoreWorkflowDefinition,
  restoreWorkflowDefinitionVersion,
  saveWorkflowDefinition,
  saveWorkflowDefinitionVersion,
  serializeWorkflowDefinitionVersion,
  updateWorkflowDefinition,
  WorkflowDefinitionStoreError,
  type WorkflowDefinitionActor,
} from "./store.js";

const ADMIN: WorkflowDefinitionActor = { role: "admin", id: "u_admin", label: "Admin" };
const MEMBER: WorkflowDefinitionActor = { role: "member", id: "u_member", label: "Member" };

/** Minimal definition the store's write validation accepts: a bare trigger is a
 *  complete graph. The store reads node types to derive trigger_types. A
 *  trigger-less graph is not valid, so a definition with no trigger is made with
 *  `seed: null` (no version) instead. */
function def(triggers: WorkflowBlockType[] = ["trigger_ticket_ai"]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: triggers.map((type, i) => ({ id: `n${i}`, type, x: 0, y: 0, params: {}, inputs: {} })),
    edges: [],
  };
}

/** A graph that is well-shaped but structurally invalid (an unreachable block),
 *  standing in for a version stored before a schema/rule tightened. */
function invalidDef(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
      { id: "orphan", type: "open_pr", x: 0, y: 0, params: {}, inputs: {} },
    ],
    edges: [],
  };
}

function invalidBindingDef(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
      { id: "approval", type: "send_plan_approval", x: 0, y: 0, params: {}, inputs: {} },
    ],
    edges: [{ from: "t", to: "approval" }],
  };
}

/** The definition the 0013 migration seeds. */
const SEEDED_DEFAULT_ID = 1;

async function triggerTypesOf(db: Db, definitionId: number): Promise<string[]> {
  const row = await getWorkflowDefinition(db, definitionId);
  return row!.triggerTypes;
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
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

describe("createWorkflowDefinition", () => {
  it("rejects a structurally valid seed with invalid typed bindings", async () => {
    await expect(
      createWorkflowDefinition(db, { name: "Invalid bindings", seed: invalidBindingDef(), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates a disabled definition with an optional v1 and derived trigger_types", async () => {
    const created = await createWorkflowDefinition(db, {
      name: "With seed",
      seed: def(["trigger_ticket_ai"]),
      actor: ADMIN,
    });
    expect(created.definition.enabled).toBe(false);
    expect(created.definition.triggerTypes).toEqual(["trigger_ticket_ai"]);
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

    const current = await getCurrentWorkflowDefinitionVersion(db, created.definition.id);
    expect(current?.definition.nodes.map((node) => node.type)).toEqual([
      "trigger_ticket_ai",
      "open_pr",
    ]);
    expect(current?.definition.edges).toEqual([{ from: "trigger", to: "open" }]);
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
    const b = (
      await createWorkflowDefinition(db, { name: "B", seed: def(["trigger_ticket_ai"]), actor: ADMIN })
    ).definition;
    await expect(
      updateWorkflowDefinition(db, { definitionId: b.id, enabled: true, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows two definitions with disjoint triggers to both be enabled", async () => {
    // default handles trigger_ticket_ai; C has no trigger, so no overlap.
    const c = (await createWorkflowDefinition(db, { name: "C", seed: null, actor: ADMIN })).definition;
    const enabled = await updateWorkflowDefinition(db, { definitionId: c.id, enabled: true, actor: ADMIN });
    expect(enabled.enabled).toBe(true);
    const defaultRow = await getWorkflowDefinition(db, SEEDED_DEFAULT_ID);
    expect(defaultRow!.enabled).toBe(true);
  });

  it("409s when a save adds an overlapping trigger to an already-enabled definition", async () => {
    const d = (await createWorkflowDefinition(db, { name: "D", seed: null, actor: ADMIN })).definition;
    await updateWorkflowDefinition(db, { definitionId: d.id, enabled: true, actor: ADMIN }); // no trigger, ok
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(["trigger_ticket_ai"]), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("recomputes trigger_types on save and on restore", async () => {
    const e = (await createWorkflowDefinition(db, { name: "E", seed: null, actor: ADMIN })).definition;
    await saveWorkflowDefinitionVersion(db, { definitionId: e.id, definition: def(["trigger_ticket_ai"]), actor: ADMIN });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_ticket_ai"]);

    await saveWorkflowDefinitionVersion(db, { definitionId: e.id, definition: def(["trigger_pr_created"]), actor: ADMIN });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_pr_created"]);

    await restoreWorkflowDefinitionVersion(db, { definitionId: e.id, version: 1, actor: ADMIN });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_ticket_ai"]);
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
    const c = (await createWorkflowDefinition(db, { name: "C", seed: def(["trigger_pr_created"]), actor: ADMIN })).definition;
    const d = (await createWorkflowDefinition(db, { name: "D", seed: def(["trigger_pr_created"]), actor: ADMIN })).definition;

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
    const r = (await createWorkflowDefinition(db, { name: "Rel", seed: def(["trigger_pr_review"]), actor: ADMIN })).definition;
    await updateWorkflowDefinition(db, { definitionId: r.id, enabled: true, actor: ADMIN });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).not.toBeNull();

    await updateWorkflowDefinition(db, { definitionId: r.id, enabled: false, actor: ADMIN });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).toBeNull();
    expect(await bindingsFor("trigger_pr_review")).toHaveLength(0);
  });

  it("re-syncs bindings when an enabled definition's new version swaps its trigger", async () => {
    const s = (await createWorkflowDefinition(db, { name: "Swap", seed: def(["trigger_pr_review"]), actor: ADMIN })).definition;
    await updateWorkflowDefinition(db, { definitionId: s.id, enabled: true, actor: ADMIN });

    await saveWorkflowDefinitionVersion(db, { definitionId: s.id, definition: def(["trigger_pr_created"]), actor: ADMIN });

    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review")).toBeNull();
    expect((await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_created"))?.definition.id).toBe(s.id);
  });
});

describe("dispatch derives from the head version, not the stored column (#3)", () => {
  it("routes by the head graph even when trigger_types drifts from a crashed save", async () => {
    const p = (await createWorkflowDefinition(db, { name: "Drift", seed: def(["trigger_pr_created"]), actor: ADMIN })).definition;
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
    const q = (await createWorkflowDefinition(db, { name: "Stale", seed: def(["trigger_pr_review"]), actor: ADMIN })).definition;
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
      nodes: legacyInvalid.nodes.map((node) => ({ ...node, inputs: {} })),
    });
    expect(await getWorkflowDefinitionVersion(db, d.id, 2)).not.toBeNull();
    expect((await listWorkflowDefinitionVersionRows(db, d.id)).map((v) => v.version)).toEqual([2, 1]);
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

    await saveWorkflowDefinitionVersion(db, {
      definitionId: SEEDED_DEFAULT_ID,
      definition: def(["trigger_ticket_ai"]),
      actor: ADMIN,
    });
    const withHead = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai");
    expect(withHead?.current?.version).toBe(1);
  });

  it("returns null when no enabled definition handles the trigger", async () => {
    await updateWorkflowDefinition(db, { definitionId: SEEDED_DEFAULT_ID, enabled: false, actor: ADMIN });
    expect(await getEnabledWorkflowDefinitionForTrigger(db, "trigger_ticket_ai")).toBeNull();
  });
});

describe("back-compat wrappers on a single-definition db", () => {
  const FLAT = { actorRole: "admin" as const, actorId: "u_admin", actorLabel: "Admin" };

  it("lists no versions initially, then numbers saves 1..n against the default", async () => {
    expect(await listWorkflowDefinitionVersions(db)).toEqual([]);

    const v1 = await saveWorkflowDefinition(db, { ...FLAT, definition: def(["trigger_ticket_ai"]) });
    expect(v1.version).toBe(1);
    expect(v1.definitionId).toBe(SEEDED_DEFAULT_ID);
    const v2 = await saveWorkflowDefinition(db, { ...FLAT, definition: def(["trigger_ticket_ai"]) });
    expect(v2.version).toBe(2);

    const current = await getCurrentWorkflowDefinition(db);
    expect(current?.version).toBe(2);
    const list = await listWorkflowDefinitionVersions(db);
    expect(list.map((v) => v.version)).toEqual([2, 1]);
  });

  it("restores a version against the default and appends restoredFromVersion", async () => {
    await saveWorkflowDefinition(db, { ...FLAT, definition: def(["trigger_ticket_ai"]) });
    await saveWorkflowDefinition(db, { ...FLAT, definition: def(["trigger_pr_created"]) });
    const restored = await restoreWorkflowDefinition(db, { ...FLAT, version: 1 });
    expect(restored.version).toBe(3);
    expect(restored.restoredFromVersion).toBe(1);
  });

  it("throws DashboardAuthError 404 for an unknown restore version", async () => {
    await expect(restoreWorkflowDefinition(db, { ...FLAT, version: 42 })).rejects.toBeInstanceOf(
      DashboardAuthError,
    );
    await expect(restoreWorkflowDefinition(db, { ...FLAT, version: 42 })).rejects.toMatchObject({
      statusCode: 404,
      message: "Unknown version",
    });
  });

  it("throws DashboardAuthError 403 for a member save", async () => {
    await expect(
      saveWorkflowDefinition(db, {
        actorRole: "member",
        actorId: "u_member",
        actorLabel: "Member",
        definition: def(["trigger_ticket_ai"]),
      }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
  });

  it("serializes a version row including definitionId", async () => {
    const saved = await saveWorkflowDefinition(db, { ...FLAT, definition: def(["trigger_ticket_ai"]) });
    const serialized = serializeWorkflowDefinitionVersion(saved);
    expect(serialized).toMatchObject({
      version: 1,
      definitionId: SEEDED_DEFAULT_ID,
      restoredFromVersion: null,
    });
    expect(typeof serialized.createdAt).toBe("string");
  });

  it("surfaces DashboardAuthError 500 from the read wrappers when no definition exists", async () => {
    // Unreachable in production (migration seeds one row and the last-archive
    // guard keeps it), but the read wrappers have no error mapping of their
    // own, so the resolver must throw a type toHttpError already maps.
    await db.delete(workflowDefinitionVersions);
    await db.delete(workflowDefinitions);
    await expect(getCurrentWorkflowDefinition(db)).rejects.toBeInstanceOf(DashboardAuthError);
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
