import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import { member, organization, user } from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { defaultWorkflowDefinition } from "../../../workflow-definition/default.js";
import { saveWorkflowDefinition } from "../../../workflow-definition/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    ENABLE_REVIEW_PHASE: true,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test-default",
    CODEX_MODEL: "gpt-5-codex",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
  },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("../../../workflow-definition/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../workflow-definition/models.js")>();
  return {
    ...actual,
    fetchAvailableModels: vi.fn(async () => ({
      claude: ["claude-opus-4-8", "claude-sonnet-5"],
      codex: ["gpt-5-codex", "gpt-5"],
    })),
  };
});

const definitionsGet = (await import("./workflow-definitions.get.js")).default;
const definitionsPost = (await import("./workflow-definitions.post.js")).default;
const detailGet = (await import("./workflow-definitions/[id].get.js")).default;
const detailPut = (await import("./workflow-definitions/[id].put.js")).default;
const detailPatch = (await import("./workflow-definitions/[id].patch.js")).default;
const detailDelete = (await import("./workflow-definitions/[id].delete.js")).default;
const detailRestore = (await import("./workflow-definitions/[id]/restore.post.js")).default;
const shimGet = (await import("./workflow-definition.get.js")).default;
const shimPut = (await import("./workflow-definition.put.js")).default;
const shimRestore = (await import("./workflow-definition/restore.post.js")).default;
const sessionGet = (await import("./session.get.js")).default;

const VALID_DEFINITION = defaultWorkflowDefinition({ includeReview: false });
const OTHER_DEFINITION = defaultWorkflowDefinition({ includeReview: true });
const ACTOR = { actorRole: "admin" as const, actorId: "user_admin", actorLabel: "Admin" };

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

function withBadParam(def: WorkflowDefinition): WorkflowDefinition {
  return {
    ...def,
    nodes: def.nodes.map((node) =>
      node.type === "planning_agent" ? { ...node, params: { bogus: "x" } } : node,
    ),
  };
}

function withUnreachableNode(def: WorkflowDefinition): WorkflowDefinition {
  const statusId = def.nodes.find((node) => node.type === "update_ticket_status")!.id;
  return {
    ...def,
    edges: def.edges.filter((edge) => edge.to !== statusId),
  };
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

// The 0013 migration seeds one enabled definition ("Ticket workflow", id 1,
// trigger_ticket_ai) with no versions, the default a single-definition install
// starts from.

describe("GET /api/v1/workflow-definitions", () => {
  it("lists the seeded definition with its meta plus default + options", async () => {
    const res = await handlerFor(definitionsGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.definitions).toHaveLength(1);
    expect(body.definitions[0]).toMatchObject({
      id: 1,
      name: "Ticket workflow",
      enabled: true,
      triggerTypes: ["trigger_ticket_ai"],
      currentVersion: null,
    });
    expect(body.defaultDefinition.schemaVersion).toBe(1);
    expect(body.options.agentKind).toBe("claude");
    expect(body.options.defaultModel).toBe("claude-test-default");
  });

  it("reports currentVersion once a version exists", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    const res = await handlerFor(definitionsGet)(new Request("http://worker.test/"));
    const body = await res.json();
    expect(body.definitions[0].currentVersion).toBe(1);
  });
});

