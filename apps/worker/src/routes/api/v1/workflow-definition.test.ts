import { createApp, toWebHandler } from "h3";
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

const definitionGet = (await import("./workflow-definition.get.js")).default;
const definitionPut = (await import("./workflow-definition.put.js")).default;
const restorePost = (await import("./workflow-definition/restore.post.js")).default;
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

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://worker.test/", {
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

function withoutStatusNode(def: WorkflowDefinition): WorkflowDefinition {
  const statusId = def.nodes.find((node) => node.type === "update_ticket_status")!.id;
  return {
    ...def,
    nodes: def.nodes.filter((node) => node.id !== statusId),
    edges: def.edges.filter((edge) => edge.from !== statusId && edge.to !== statusId),
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

describe("GET /api/v1/workflow-definition", () => {
  it("returns empty state with default definition and editor options", async () => {
    const res = await handlerFor(definitionGet)(new Request("http://worker.test/"));
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
      const res = await handlerFor(definitionGet)(new Request("http://worker.test/"));
      const body = await res.json();
      expect(
        body.defaultDefinition.nodes.some((n: { type: string }) => n.type === "review_agent"),
      ).toBe(false);
    } finally {
      state.env.ENABLE_REVIEW_PHASE = true;
    }
  });
});

describe("PUT /api/v1/workflow-definition", () => {
  it("saves a valid definition and returns the new version", async () => {
    let res = await handlerFor(definitionPut)(jsonRequest("PUT", { definition: VALID_DEFINITION }));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.version.version).toBe(1);
    expect(body.version.definition).toEqual(VALID_DEFINITION);
    expect(body.version.createdByLabel).toBe("Admin");

    res = await handlerFor(definitionPut)(jsonRequest("PUT", { definition: OTHER_DEFINITION }));
    body = await res.json();
    expect(body.version.version).toBe(2);

    const getRes = await handlerFor(definitionGet)(new Request("http://worker.test/"));
    const getBody = await getRes.json();
    expect(getBody.current.version).toBe(2);
    expect(getBody.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(definitionPut)(jsonRequest("PUT", { definition: VALID_DEFINITION }));
    expect(res.status).toBe(403);
  });

  it("rejects a definition that fails the schema with 400 Invalid definition", async () => {
    const res = await handlerFor(definitionPut)(
      jsonRequest("PUT", { definition: withBadParam(VALID_DEFINITION) }),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid definition:/);
  });

  it("rejects a structurally invalid graph with 400 Invalid workflow", async () => {
    const res = await handlerFor(definitionPut)(
      jsonRequest("PUT", { definition: withoutStatusNode(VALID_DEFINITION) }),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid workflow:/);
  });
});

describe("POST /api/v1/workflow-definition/restore", () => {
  it("appends a copy of the requested version", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    await saveWorkflowDefinition(db, { ...ACTOR, definition: OTHER_DEFINITION });
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.version).toBe(3);
    expect(body.version.definition).toEqual(VALID_DEFINITION);
    expect(body.version.restoredFromVersion).toBe(1);
  });

  it("404s on an unknown version", async () => {
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 42 }));
    expect(res.status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await saveWorkflowDefinition(db, { ...ACTOR, definition: VALID_DEFINITION });
    state.sessionUserId = "user_member";
    const res = await handlerFor(restorePost)(jsonRequest("POST", { version: 1 }));
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
