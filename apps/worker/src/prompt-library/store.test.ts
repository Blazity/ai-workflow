import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";
import { DEFAULT_AGENT_PROMPTS } from "@shared/contracts";
import type { Db } from "../db/client.js";
import { promptLibrary, promptLibraryVersions, workflowDefinitionVersions } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { DashboardAuthError } from "../lib/auth/users-read.js";
import {
  archivePrompt,
  createPrompt,
  findPromptRowsByNames,
  findPromptUsage,
  findPromptUsageInPrompts,
  getCurrentPromptVersion,
  getPrompt,
  getPromptVersion,
  listPrompts,
  listPromptVersionRows,
  PromptLibraryStoreError,
  restorePromptVersion,
  retryOnUniqueViolation,
  savePromptVersion,
  serializePromptMeta,
  updatePromptMeta,
  type PromptLibraryActor,
} from "./store.js";

const ADMIN: PromptLibraryActor = { role: "admin", id: "u_admin", label: "Admin" };
const MEMBER: PromptLibraryActor = { role: "member", id: "u_member", label: "Member" };

// The 0020 migration seeds three built-in prompts: research-plan (1),
// implement (2), review (3). User-created prompts start at id 4.

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("migration seed", () => {
  it("seeds the three built-in prompts with bodies byte-identical to DEFAULT_AGENT_PROMPTS", async () => {
    const prompts = await listPrompts(db);
    const byName = new Map(prompts.map((p) => [p.name, p]));
    for (const name of ["research-plan", "implement", "review"] as const) {
      const row = byName.get(name);
      expect(row, `seed ${name} missing`).toBeDefined();
      expect(row!.tags).toEqual(["built-in"]);
      expect(row!.currentVersion).toBe(1);
      expect(row!.createdById).toBe("system");
      expect(row!.createdByLabel).toBe("System migration");
      expect(row!.body).toBe(DEFAULT_AGENT_PROMPTS[name]);

      const head = await getCurrentPromptVersion(db, row!.id);
      expect(head!.body).toBe(DEFAULT_AGENT_PROMPTS[name]);
    }
  });

  it("reads only requested prompt metadata and includes archived matches", async () => {
    const { prompt } = await createPrompt(db, { name: "Archived default", body: "body", actor: ADMIN });
    await archivePrompt(db, { promptId: prompt.id, actor: ADMIN });

    const rows = await findPromptRowsByNames(db, ["research-plan", "Archived default", "missing"]);

    expect(rows.map((row) => row.name)).toEqual(["research-plan", "Archived default"]);
    expect(rows[0].archivedAt).toBeNull();
    expect(rows[1].archivedAt).toBeInstanceOf(Date);
    expect("body" in rows[0]).toBe(false);
  });
});

