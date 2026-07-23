import { eq } from "drizzle-orm";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PromptSlotDefinition,
  WorkflowDefinition,
} from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import {
  member,
  organization,
  promptLibrary,
  user,
  workflowDefinitionVersions,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin" as string | null,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));
const PLAN_SLOT: PromptSlotDefinition = {
  name: "plan",
  description: "Implementation plan",
  schema: { type: "string" },
  required: true,
};

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.sessionUserId
          ? { user: { id: state.sessionUserId }, session: { id: "session_test" } }
          : null,
      ),
    },
  },
}));

const listGet = (await import("./prompt-library.get.js")).default;
const createPost = (await import("./prompt-library.post.js")).default;
const detailGet = (await import("./prompt-library/[id].get.js")).default;
const detailPatch = (await import("./prompt-library/[id].patch.js")).default;
const detailPut = (await import("./prompt-library/[id].put.js")).default;
const detailDelete = (await import("./prompt-library/[id].delete.js")).default;
const detailRestore = (await import("./prompt-library/[id]/restore.post.js")).default;
const versionGet = (await import("./prompt-library/[id]/versions/[version].get.js")).default;
const usageGet = (await import("./prompt-library/[id]/usage.get.js")).default;

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerFor(route: any) {
  const app = createApp();
  app.use("/", route);
  return toWebHandler(app);
}

function paramHandler(
  method: "get" | "post" | "put" | "patch" | "delete",
  pattern: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: any,
) {
  const app = createApp();
  const router = createRouter();
  router[method](pattern, route);
  app.use(router);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown, url = "http://worker.test/"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const detail = (method: "get" | "put" | "patch", route: unknown) =>
  paramHandler(method, "/p/:id", route);
const del = paramHandler("delete", "/p/:id", detailDelete);
const restore = paramHandler("post", "/p/:id/restore", detailRestore);
const versions = paramHandler("get", "/p/:id/versions/:version", versionGet);
const usage = paramHandler("get", "/p/:id/usage", usageGet);

async function create(body: unknown) {
  return handlerFor(createPost)(jsonRequest("POST", body));
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "member_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "member_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
});

// The 0020 migration seeds three built-in prompts (ids 1-3); user-created
// prompts start at id 4.

describe("CRUD happy path", () => {
  it("creates, lists, reads, patches, saves, restores, and archives a prompt", async () => {
    // Create.
    let res = await create({
      name: "My prompt",
      body: "v1 {{slot:plan}}",
      slots: [PLAN_SLOT],
      description: "Desc",
      tags: ["team"],
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.meta).toMatchObject({ id: 4, name: "My prompt", currentVersion: 1, tags: ["team"] });
    expect(body.current.version).toBe(1);
    expect(body.current.slots).toEqual([PLAN_SLOT]);
    expect(body.versions).toHaveLength(1);

    // List (built-ins + created); tags sorted distinct.
    res = await handlerFor(listGet)(new Request("http://worker.test/"));
    body = await res.json();
    expect(body.prompts.map((p: { name: string }) => p.name)).toContain("My prompt");
    expect(body.tags).toEqual(["built-in", "team"]);
    expect(body.prompts.find((p: { id: number }) => p.id === 4)).toMatchObject({
      body: "v1 {{slot:plan}}",
      slots: [PLAN_SLOT],
    });

    // Read detail.
    res = await detail("get", detailGet)(new Request("http://worker.test/p/4"));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.meta.id).toBe(4);
    expect(body.current.version).toBe(1);
    expect(body.current.slots).toEqual([PLAN_SLOT]);

    // Patch metadata (returns the full detail response).
    res = await detail("patch", detailPatch)(jsonRequest("PATCH", { name: "Renamed" }, "http://worker.test/p/4"));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.meta.name).toBe("Renamed");
    expect(body.current.version).toBe(1);

    // Save a new version.
    res = await detail("put", detailPut)(
      jsonRequest(
        "PUT",
        {
          body: "v2 {{slot:plan}}",
          slots: [{ ...PLAN_SLOT, description: "Updated plan" }],
        },
        "http://worker.test/p/4",
      ),
    );
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.version.version).toBe(2);
    expect(body.version.slots[0].description).toBe("Updated plan");
    expect(body.meta.currentVersion).toBe(2);

    // Restore version 1 -> appends version 3.
    res = await restore(jsonRequest("POST", { version: 1 }, "http://worker.test/p/4/restore"));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.version.version).toBe(3);
    expect(body.version.body).toBe("v1 {{slot:plan}}");
    expect(body.version.slots).toEqual([PLAN_SLOT]);
    expect(body.version.restoredFromVersion).toBe(1);

    // Archive (delete) -> returns the archived detail.
    res = await del(new Request("http://worker.test/p/4", { method: "DELETE" }));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.meta.archivedAt).not.toBeNull();

    // Detail GET still serves an archived prompt (the UI opens it behind the
    // "Archived" toggle); the head remains the restored version 3.
    res = await detail("get", detailGet)(new Request("http://worker.test/p/4"));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.meta.archivedAt).not.toBeNull();
    expect(body.current.version).toBe(3);
  });
});