describe("POST /api/v1/workflow-definitions", () => {
  it("creates a disabled definition seeded from the built-in default", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ id: 2, name: "Second flow", enabled: false, currentVersion: 1 });
    expect(body.current.version).toBe(1);
    expect(body.versions).toHaveLength(1);
    expect(body.current.definition.nodes.some((n: { type: string }) => n.type === "review_agent")).toBe(
      true,
    );
  });

  it("duplicates the head version of the source definition", async () => {
    const created = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Source flow", source: { kind: "default" } }),
    );
    const createdBody = await created.json();
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Copy flow", source: { kind: "duplicate", definitionId: createdBody.meta.id } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.id).toBe(3);
    expect(body.current.version).toBe(1);
    expect(body.current.definition).toEqual(createdBody.current.definition);
  });

  it("duplicating a definition with no versions seeds the built-in default", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Copy of seed", source: { kind: "duplicate", definitionId: 1 } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current.version).toBe(1);
    expect(body.current.definition.nodes.some((n: { type: string }) => n.type === "trigger_ticket_ai")).toBe(true);
    expect(body.current.definition.nodes.some((n: { type: string }) => n.type === "implementation_agent")).toBe(true);
  });

  it("rejects an empty name with 400", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "  ", source: { kind: "default" } }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid source with 400", async () => {
    const res = await handlerFor(definitionsPost)(jsonRequest("POST", { name: "X", source: { kind: "nope" } }));
    expect(res.status).toBe(400);
  });

  it("409s when the name is already in use by an active definition", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Ticket workflow", source: { kind: "default" } }),
    );
    expect(res.status).toBe(409);
  });

  it("404s when duplicating an unknown definition", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "X", source: { kind: "duplicate", definitionId: 999 } }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "X", source: { kind: "default" } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/workflow-definitions/:id", () => {
  it("returns the detail for a known definition", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    const res = await paramHandler("get", "/d/:id", detailGet)(new Request("http://worker.test/d/1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.id).toBe(1);
    expect(body.meta.currentVersion).toBe(1);
    expect(body.current.version).toBe(1);
    expect(body.versions).toHaveLength(1);
  });

  it("404s on an unknown id", async () => {
    const res = await paramHandler("get", "/d/:id", detailGet)(new Request("http://worker.test/d/999"));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/v1/workflow-definitions/:id", () => {
  const put = paramHandler("put", "/d/:id", detailPut);

  it("saves a valid definition and returns the reshaped save response", async () => {
    let res = await put(jsonRequest("PUT", { definition: VALID_DEFINITION }, "http://worker.test/d/1"));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.version.version).toBe(1);
    expect(body.version.definition).toEqual(VALID_DEFINITION);
    expect(body.version.definitionId).toBe(1);
    expect(body.meta).toMatchObject({ id: 1, currentVersion: 1 });

    res = await put(jsonRequest("PUT", { definition: OTHER_DEFINITION }, "http://worker.test/d/1"));
    body = await res.json();
    expect(body.version.version).toBe(2);
    expect(body.meta.currentVersion).toBe(2);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await put(jsonRequest("PUT", { definition: VALID_DEFINITION }, "http://worker.test/d/1"));
    expect(res.status).toBe(403);
  });

  it("rejects a definition that fails the schema with 400 Invalid definition", async () => {
    const res = await put(
      jsonRequest("PUT", { definition: withBadParam(VALID_DEFINITION) }, "http://worker.test/d/1"),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid definition:/);
  });

  it("rejects a structurally invalid graph with 400 Invalid workflow", async () => {
    const res = await put(
      jsonRequest("PUT", { definition: withUnreachableNode(VALID_DEFINITION) }, "http://worker.test/d/1"),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid workflow:/);
  });

  it("404s when the definition is unknown", async () => {
    const res = await put(jsonRequest("PUT", { definition: VALID_DEFINITION }, "http://worker.test/d/999"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/workflow-definitions/:id", () => {
  const patch = paramHandler("patch", "/d/:id", detailPatch);

  it("renames a definition", async () => {
    const res = await patch(jsonRequest("PATCH", { name: "Renamed" }, "http://worker.test/d/1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed");
  });

  it("409s when enabling a definition whose trigger is already taken", async () => {
    await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    // id 2 carries trigger_ticket_ai and id 1 is enabled with the same trigger.
    const res = await patch(jsonRequest("PATCH", { enabled: true }, "http://worker.test/d/2"));
    expect(res.status).toBe(409);
  });

  it("enables a definition once the conflicting one is disabled", async () => {
    await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    let res = await patch(jsonRequest("PATCH", { enabled: false }, "http://worker.test/d/1"));
    expect(res.status).toBe(200);
    res = await patch(jsonRequest("PATCH", { enabled: true }, "http://worker.test/d/2"));
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await patch(jsonRequest("PATCH", { name: "Renamed" }, "http://worker.test/d/1"));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/workflow-definitions/:id", () => {
  const del = paramHandler("delete", "/d/:id", detailDelete);

  it("archives a disabled definition", async () => {
    await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    const res = await del(new Request("http://worker.test/d/2", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const detail = await paramHandler("get", "/d/:id", detailGet)(new Request("http://worker.test/d/2"));
    expect(detail.status).toBe(404);
  });

  it("409s when archiving an enabled definition", async () => {
    await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    const res = await del(new Request("http://worker.test/d/1", { method: "DELETE" }));
    expect(res.status).toBe(409);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await del(new Request("http://worker.test/d/1", { method: "DELETE" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/workflow-definitions/:id/restore", () => {
  const restore = paramHandler("post", "/d/:id/restore", detailRestore);

  it("appends a copy of the requested version", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    await saveWorkflowDefinition(db, { ...ACTOR, definition: OTHER_DEFINITION });
    const res = await restore(jsonRequest("POST", { version: 1 }, "http://worker.test/d/1/restore"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.definition).toEqual(VALID_DEFINITION);
    expect(body.version.restoredFromVersion).toBe(1);
    expect(body.meta.currentVersion).toBe(3);
  });

  it("404s on an unknown version", async () => {
    const res = await restore(jsonRequest("POST", { version: 42 }, "http://worker.test/d/1/restore"));
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    state.sessionUserId = "user_member";
    const res = await restore(jsonRequest("POST", { version: 1 }, "http://worker.test/d/1/restore"));
    expect(res.status).toBe(403);
  });
});

// --- Legacy single-definition shims (removed once the dashboard migrates) ---

describe("GET /api/v1/workflow-definition (shim)", () => {
  it("returns empty state with default definition and editor options", async () => {
    const res = await handlerFor(shimGet)(new Request("http://worker.test/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current).toBeNull();
    expect(body.versions).toEqual([]);
    expect(body.defaultDefinition.schemaVersion).toBe(1);
    expect(body.defaultDefinition.nodes.some((n: { type: string }) => n.type === "review_agent")).toBe(
      true,
    );
    expect(body.options.agentKind).toBe("claude");
    expect(body.options.defaultModel).toBe("claude-test-default");
    expect(body.options.models.claude).toEqual([
      "claude-test-default",
      "claude-opus-4-8",
      "claude-sonnet-5",
    ]);
    expect(body.options.models.codex).toEqual(["gpt-5-codex", "gpt-5"]);
    expect(body.options.ticketStatusTargets).toEqual([
      { value: "ai_review", label: "AI Review" },
      { value: "backlog", label: "Backlog" },
    ]);
  });

  it("omits the review block when the review phase is disabled", async () => {
    state.env.ENABLE_REVIEW_PHASE = false;
    try {
      const res = await handlerFor(shimGet)(new Request("http://worker.test/"));
      const body = await res.json();
      expect(
        body.defaultDefinition.nodes.some((n: { type: string }) => n.type === "review_agent"),
      ).toBe(false);
    } finally {
      state.env.ENABLE_REVIEW_PHASE = true;
    }
  });
});

describe("PUT /api/v1/workflow-definition (shim)", () => {
  it("saves a valid definition against the default definition", async () => {
    let res = await handlerFor(shimPut)(jsonRequest("PUT", { definition: VALID_DEFINITION }));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.version.version).toBe(1);
    expect(body.version.definition).toEqual(VALID_DEFINITION);
    expect(body.version.createdByLabel).toBe("Admin");
    expect(body.meta.id).toBe(1);

    res = await handlerFor(shimPut)(jsonRequest("PUT", { definition: OTHER_DEFINITION }));
    body = await res.json();
    expect(body.version.version).toBe(2);

    const getRes = await handlerFor(shimGet)(new Request("http://worker.test/"));
    const getBody = await getRes.json();
    expect(getBody.current.version).toBe(2);
    expect(getBody.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("accepts and round-trips a provider on an agent node", async () => {
    const def = {
      ...VALID_DEFINITION,
      nodes: VALID_DEFINITION.nodes.map((node) =>
        node.type === "planning_agent"
          ? { ...node, params: { ...node.params, provider: "codex" } }
          : node,
      ),
    };
    const res = await handlerFor(shimPut)(jsonRequest("PUT", { definition: def }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.definition).toEqual(def);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(shimPut)(jsonRequest("PUT", { definition: VALID_DEFINITION }));
    expect(res.status).toBe(403);
  });

  it("rejects a definition that fails the schema with 400 Invalid definition", async () => {
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", { definition: withBadParam(VALID_DEFINITION) }),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid definition:/);
  });

  it("rejects a structurally invalid graph with 400 Invalid workflow", async () => {
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", { definition: withUnreachableNode(VALID_DEFINITION) }),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid workflow:/);
  });
});

describe("POST /api/v1/workflow-definition/restore (shim)", () => {
  it("appends a copy of the requested version", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    await saveWorkflowDefinition(db, { ...ACTOR, definition: OTHER_DEFINITION });
    const res = await handlerFor(shimRestore)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.definition).toEqual(VALID_DEFINITION);
    expect(body.version.restoredFromVersion).toBe(1);
  });

  it("404s on an unknown version", async () => {
    const res = await handlerFor(shimRestore)(jsonRequest("POST", { version: 42 }));
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    state.sessionUserId = "user_member";
    const res = await handlerFor(shimRestore)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/session", () => {
  it("reports canEditWorkflows per role", async () => {
    let res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditWorkflows).toBe(true);

    state.sessionUserId = "user_member";
    res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect((await res.json()).canEditWorkflows).toBe(false);
  });
});