describe("createPrompt", () => {
  it("inserts a prompt and seeds version 1", async () => {
    const { prompt, current } = await createPrompt(db, {
      name: "My prompt",
      body: "Hello {{ticket_key}}",
      description: "A prompt",
      tags: ["team", "wip"],
      actor: ADMIN,
    });
    expect(prompt.id).toBe(4);
    expect(prompt.description).toBe("A prompt");
    expect(prompt.tags).toEqual(["team", "wip"]);
    expect(current.version).toBe(1);
    expect(current.promptId).toBe(prompt.id);
    expect(current.body).toBe("Hello {{ticket_key}}");
    expect(current.restoredFromVersion).toBeNull();

    const meta = serializePromptMeta(prompt, current.version);
    expect(meta.archivedAt).toBeNull();
    expect(meta.currentVersion).toBe(1);
  });

  it("trims and validates inputs, rejecting an over-long name and too many tags", async () => {
    await expect(
      createPrompt(db, { name: "  ", body: "x", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createPrompt(db, { name: "x".repeat(121), body: "y", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createPrompt(db, { name: "ok", body: "", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createPrompt(db, {
        name: "ok",
        body: "y",
        tags: Array.from({ length: 16 }, (_, i) => `t${i}`),
        actor: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("name uniqueness", () => {
  it("409s a duplicate active name and frees the name once archived", async () => {
    const first = await createPrompt(db, { name: "Alpha", body: "a", actor: ADMIN });
    await expect(
      createPrompt(db, { name: "Alpha", body: "b", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Name already in use" });

    await archivePrompt(db, { promptId: first.prompt.id, actor: ADMIN });
    const reused = await createPrompt(db, { name: "Alpha", body: "c", actor: ADMIN });
    expect(reused.prompt.name).toBe("Alpha");
  });

  it("409s a rename onto an existing active name", async () => {
    const a = await createPrompt(db, { name: "One", body: "a", actor: ADMIN });
    await createPrompt(db, { name: "Two", body: "b", actor: ADMIN });
    await expect(
      updatePromptMeta(db, { promptId: a.prompt.id, name: "Two", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("createPrompt orphan heal", () => {
  it("heals a zero-version orphan holding the name and seeds the new prompt at version 1", async () => {
    // Parent row with no version rows: an earlier create's version-1 seed and
    // its compensating delete both failed, leaving the active name locked out.
    await db.insert(promptLibrary).values({
      name: "Ghost",
      slug: "ghost",
      createdById: "system",
      createdByLabel: "System",
    });

    const { prompt, current } = await createPrompt(db, {
      name: "Ghost",
      body: "fresh",
      actor: ADMIN,
    });
    expect(prompt.name).toBe("Ghost");
    expect(current.version).toBe(1);
    expect(current.body).toBe("fresh");

    // Exactly one active "Ghost" remains, and it is the healed prompt with a
    // real version 1.
    const ghosts = (await listPrompts(db)).filter((p) => p.name === "Ghost");
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].id).toBe(prompt.id);
    expect((await getCurrentPromptVersion(db, prompt.id))!.version).toBe(1);
  });

  it("keeps the 409 when the conflicting active name belongs to a real prompt", async () => {
    const live = await createPrompt(db, { name: "Live", body: "a", actor: ADMIN });
    await expect(
      createPrompt(db, { name: "Live", body: "b", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Name already in use" });

    // The conditional heal must never delete a row that has a version: the live
    // prompt and its version 1 survive the failed create untouched.
    expect((await getPrompt(db, live.prompt.id))?.name).toBe("Live");
    expect((await getCurrentPromptVersion(db, live.prompt.id))?.version).toBe(1);
    const lives = (await listPrompts(db)).filter((p) => p.name === "Live");
    expect(lives).toHaveLength(1);
    expect(lives[0].id).toBe(live.prompt.id);
  });
});

describe("retryOnUniqueViolation exhaustion", () => {
  // A real cross-connection race is not forceable on single-connection PGlite,
  // so the exhaustion mapping is exercised directly against the exported helper.
  it("maps a persistent unique violation to a 409 after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      retryOnUniqueViolation(async () => {
        calls++;
        throw { code: "23505" };
      }, 3),
    ).rejects.toMatchObject({ statusCode: 409, message: "Concurrent update, please retry" });
    expect(calls).toBe(3);
  });

  it("passes a non-unique error through unchanged without retrying", async () => {
    const boom = new Error("boom");
    let calls = 0;
    await expect(
      retryOnUniqueViolation(async () => {
        calls++;
        throw boom;
      }, 3),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });
});

describe("savePromptVersion", () => {
  it("appends max+1 when the body changed and no-ops on an identical body", async () => {
    const { prompt } = await createPrompt(db, { name: "S", body: "v1", actor: ADMIN });

    const changed = await savePromptVersion(db, { promptId: prompt.id, body: "v2", actor: ADMIN });
    expect(changed.changed).toBe(true);
    expect(changed.version.version).toBe(2);

    const unchanged = await savePromptVersion(db, { promptId: prompt.id, body: "v2", actor: ADMIN });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.version.version).toBe(2);

    const rows = await listPromptVersionRows(db, prompt.id);
    expect(rows.map((v) => v.version)).toEqual([2, 1]);
  });

  it("404s a save against an unknown prompt", async () => {
    await expect(
      savePromptVersion(db, { promptId: 999, body: "x", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("recovers onto the next free version number when the max+1 slot is already taken", async () => {
    const { prompt } = await createPrompt(db, { name: "Race", body: "v1", actor: ADMIN });
    // A concurrent writer grabbed version 2 (the slot max+1 targets); the
    // (prompt_id, version) PK is what retryOnUniqueViolation guards against.
    await db.insert(promptLibraryVersions).values({
      promptId: prompt.id,
      version: 2,
      body: "concurrent",
      createdById: "u_other",
      createdByLabel: "Other",
      restoredFromVersion: null,
    });

    const saved = await savePromptVersion(db, { promptId: prompt.id, body: "v2", actor: ADMIN });
    expect(saved.changed).toBe(true);
    expect(saved.version.version).toBe(3);

    const rows = await listPromptVersionRows(db, prompt.id);
    expect(rows.map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe("restorePromptVersion", () => {
  it("always appends a copy with restoredFromVersion set, even when the body equals head", async () => {
    const { prompt } = await createPrompt(db, { name: "R", body: "v1", actor: ADMIN });
    await savePromptVersion(db, { promptId: prompt.id, body: "v2", actor: ADMIN });

    // Restore v2 while v2 is already head: still appends v3.
    const restoredHead = await restorePromptVersion(db, { promptId: prompt.id, version: 2, actor: ADMIN });
    expect(restoredHead.version).toBe(3);
    expect(restoredHead.body).toBe("v2");
    expect(restoredHead.restoredFromVersion).toBe(2);

    // Restore v1 (differs from head): appends v4 with v1's body.
    const restoredOld = await restorePromptVersion(db, { promptId: prompt.id, version: 1, actor: ADMIN });
    expect(restoredOld.version).toBe(4);
    expect(restoredOld.body).toBe("v1");
    expect(restoredOld.restoredFromVersion).toBe(1);
  });

  it("404s on an unknown version", async () => {
    const { prompt } = await createPrompt(db, { name: "R2", body: "v1", actor: ADMIN });
    await expect(
      restorePromptVersion(db, { promptId: prompt.id, version: 99, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("archived write guards", () => {
  async function archived(name: string): Promise<number> {
    const { prompt } = await createPrompt(db, { name, body: "v1", actor: ADMIN });
    await archivePrompt(db, { promptId: prompt.id, actor: ADMIN });
    return prompt.id;
  }

  it("409s save, restore, and meta update on an archived prompt", async () => {
    const id = await archived("Arch");
    await expect(
      savePromptVersion(db, { promptId: id, body: "v2", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Prompt is archived" });
    await expect(
      restorePromptVersion(db, { promptId: id, version: 1, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Prompt is archived" });
    await expect(
      updatePromptMeta(db, { promptId: id, name: "New", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409, message: "Prompt is archived" });
  });

  it("archive is idempotent", async () => {
    const { prompt } = await createPrompt(db, { name: "Idem", body: "v1", actor: ADMIN });
    const once = await archivePrompt(db, { promptId: prompt.id, actor: ADMIN });
    const twice = await archivePrompt(db, { promptId: prompt.id, actor: ADMIN });
    expect(once.archivedAt).not.toBeNull();
    expect(twice.archivedAt).not.toBeNull();
  });

  it("getPrompt and getPromptVersion still read an archived prompt", async () => {
    const id = await archived("ReadArch");
    expect((await getPrompt(db, id))?.archivedAt).not.toBeNull();
    expect((await getPromptVersion(db, id, 1))?.body).toBe("v1");
  });
});

describe("role gating", () => {
  it("rejects a member on every write with 403", async () => {
    const { prompt } = await createPrompt(db, { name: "Gate", body: "v1", actor: ADMIN });
    for (const p of [
      createPrompt(db, { name: "Nope", body: "x", actor: MEMBER }),
      savePromptVersion(db, { promptId: prompt.id, body: "v2", actor: MEMBER }),
      updatePromptMeta(db, { promptId: prompt.id, name: "X", actor: MEMBER }),
      archivePrompt(db, { promptId: prompt.id, actor: MEMBER }),
      restorePromptVersion(db, { promptId: prompt.id, version: 1, actor: MEMBER }),
    ]) {
      await expect(p).rejects.toBeInstanceOf(DashboardAuthError);
      await expect(p).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

describe("listPrompts filtering", () => {
  beforeEach(async () => {
    await createPrompt(db, {
      name: "Bug triage",
      body: "look at the stack trace",
      description: "Handles incoming bugs",
      tags: ["support", "triage"],
      actor: ADMIN,
    });
    await createPrompt(db, {
      name: "Feature spec",
      body: "outline the 100% happy_path",
      description: "Drafts a spec",
      tags: ["planning"],
      actor: ADMIN,
    });
  });

  it("excludes archived prompts unless includeArchived is set", async () => {
    const bug = (await listPrompts(db)).find((p) => p.name === "Bug triage")!;
    await archivePrompt(db, { promptId: bug.id, actor: ADMIN });

    expect((await listPrompts(db)).map((p) => p.name)).not.toContain("Bug triage");
    expect((await listPrompts(db, { includeArchived: true })).map((p) => p.name)).toContain(
      "Bug triage",
    );
  });

  it("filters by tag with arrayContains", async () => {
    const supportOnly = await listPrompts(db, { tag: "support" });
    expect(supportOnly.map((p) => p.name)).toEqual(["Bug triage"]);
  });

  // The built-in seed bodies share common English words, so scope q assertions
  // to the two prompts this suite creates.
  async function mine(q: string): Promise<string[]> {
    return (await listPrompts(db, { q }))
      .map((p) => p.name)
      .filter((n) => n === "Bug triage" || n === "Feature spec");
  }

  it("q searches over name, description, tags, and head body (case-insensitive)", async () => {
    expect(await mine("BUG")).toEqual(["Bug triage"]); // name
    expect(await mine("drafts")).toEqual(["Feature spec"]); // description
    expect(await mine("triage")).toEqual(["Bug triage"]); // tag
    expect(await mine("stack trace")).toEqual(["Bug triage"]); // body
  });

  it("treats % and _ as literal characters in q", async () => {
    // Would be wildcards in a SQL LIKE; here they must match literally.
    expect(await mine("100%")).toEqual(["Feature spec"]);
    expect(await mine("happy_path")).toEqual(["Feature spec"]);
    expect(await mine("happy%path")).toEqual([]);
  });
});

describe("listPrompts zero-version orphan", () => {
  it("omits a prompt that has no version rows and still lists the healthy ones", async () => {
    await createPrompt(db, { name: "Healthy", body: "hi", actor: ADMIN });
    // Parent row with no version rows: create's version insert and its
    // compensating delete both failed. It must not crash the list.
    await db.insert(promptLibrary).values({
      name: "Orphan",
      slug: "orphan",
      createdById: "system",
      createdByLabel: "System",
    });

    const names = (await listPrompts(db)).map((p) => p.name);
    expect(names).toContain("Healthy");
    expect(names).not.toContain("Orphan");
  });
});

describe("input normalization", () => {
  it("stores a whitespace-only description as null", async () => {
    const { prompt } = await createPrompt(db, {
      name: "WS",
      body: "b",
      description: "   ",
      actor: ADMIN,
    });
    expect(prompt.description).toBeNull();
    expect(serializePromptMeta(prompt, 1).description).toBeNull();
  });

  it("collapses duplicate tags preserving first-occurrence order", async () => {
    const { prompt } = await createPrompt(db, {
      name: "Dupes",
      body: "b",
      tags: ["a", "a", "b"],
      actor: ADMIN,
    });
    expect(prompt.tags).toEqual(["a", "b"]);
  });

  it("accepts 16 raw tags when de-duplication brings the set to <= 15", async () => {
    const raw = [...Array.from({ length: 15 }, (_, i) => `t${i}`), "t0"]; // 16 raw, 15 unique
    const { prompt } = await createPrompt(db, { name: "Dedup", body: "b", tags: raw, actor: ADMIN });
    expect(prompt.tags).toHaveLength(15);
  });
});

describe("listPromptVersionRows cap", () => {
  it("returns at most 50 versions, newest first", async () => {
    const { prompt } = await createPrompt(db, { name: "Many", body: "b0", actor: ADMIN });
    for (let i = 1; i <= 55; i++) {
      await savePromptVersion(db, { promptId: prompt.id, body: `b${i}`, actor: ADMIN });
    }
    const rows = await listPromptVersionRows(db, prompt.id);
    expect(rows).toHaveLength(50);
    expect(rows[0].version).toBe(56);
    expect(rows[49].version).toBe(7);
  });
});

describe("findPromptUsage", () => {
  it("reports current / behind / modified per referencing block param", async () => {
    const { prompt } = await createPrompt(db, { name: "Used", body: "V1BODY", actor: ADMIN });
    await savePromptVersion(db, { promptId: prompt.id, body: "V2BODY", actor: ADMIN });
    // Head is now version 2.

    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        {
          id: "cur",
          type: "planning_agent",
          name: "Plan node",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "V2BODY" },
          promptRefs: { prompt: { promptId: prompt.id, version: 2 } },
        },
        {
          id: "beh",
          type: "implementation_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "V1BODY" },
          promptRefs: { prompt: { promptId: prompt.id, version: 1 } },
        },
        {
          id: "mod",
          type: "review_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "EDITED LOCALLY" },
          promptRefs: { prompt: { promptId: prompt.id, version: 2 } },
        },
        {
          id: "gone",
          type: "open_pr",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "whatever" },
          promptRefs: { prompt: { promptId: prompt.id, version: 99 } },
        },
        { id: "unref", type: "update_ticket_status", x: 0, y: 0, inputs: {}, params: {} },
      ],
      edges: [],
    };
    // Seed a head version for the migration's default definition (id 1).
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition,
      createdById: "u_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });

    const rows = await findPromptUsage(db, prompt.id);
    const byNode = new Map(rows.map((r) => [r.nodeId, r]));

    expect(byNode.get("cur")).toMatchObject({
      definitionId: 1,
      definitionName: "Ticket workflow",
      nodeName: "Plan node",
      blockType: "planning_agent",
      paramKey: "prompt",
      version: 2,
      state: "current",
    });
    expect(byNode.get("beh")).toMatchObject({ nodeName: null, version: 1, state: "behind" });
    expect(byNode.get("mod")).toMatchObject({ version: 2, state: "modified" });
    expect(byNode.get("gone")).toMatchObject({ version: 99, state: "modified" });
    expect(byNode.has("unref")).toBe(false);
    expect(rows).toHaveLength(4);
  });

  it("ignores archived definitions and refs to other prompts", async () => {
    const target = await createPrompt(db, { name: "Target", body: "T", actor: ADMIN });
    const other = await createPrompt(db, { name: "Other", body: "O", actor: ADMIN });

    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        {
          id: "n",
          type: "planning_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "O" },
          promptRefs: { prompt: { promptId: other.prompt.id, version: 1 } },
        },
      ],
      edges: [],
    };
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition,
      createdById: "u_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });

    expect(await findPromptUsage(db, target.prompt.id)).toHaveLength(0);
  });

  it("marks a ref as modified when its paramKey is missing or holds a non-string value", async () => {
    const { prompt } = await createPrompt(db, { name: "Edge", body: "BODY", actor: ADMIN });
    // Head is version 1 with body "BODY"; both refs point at it, so any
    // "modified" verdict comes from the param text, not a missing version.

    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        {
          id: "missing",
          type: "planning_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: {}, // paramKey "prompt" absent entirely
          promptRefs: { prompt: { promptId: prompt.id, version: 1 } },
        },
        {
          id: "nonstring",
          type: "implementation_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: 42 }, // present but not a string
          promptRefs: { prompt: { promptId: prompt.id, version: 1 } },
        },
      ],
      edges: [],
    };
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition,
      createdById: "u_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });

    const rows = await findPromptUsage(db, prompt.id);
    const byNode = new Map(rows.map((r) => [r.nodeId, r]));
    expect(byNode.get("missing")).toMatchObject({ version: 1, state: "modified" });
    expect(byNode.get("nonstring")).toMatchObject({ version: 1, state: "modified" });
    expect(rows).toHaveLength(2);
  });

  it("counts live {{prompt:...}} token references (slug and legacy id) without provenance refs", async () => {
    const { prompt } = await createPrompt(db, { name: "Live ref", body: "V1", actor: ADMIN });
    await savePromptVersion(db, { promptId: prompt.id, body: "V2", actor: ADMIN });
    // Head is now version 2; slug is "live-ref".

    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        {
          id: "latest",
          type: "planning_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "Intro\n{{prompt:live-ref}}" },
        },
        {
          id: "pinned",
          type: "call_llm",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "{{prompt:live-ref@1}}" },
        },
        {
          id: "legacy",
          type: "review_agent",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: `{{prompt:${prompt.id}}}` },
        },
      ],
      edges: [],
    };
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition,
      createdById: "u_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });

    const rows = await findPromptUsage(db, prompt.id);
    const byNode = new Map(rows.map((r) => [r.nodeId, r]));
    expect(byNode.get("latest")).toMatchObject({ version: 2, state: "current" });
    expect(byNode.get("pinned")).toMatchObject({ version: 1, state: "behind" });
    expect(byNode.get("legacy")).toMatchObject({ version: 2, state: "current" });
    expect(rows).toHaveLength(3);
  });
});

describe("findPromptUsageInPrompts", () => {
  it("reports active prompts whose head bodies reference this prompt", async () => {
    const target = await createPrompt(db, { name: "Shared block", body: "S1", actor: ADMIN });
    await savePromptVersion(db, { promptId: target.prompt.id, body: "S2", actor: ADMIN });
    // Head is now version 2; slug is "shared-block".
    await createPrompt(db, {
      name: "Uses latest",
      body: "Intro\n{{prompt:shared-block}}",
      actor: ADMIN,
    });
    await createPrompt(db, { name: "Uses pinned", body: "{{prompt:shared-block@1}}", actor: ADMIN });
    await createPrompt(db, {
      name: "Uses legacy",
      body: `{{prompt:${target.prompt.id}}}`,
      actor: ADMIN,
    });
    await createPrompt(db, { name: "Unrelated", body: "none", actor: ADMIN });
    const gone = await createPrompt(db, {
      name: "Archived referrer",
      body: "{{prompt:shared-block}}",
      actor: ADMIN,
    });
    await archivePrompt(db, { promptId: gone.prompt.id, actor: ADMIN });

    const rows = await findPromptUsageInPrompts(db, target.prompt.id);
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    expect(bySlug.get("uses-latest")).toMatchObject({ name: "Uses latest", version: 2, state: "current" });
    expect(bySlug.get("uses-pinned")).toMatchObject({ version: 1, state: "behind" });
    expect(bySlug.get("uses-legacy")).toMatchObject({ version: 2, state: "current" });
    // Archived referrers and unrelated prompts stay out.
    expect(rows).toHaveLength(3);
  });
});

describe("built-in default prompt guard", () => {
  it("refuses to archive or rename a built-in default, but allows meta edits", async () => {
    const [research] = await findPromptRowsByNames(db, ["research-plan"]);
    await expect(
      archivePrompt(db, { promptId: research.id, actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updatePromptMeta(db, { promptId: research.id, name: "renamed", actor: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updatePromptMeta(db, { promptId: research.id, description: "still fine", actor: ADMIN }),
    ).resolves.toMatchObject({ description: "still fine" });
  });
});