describe("PUT unchanged body", () => {
  it("returns changed:false without appending a version", async () => {
    await create({ name: "Same", body: "keep" });
    const res = await detail("put", detailPut)(
      jsonRequest("PUT", { body: "keep" }, "http://worker.test/p/4"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(body.version.version).toBe(1);
    expect(body.meta.currentVersion).toBe(1);
  });

  it("appends when only slots change and preserves head slots when omitted", async () => {
    await create({
      name: "Slot change",
      body: "keep",
      slots: [PLAN_SLOT],
    });
    let res = await detail("put", detailPut)(
      jsonRequest(
        "PUT",
        {
          body: "keep",
          slots: [{ ...PLAN_SLOT, required: false }],
        },
        "http://worker.test/p/4",
      ),
    );
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.version.version).toBe(2);
    expect(body.version.slots[0].required).toBe(false);

    res = await detail("put", detailPut)(
      jsonRequest("PUT", { body: "changed body" }, "http://worker.test/p/4"),
    );
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.slots[0].required).toBe(false);
  });
});

describe("auth", () => {
  it("401s when there is no session", async () => {
    state.sessionUserId = null;
    const res = await handlerFor(listGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(401);
  });

  it("403s a member write but allows a member read", async () => {
    await create({ name: "Owned", body: "v1" });
    state.sessionUserId = "user_member";

    const write = await create({ name: "Member try", body: "v1" });
    expect(write.status).toBe(403);

    const read = await handlerFor(listGet)(new Request("http://worker.test/"));
    expect(read.status).toBe(200);
  });
});

describe("bad id", () => {
  it("404s a non-integer id", async () => {
    const res = await detail("get", detailGet)(new Request("http://worker.test/p/abc"));
    expect(res.status).toBe(404);
  });

  it("404s a valid id that never existed", async () => {
    const res = await detail("get", detailGet)(new Request("http://worker.test/p/999"));
    expect(res.status).toBe(404);
  });
});

describe("zero-version orphan detail routes", () => {
  it("404s GET, PATCH, and DELETE on a raw-seeded orphan and never archives it", async () => {
    // Parent row with no version rows: an earlier create's version-1 seed and
    // its compensating delete both failed. There is no head to serialize.
    const [orphan] = await db
      .insert(promptLibrary)
      .values({ name: "Orphan", slug: "orphan", createdById: "system", createdByLabel: "System" })
      .returning();
    const url = `http://worker.test/p/${orphan.id}`;

    const getRes = await detail("get", detailGet)(new Request(url));
    expect(getRes.status).toBe(404);

    const patchRes = await detail("patch", detailPatch)(jsonRequest("PATCH", { name: "Renamed" }, url));
    expect(patchRes.status).toBe(404);

    const delRes = await del(new Request(url, { method: "DELETE" }));
    expect(delRes.status).toBe(404);

    // The DELETE 404 must not have archived the orphan.
    const [after] = await db.select().from(promptLibrary).where(eq(promptLibrary.id, orphan.id));
    expect(after.archivedAt).toBeNull();
  });
});

describe("versions/:version", () => {
  it("reads a version even after the prompt is archived", async () => {
    await create({ name: "Archived read", body: "v1" });
    await del(new Request("http://worker.test/p/4", { method: "DELETE" }));

    const res = await versions(new Request("http://worker.test/p/4/versions/1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(1);
    expect(body.version.body).toBe("v1");
  });

  it("returns the exact slots stored with a historical version", async () => {
    await create({
      name: "Slotted version",
      body: "v1",
      slots: [PLAN_SLOT],
    });
    const res = await versions(
      new Request("http://worker.test/p/4/versions/1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).version.slots).toEqual([PLAN_SLOT]);
  });

  it("404s an unknown version", async () => {
    await create({ name: "V", body: "v1" });
    const res = await versions(new Request("http://worker.test/p/4/versions/99"));
    expect(res.status).toBe(404);
  });

  it("404s a version past the int4 max instead of overflowing to a 500", async () => {
    await create({ name: "Overflow", body: "v1" });
    const res = await versions(new Request("http://worker.test/p/4/versions/2147483648"));
    expect(res.status).toBe(404);
  });
});

describe("restore validation", () => {
  it("400s a version past the int4 max instead of overflowing to a 500", async () => {
    await create({ name: "Restore overflow", body: "v1" });
    const res = await restore(
      jsonRequest("POST", { version: 2147483648 }, "http://worker.test/p/4/restore"),
    );
    expect(res.status).toBe(400);
  });
});

describe("conflict mapping", () => {
  it("409s a create whose name is already in use", async () => {
    const first = await create({ name: "Dup", body: "v1" });
    expect(first.status).toBe(200);

    const second = await create({ name: "Dup", body: "v2" });
    expect(second.status).toBe(409);
  });

  it("409s a PUT that writes a new version onto an archived prompt", async () => {
    await create({ name: "Frozen", body: "v1" });
    await del(new Request("http://worker.test/p/4", { method: "DELETE" }));

    const res = await detail("put", detailPut)(
      jsonRequest("PUT", { body: "v2" }, "http://worker.test/p/4"),
    );
    expect(res.status).toBe(409);
  });
});

describe("slot validation", () => {
  it("400s malformed slot payloads on create and save", async () => {
    const invalidCreate = await create({
      name: "Bad slots",
      body: "v1",
      slots: "not-an-array",
    });
    expect(invalidCreate.status).toBe(400);

    await create({ name: "Valid first", body: "v1" });
    const invalidSave = await detail("put", detailPut)(
      jsonRequest(
        "PUT",
        {
          body: "v2",
          slots: [
            {
              ...PLAN_SLOT,
              defaultValue: 42,
            },
          ],
        },
        "http://worker.test/p/4",
      ),
    );
    expect(invalidSave.status).toBe(400);
  });
});

describe("usage", () => {
  it("returns the usage rows for a referenced prompt", async () => {
    await create({ name: "Referenced", body: "BODY" });

    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        {
          id: "n1",
          type: "planning_agent",
          name: "Plan",
          x: 0,
          y: 0,
          inputs: {},
          params: { prompt: "BODY" },
          promptRefs: { prompt: { promptId: 4, version: 1 } },
        },
      ],
      edges: [],
    };
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition,
      createdById: "user_admin",
      createdByLabel: "Admin",
      restoredFromVersion: null,
    });

    const res = await usage(new Request("http://worker.test/p/4/usage"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      definitionId: 1,
      definitionName: "Ticket workflow",
      nodeId: "n1",
      nodeName: "Plan",
      blockType: "planning_agent",
      paramKey: "prompt",
      version: 1,
      state: "current",
    });
  });

  it("returns an empty list for an unreferenced prompt", async () => {
    await create({ name: "Lonely", body: "x" });
    const res = await usage(new Request("http://worker.test/p/4/usage"));
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toEqual([]);
  });
});

describe("includeArchived listing", () => {
  it("hides archived prompts unless includeArchived is set", async () => {
    await create({ name: "Gone soon", body: "v1" });
    await del(new Request("http://worker.test/p/4", { method: "DELETE" }));

    let res = await handlerFor(listGet)(new Request("http://worker.test/"));
    let body = await res.json();
    expect(body.prompts.map((p: { name: string }) => p.name)).not.toContain("Gone soon");

    res = await handlerFor(listGet)(new Request("http://worker.test/?includeArchived=1"));
    body = await res.json();
    expect(body.prompts.map((p: { name: string }) => p.name)).toContain("Gone soon");
  });
});
