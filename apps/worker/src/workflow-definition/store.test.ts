import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { WorkflowBlockType, WorkflowDefinition } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import {
  archiveWorkflowDefinition,
  createWorkflowDefinition,
  getCurrentWorkflowDefinition,
  getEnabledWorkflowDefinitionForTrigger,
  getWorkflowDefinition,
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

/** Minimal definition; the store never validates the graph, only reads node
 *  types to derive trigger_types. Pass [] for a definition with no trigger. */
function def(triggers: WorkflowBlockType[] = ["trigger_ticket_ai"]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: triggers.map((type, i) => ({ id: `n${i}`, type, x: 0, y: 0, params: {} })),
    edges: [],
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

    const save = (id: number) => saveWorkflowDefinitionVersion(db, { definitionId: id, definition: def([]), actor: ADMIN });
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

describe("restoreWorkflowDefinitionVersion", () => {
  it("appends a copy of an earlier version with restoredFromVersion set", async () => {
    const d = (await createWorkflowDefinition(db, { name: "R", seed: null, actor: ADMIN })).definition;
    await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(["trigger_ticket_ai"]), actor: ADMIN });
    await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def([]), actor: ADMIN });

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
    await saveWorkflowDefinitionVersion(db, { definitionId: a.id, definition: def([]), actor: ADMIN });
    await expect(
      restoreWorkflowDefinitionVersion(db, { definitionId: b.id, version: 1, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("VERSION_LIST_LIMIT", () => {
  it("returns at most 50 versions per definition, newest first", async () => {
    const d = (await createWorkflowDefinition(db, { name: "Many", seed: null, actor: ADMIN })).definition;
    for (let i = 0; i < 55; i++) {
      await saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def([]), actor: ADMIN });
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
    const c = (await createWorkflowDefinition(db, { name: "C", seed: def([]), actor: ADMIN })).definition;
    const enabled = await updateWorkflowDefinition(db, { definitionId: c.id, enabled: true, actor: ADMIN });
    expect(enabled.enabled).toBe(true);
    const defaultRow = await getWorkflowDefinition(db, SEEDED_DEFAULT_ID);
    expect(defaultRow!.enabled).toBe(true);
  });

  it("409s when a save adds an overlapping trigger to an already-enabled definition", async () => {
    const d = (await createWorkflowDefinition(db, { name: "D", seed: def([]), actor: ADMIN })).definition;
    await updateWorkflowDefinition(db, { definitionId: d.id, enabled: true, actor: ADMIN }); // no trigger, ok
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def(["trigger_ticket_ai"]), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("recomputes trigger_types on save and on restore", async () => {
    const e = (await createWorkflowDefinition(db, { name: "E", seed: null, actor: ADMIN })).definition;
    await saveWorkflowDefinitionVersion(db, { definitionId: e.id, definition: def(["trigger_ticket_ai"]), actor: ADMIN });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_ticket_ai"]);

    await saveWorkflowDefinitionVersion(db, { definitionId: e.id, definition: def([]), actor: ADMIN });
    expect(await triggerTypesOf(db, e.id)).toEqual([]);

    await restoreWorkflowDefinitionVersion(db, { definitionId: e.id, version: 1, actor: ADMIN });
    expect(await triggerTypesOf(db, e.id)).toEqual(["trigger_ticket_ai"]);
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
      saveWorkflowDefinitionVersion(db, { definitionId: id, definition: def([]), actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Definition is archived" });
  });

  it("409s a restore into an archived definition", async () => {
    const id = await archived("Arch restore", def([]));
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

describe("role gating", () => {
  it("rejects a member on every write with 403", async () => {
    const d = (await createWorkflowDefinition(db, { name: "H", seed: null, actor: ADMIN })).definition;

    await expect(
      createWorkflowDefinition(db, { name: "Nope", seed: null, actor: MEMBER }),
    ).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(
      saveWorkflowDefinitionVersion(db, { definitionId: d.id, definition: def([]), actor: MEMBER }),
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
    await saveWorkflowDefinition(db, { ...FLAT, definition: def([]) });
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
