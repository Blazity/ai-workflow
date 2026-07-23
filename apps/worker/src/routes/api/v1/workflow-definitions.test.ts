import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowDefinition,
  WorkflowDefinitionV1,
} from "@shared/contracts";
import { BUILTIN_HARNESS_PROFILE_IDS } from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import {
  member,
  organization,
  user,
  workflowDefinitionVersions,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import {
  createPrompt,
  getPromptVersion,
  savePromptVersion,
} from "../../../prompt-library/store.js";
import {
  defaultWorkflowDefinition,
  defaultWorkflowDefinitionV2,
} from "../../../workflow-definition/default.js";
import {
  deployWorkflowDefinition,
  saveWorkflowDefinitionDraft,
} from "../../../workflow-definition/store.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  failValidation: false,
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    ENABLE_REVIEW_PHASE: true,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test-default",
    CODEX_MODEL: "gpt-5-codex",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
  },
}));

vi.mock("../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../workflow-definition/validation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../workflow-definition/validation.js")>();
  return {
    ...actual,
    validateWorkflowDefinitionCandidate: (
      ...args: Parameters<typeof actual.validateWorkflowDefinitionCandidate>
    ) => {
      if (state.failValidation) throw new Error("validation backend unavailable");
      return actual.validateWorkflowDefinitionCandidate(...args);
    },
  };
});
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
    fetchTicketStatuses: vi.fn(async () => [
      { id: "10010", name: "AI Review" },
      { id: "10011", name: "Done" },
    ]),
  };
});

const definitionsGet = (await import("./workflow-definitions.get.js")).default;
const definitionsPost = (await import("./workflow-definitions.post.js")).default;
const detailGet = (await import("./workflow-definitions/[id].get.js")).default;
const detailPut = (await import("./workflow-definitions/[id].put.js")).default;
const detailPatch = (await import("./workflow-definitions/[id].patch.js")).default;
const detailDelete = (await import("./workflow-definitions/[id].delete.js")).default;
const detailRestore = (await import("./workflow-definitions/[id]/restore.post.js")).default;
const detailDeploy = (await import("./workflow-definitions/[id]/deploy.post.js")).default;
const detailRollback = (await import("./workflow-definitions/[id]/rollback.post.js")).default;
const detailLayout = (await import("./workflow-definitions/[id]/layout.patch.js")).default;
const detailValidate = (await import("./workflow-definitions/[id]/validate.post.js")).default;
const detailPromptPreview = (
  await import("./workflow-definitions/[id]/prompt-preview.post.js")
).default;
const detailMigrate = (await import("./workflow-definitions/[id]/migrate.post.js")).default;
const shimGet = (await import("./workflow-definition.get.js")).default;
const shimPut = (await import("./workflow-definition.put.js")).default;
const shimRestore = (await import("./workflow-definition/restore.post.js")).default;
const sessionGet = (await import("./session.get.js")).default;

const VALID_DEFINITION = defaultWorkflowDefinition({ includeReview: false });
const OTHER_DEFINITION = defaultWorkflowDefinition({ includeReview: true });
const STORE_ACTOR = { role: "admin" as const, id: "user_admin", label: "Admin" };

function migratableV1Definition(prompt?: string): WorkflowDefinitionV1 {
  const nodes: WorkflowDefinitionV1["nodes"] = [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      x: 0,
      y: 0,
      params: {},
      inputs: {},
    },
    prompt === undefined
      ? {
          id: "finish",
          type: "terminate",
          x: 240,
          y: 0,
          params: { terminalStatus: "done" },
          inputs: {},
        }
      : {
          id: "llm",
          type: "call_llm",
          x: 240,
          y: 0,
          params: { prompt },
          inputs: {},
        },
  ];
  return {
    schemaVersion: 1,
    nodes,
    edges: [{ from: "trigger", to: nodes[1]!.id }],
  };
}

function migratableImplementationDefinition(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        params: {},
        inputs: {},
      },
      {
        id: "implementation",
        type: "implementation_agent",
        x: 240,
        y: 0,
        params: {},
        inputs: {},
      },
    ],
    edges: [{ from: "trigger", to: "implementation" }],
  };
}

function blockedV1MigrationDefinition(): WorkflowDefinitionV1 {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        params: {},
        inputs: {},
      },
      {
        id: "llm",
        type: "call_llm",
        x: 240,
        y: 0,
        params: { prompt: "{{ticket_url}} {{unknown_variable}}" },
        inputs: { prompt: "steps.missing.output.output" },
      },
      {
        id: "decision",
        type: "branch",
        x: 480,
        y: 0,
        params: { condition: "steps.missing.output.ok === true" },
        inputs: {},
      },
    ],
    edges: [
      { from: "trigger", to: "llm", fromPort: "failed" },
      { from: "llm", to: "decision" },
    ],
  };
}

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

function withBadParam(def: WorkflowDefinitionV1): WorkflowDefinitionV1 {
  return {
    ...def,
    nodes: def.nodes.map((node) =>
      node.type === "planning_agent" ? { ...node, params: { bogus: "x" } } : node,
    ),
  };
}

function withUnreachableNode(def: WorkflowDefinitionV1): WorkflowDefinitionV1 {
  const statusId = def.nodes.find((node) => node.type === "update_ticket_status")!.id;
  return {
    ...def,
    edges: def.edges.filter((edge) => edge.to !== statusId),
  };
}

function withInvalidBinding(def: WorkflowDefinitionV1): WorkflowDefinitionV1 {
  return {
    ...def,
    nodes: def.nodes.map((node) =>
      node.type === "update_ticket_status"
        ? { ...node, inputs: { target: "steps.ghost.output.target" } }
        : node,
    ),
  };
}

function semantic(definition: WorkflowDefinitionV1): WorkflowDefinitionV1 {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
  };
}

async function saveDraft(
  definition: WorkflowDefinitionV1,
  expectedDraftRevision: number,
  definitionId = 1,
) {
  return saveWorkflowDefinitionDraft(db, {
    definitionId,
    definition,
    expectedDraftRevision,
    actor: STORE_ACTOR,
  });
}

async function deployDraft(
  expectedDraftRevision: number,
  expectedDeployedVersion: number | null,
  definitionId = 1,
) {
  return deployWorkflowDefinition(db, {
    definitionId,
    expectedDraftRevision,
    expectedDeployedVersion,
    actor: STORE_ACTOR,
  });
}

async function saveAndDeploy(
  definition: WorkflowDefinitionV1,
  expectedDraftRevision: number,
  expectedDeployedVersion: number | null,
  definitionId = 1,
) {
  const saved = await saveDraft(definition, expectedDraftRevision, definitionId);
  return deployDraft(saved.draftRevision, expectedDeployedVersion, definitionId);
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.sessionUserId = "user_admin";
  state.failValidation = false;
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
    expect(body.defaultDefinition.schemaVersion).toBe(2);
    expect(
      body.defaultDefinition.nodes.find(
        (node: { id: string }) => node.id === "planning",
      ).configuration.harnessProfile,
    ).toEqual({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.claude,
      version: 1,
    });
    expect(body.templates.map((template: { name: string }) => template.name)).toEqual([
      "Ticket workflow",
      "Human-approved plan",
      "Review & fix after PR",
      "Fully modular",
    ]);
    expect(
      body.templates.every(
        (template: { definition: { schemaVersion: number } }) =>
          template.definition.schemaVersion === 2,
      ),
    ).toBe(true);
    expect(body.options.agentKind).toBe("claude");
    expect(body.options.defaultModel).toBe("claude-test-default");
    expect(body.options.blockRegistry.trigger_ticket_ai.type).toBe("trigger_ticket_ai");
    expect(body.options.blockRegistry.arthur_injection_check.availability.unavailableReason).toBeTruthy();
    expect(body.options.runBindingSchema.properties.defaultAgent.type).toBe("object");
  });

  it("reports the latest saved version as currentVersion", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    const res = await handlerFor(definitionsGet)(new Request("http://worker.test/"));
    const body = await res.json();
    expect(body.definitions[0]).toMatchObject({ currentVersion: 1, deployedVersion: 1 });
  });

  it("pins the installation's configured built-in profile in new authoring choices", async () => {
    state.env.AGENT_KIND = "codex";
    try {
      const res = await handlerFor(definitionsGet)(
        new Request("http://worker.test/"),
      );
      const body = await res.json();
      const agentConfigurations = [
        body.defaultDefinition,
        ...body.templates.map(
          (template: { definition: unknown }) => template.definition,
        ),
      ].flatMap(
        (definition: {
          nodes: Array<{ type: string; configuration: Record<string, unknown> }>;
        }) =>
          definition.nodes
            .filter((node) =>
              [
                "planning_agent",
                "implementation_agent",
                "review_agent",
                "fix_agent",
                "generic_agent",
              ].includes(node.type),
            )
            .map((node) => node.configuration),
      );
      expect(agentConfigurations.length).toBeGreaterThan(0);
      expect(
        agentConfigurations.every(
          (configuration) =>
            JSON.stringify(configuration.harnessProfile) ===
            JSON.stringify({
              profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
              version: 1,
            }),
        ),
      ).toBe(true);
    } finally {
      state.env.AGENT_KIND = "claude";
    }
  });
});

describe("POST /api/v1/workflow-definitions", () => {
  it("creates a disabled definition from a named template", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "Approved delivery",
        source: { kind: "template", templateId: "human-approved-plan" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ name: "Approved delivery", enabled: false });
    expect(body.draft.schemaVersion).toBe(2);
    expect(body.draft.nodes.some((node: { type: string }) => node.type === "send_plan_approval")).toBe(
      true,
    );
    expect(body.draft.nodes.some((node: { type: string }) => node.type === "review_agent")).toBe(
      false,
    );
  });

  it("rejects an unknown template", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "Unknown template",
        source: { kind: "template", templateId: "missing" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a disabled definition seeded from the built-in default", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({
      id: 2,
      name: "Second flow",
      enabled: false,
      currentVersion: 1,
      deployedVersion: null,
      draftRevision: 1,
      layoutRevision: 1,
    });
    expect(body.current).toBeNull();
    expect(body.deployed).toBeNull();
    expect(body.versions).toHaveLength(1);
    expect(body.draft.schemaVersion).toBe(2);
    expect(
      body.draft.nodes.find(
        (node: { id: string }) => node.id === "planning",
      ).configuration.harnessProfile,
    ).toEqual({
      profileId: BUILTIN_HARNESS_PROFILE_IDS.claude,
      version: 1,
    });
    expect(body.draft.nodes.some((n: { type: string }) => n.type === "review_agent")).toBe(
      true,
    );
  });

  it("duplicates the mutable draft of the source definition", async () => {
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
    expect(body.deployed).toBeNull();
    expect(body.draft).toEqual(createdBody.draft);
  });

  it("duplicates a v1 source as v2 through the deterministic converter", async () => {
    await saveDraft(migratableV1Definition(), 0);

    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "V2 copy",
        source: { kind: "duplicate", definitionId: 1 },
        targetSchemaVersion: 2,
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({
      id: 2,
      name: "V2 copy",
      deployedVersion: null,
      draftRevision: 1,
    });
    expect(body.draft).toMatchObject({
      schemaVersion: 2,
      nodes: [
        { id: "trigger", configuration: {}, inputs: {}, additionalInputs: [] },
        {
          id: "finish",
          configuration: { terminalStatus: "done" },
          inputs: {},
          additionalInputs: [],
        },
      ],
    });
    expect(body.draft.edges[0].id).toMatch(/^edge-[a-f0-9]{24}$/);

    const sourceRes = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect((await sourceRes.json()).draft.schemaVersion).toBe(1);
  });

  it("reports every duplicate-as-v2 blocker without creating a destination", async () => {
    await saveDraft(blockedV1MigrationDefinition(), 0);
    const before = await handlerFor(definitionsGet)(
      new Request("http://worker.test/"),
    );
    expect((await before.json()).definitions).toHaveLength(1);

    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "Must not exist",
        source: { kind: "duplicate", definitionId: 1 },
        targetSchemaVersion: 2,
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.definition).toBeNull();
    expect(body.conversionHash).toBeNull();
    expect(body.blockers.map(({ code }: { code: string }) => code)).toEqual(
      expect.arrayContaining([
        "migration.edge.failure_port",
        "migration.binding.unprovable",
        "migration.branch.unparseable_condition",
        "migration.prompt.unsafe_variable",
        "migration.prompt.unresolved_placeholder",
      ]),
    );
    const after = await handlerFor(definitionsGet)(
      new Request("http://worker.test/"),
    );
    expect((await after.json()).definitions).toHaveLength(1);
  });

  it("rejects target schema selection outside duplication", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "Invalid v2 create",
        source: { kind: "default" },
        targetSchemaVersion: 2,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("duplicating the fresh built-in fallback seeds an editable default draft", async () => {
    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Copy of seed", source: { kind: "duplicate", definitionId: 1 } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployed).toBeNull();
    expect(body.draft.nodes.some((n: { type: string }) => n.type === "trigger_ticket_ai")).toBe(true);
    expect(body.draft.nodes.some((n: { type: string }) => n.type === "implementation_agent")).toBe(true);
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
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    const res = await paramHandler("get", "/d/:id", detailGet)(new Request("http://worker.test/d/1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({
      id: 1,
      currentVersion: 1,
      deployedVersion: 1,
      draftRevision: 1,
    });
    expect(body.draft).toEqual(semantic(VALID_DEFINITION));
    expect(body.deployed.version).toBe(1);
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

  it("saves semantic drafts as immutable versions without changing deployment", async () => {
    const limitedDefinition: WorkflowDefinitionV1 = {
      ...VALID_DEFINITION,
      budgets: {
        maxDurationMs: 120_000,
        maxTokens: 25_000,
        maxCostUsd: 4.5,
      },
    };
    let res = await put(
      jsonRequest(
        "PUT",
        { definition: limitedDefinition, expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.draft).toEqual(semantic(limitedDefinition));
    expect(body.meta).toMatchObject({
      id: 1,
      currentVersion: 1,
      deployedVersion: null,
      draftRevision: 1,
    });
    expect(body.validation).toMatchObject({ valid: true, issues: [] });
    expect(body.validationError).toBeNull();

    res = await put(
      jsonRequest(
        "PUT",
        { definition: OTHER_DEFINITION, expectedDraftRevision: 1 },
        "http://worker.test/d/1",
      ),
    );
    body = await res.json();
    expect(body.draft).toEqual(semantic(OTHER_DEFINITION));
    expect(body.meta).toMatchObject({ draftRevision: 2, deployedVersion: null });

    const detail = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect((await detail.json()).versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("accepts deploy-invalid typed bindings as a draft", async () => {
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: withInvalidBinding(VALID_DEFINITION), expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.draftRevision).toBe(1);
    expect(body.validation).toMatchObject({
      valid: false,
      issues: [
        expect.objectContaining({
          code: "deployment",
          severity: "error",
          nodeId: expect.any(String),
          path: expect.stringContaining("/inputs/target"),
        }),
      ],
    });
  });

  it("keeps a saved draft when immediate deployment validation is unavailable", async () => {
    state.failValidation = true;
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: VALID_DEFINITION, expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      meta: { draftRevision: 1 },
      validation: null,
      validationError: "Validation is temporarily unavailable. Your draft was saved.",
    });

    state.failValidation = false;
    const detail = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect((await detail.json()).meta.draftRevision).toBe(1);
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: VALID_DEFINITION, expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a definition that fails the schema with 400 Invalid definition", async () => {
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: withBadParam(VALID_DEFINITION), expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid definition:/);
  });

  it("accepts a structurally valid but unreachable graph as a draft", async () => {
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: withUnreachableNode(VALID_DEFINITION), expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(200);
  });

  it("404s when the definition is unknown", async () => {
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: VALID_DEFINITION, expectedDraftRevision: 0 },
        "http://worker.test/d/999",
      ),
    );
    expect(res.status).toBe(404);
  });

  it("409s on a stale draft compare-and-set", async () => {
    await saveDraft(VALID_DEFINITION, 0);
    const res = await put(
      jsonRequest(
        "PUT",
        { definition: OTHER_DEFINITION, expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(res.status).toBe(409);
  });
});

describe("POST /api/v1/workflow-definitions/:id/migrate", () => {
  const migrate = paramHandler("post", "/d/:id/migrate", detailMigrate);

  it("materializes the exact pinned v1 default prompt before validating v2", async () => {
    await saveDraft(migratableImplementationDefinition(), 0);

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.blockers).toEqual([]);
    expect(
      preview.definition.nodes.find(
        ({ id }: { id: string }) => id === "implementation",
      ).configuration.prompt,
    ).toBe("{{prompt:implement@1}}");
    expect(preview.conversions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.prompt.default_materialized",
          nodeId: "implementation",
        }),
        expect.objectContaining({
          code: "migration.prompt.reference_pinned",
          nodeId: "implementation",
        }),
      ]),
    );
  });

  it("produces a deployable v2 candidate for the legacy Ticket workflow", async () => {
    await saveDraft(defaultWorkflowDefinition({ includeReview: true }), 0);

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    const preview = await previewRes.json();

    expect(preview.blockers).toEqual([]);
    expect(preview.conversionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.definition).toMatchObject({ schemaVersion: 2 });
  });

  it("snapshots only legacy nested prompt composition without changing the library", async () => {
    const leaf = await createPrompt(db, {
      name: "Migration nested leaf",
      body: "Leaf body",
      actor: STORE_ACTOR,
    });
    const outer = await createPrompt(db, {
      name: "Migration nested outer",
      body: `Outer {{prompt:${leaf.prompt.id}}}`,
      actor: STORE_ACTOR,
    });
    await saveDraft(
      migratableV1Definition(
        `Use {{prompt:${outer.prompt.id}}}`,
      ),
      0,
    );

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.blockers).toEqual([]);
    expect(
      preview.definition.nodes.find(({ id }: { id: string }) => id === "llm")
        .configuration.prompt,
    ).toBe("Use Outer {{prompt:migration-nested-leaf@1}}");
    expect(preview.conversions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.prompt.nested_snapshot",
          nodeId: "llm",
        }),
        expect.objectContaining({
          code: "migration.prompt.reference_pinned",
          nodeId: "llm",
        }),
      ]),
    );
    expect(
      (await getPromptVersion(db, outer.prompt.id, 1))?.body,
    ).toBe(`Outer {{prompt:${leaf.prompt.id}}}`);
  });

  it("blocks missing, malformed, and cyclic prompt trees at their exact workflow paths", async () => {
    const cycleA = await createPrompt(db, {
      name: "Migration cycle A",
      body: "Initial A",
      actor: STORE_ACTOR,
    });
    const cycleB = await createPrompt(db, {
      name: "Migration cycle B",
      body: "{{prompt:migration-cycle-a@2}}",
      actor: STORE_ACTOR,
    });
    await savePromptVersion(db, {
      promptId: cycleA.prompt.id,
      body: `{{prompt:${cycleB.prompt.id}@1}}`,
      actor: STORE_ACTOR,
    });
    const invalidPrompts: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        {
          id: "trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          params: {},
          inputs: {},
        },
        ...[
          ["missing", "{{prompt:migration-does-not-exist@1}}"],
          ["malformed", "{{prompt:}}"],
          ["cyclic", "{{prompt:migration-cycle-a@2}}"],
        ].map(([id, prompt], index) => ({
          id: id!,
          type: "call_llm" as const,
          x: 240,
          y: index * 160,
          params: { prompt: prompt! },
          inputs: {},
        })),
      ],
      edges: [
        { from: "trigger", to: "missing" },
        { from: "trigger", to: "malformed" },
        { from: "trigger", to: "cyclic" },
      ],
    };
    await saveDraft(invalidPrompts, 0);

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    const preview = await previewRes.json();

    expect(preview.definition).toBeNull();
    expect(preview.conversionHash).toBeNull();
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.prompt.resolution_failed",
          nodeId: "missing",
          path: "/nodes/1/params/prompt",
        }),
        expect.objectContaining({
          code: "migration.prompt.resolution_failed",
          nodeId: "malformed",
          path: "/nodes/2/params/prompt",
        }),
        expect.objectContaining({
          code: "migration.prompt.resolution_failed",
          nodeId: "cyclic",
          path: "/nodes/3/params/prompt",
        }),
      ]),
    );
  });

  it("turns asynchronous v2 prompt validation failures into apply blockers", async () => {
    const invalid: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        {
          id: "trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          params: {},
          inputs: {},
        },
        {
          id: "generic",
          type: "generic_agent",
          x: 240,
          y: 0,
          params: { workspaceMode: "none" },
          inputs: {},
        },
      ],
      edges: [{ from: "trigger", to: "generic" }],
    };
    await saveDraft(invalid, 0);

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    const preview = await previewRes.json();

    expect(preview.definition).toBeNull();
    expect(preview.conversionHash).toBeNull();
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({
        code: "migration.target.prompt_empty",
        nodeId: "generic",
        path: "/nodes/1/configuration/prompt",
      }),
    );
  });

  it("previews and applies an exact immutable source without changing deployment", async () => {
    await saveDraft(migratableV1Definition(), 0);
    await deployDraft(1, null);
    await saveDraft(migratableV1Definition("This is the newer v1 draft."), 1);

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 2,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview).toMatchObject({
      mode: "preview",
      sourceDefinitionId: 1,
      sourceVersion: 1,
      targetSchemaVersion: 2,
      blockers: [],
      definition: {
        schemaVersion: 2,
        nodes: [
          { id: "trigger" },
          { id: "finish", type: "terminate" },
        ],
      },
    });
    expect(preview.conversionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.definition.edges[0].id).toMatch(/^edge-[a-f0-9]{24}$/);

    const applyRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "apply",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 2,
          expectedConversionHash: preview.conversionHash,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(applyRes.status).toBe(200);
    const applied = await applyRes.json();
    expect(applied).toMatchObject({
      mode: "apply",
      conversionHash: preview.conversionHash,
      meta: {
        draftRevision: 3,
        deployedVersion: 1,
      },
      draft: {
        schemaVersion: 2,
        nodes: [
          { id: "trigger" },
          { id: "finish", type: "terminate" },
        ],
      },
    });
    expect(applied.draft.edges).toEqual(preview.definition.edges);

    const detailRes = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    const detail = await detailRes.json();
    expect(detail.draft.schemaVersion).toBe(2);
    expect(detail.deployed).toMatchObject({
      version: 1,
      definition: { schemaVersion: 1 },
    });
    expect(
      detail.versions.map(
        ({ version, definition }: { version: number; definition: WorkflowDefinition }) => [
          version,
          definition.schemaVersion,
        ],
      ),
    ).toEqual([
      [3, 2],
      [2, 1],
      [1, 1],
    ]);
  });

  it("rejects apply when the draft CAS revision changed after preview", async () => {
    await saveDraft(migratableV1Definition(), 0);
    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    const preview = await previewRes.json();
    await saveDraft(migratableV1Definition("A concurrent edit."), 1);

    const applyRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "apply",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
          expectedConversionHash: preview.conversionHash,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(applyRes.status).toBe(409);
    const detailRes = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect(await detailRes.json()).toMatchObject({
      meta: { draftRevision: 2 },
      draft: { schemaVersion: 1 },
    });
  });

  it("rejects a stale conversion hash when a referenced prompt head moves", async () => {
    const prompt = await createPrompt(db, {
      name: "Migration hash drift unique",
      body: "Version one",
      actor: STORE_ACTOR,
    });
    await saveDraft(
      migratableV1Definition(
        "Use {{prompt:migration-hash-drift-unique}}",
      ),
      0,
    );

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(
      preview.definition.nodes.find(({ id }: { id: string }) => id === "llm")
        .configuration.prompt,
    ).toBe("Use {{prompt:migration-hash-drift-unique@1}}");

    const newPromptVersion = await savePromptVersion(db, {
      promptId: prompt.prompt.id,
      body: "Version two",
      actor: STORE_ACTOR,
    });
    expect(newPromptVersion).toMatchObject({
      changed: true,
      version: { version: 2 },
    });
    const refreshedPreviewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    const refreshedPreview = await refreshedPreviewRes.json();
    expect(
      refreshedPreview.definition.nodes.find(
        ({ id }: { id: string }) => id === "llm",
      ).configuration.prompt,
    ).toBe("Use {{prompt:migration-hash-drift-unique@2}}");
    expect(refreshedPreview.conversionHash).not.toBe(preview.conversionHash);

    const applyRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "apply",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
          expectedConversionHash: preview.conversionHash,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(applyRes.status).toBe(409);
    const detailRes = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect(await detailRes.json()).toMatchObject({
      meta: { draftRevision: 1 },
      draft: { schemaVersion: 1 },
    });
  });

  it("returns all blockers and never appends a partial migration", async () => {
    await saveDraft(blockedV1MigrationDefinition(), 0);
    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.definition).toBeNull();
    expect(preview.conversionHash).toBeNull();
    expect(preview.blockers.map(({ code }: { code: string }) => code)).toEqual(
      expect.arrayContaining([
        "migration.edge.failure_port",
        "migration.binding.unprovable",
        "migration.branch.unparseable_condition",
        "migration.prompt.unsafe_variable",
        "migration.prompt.unresolved_placeholder",
      ]),
    );

    const applyRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "apply",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
          expectedConversionHash: "0".repeat(64),
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(applyRes.status).toBe(422);
    expect(await applyRes.json()).toMatchObject({
      mode: "apply",
      error: "Workflow migration is blocked",
      definition: null,
      conversionHash: null,
    });

    const detailRes = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    const detail = await detailRes.json();
    expect(detail.meta.draftRevision).toBe(1);
    expect(detail.versions).toHaveLength(1);
    expect(detail.draft.schemaVersion).toBe(1);
  });

  it("preserves raw historical blockers while reporting safe converter blockers", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition: {
        schemaVersion: 1,
        hiddenTopLevel: { mode: "legacy" },
        nodes: [
          {
            id: "trigger",
            type: "trigger_ticket_ai",
            x: 0,
            y: 0,
            params: {},
            inputs: {},
            hiddenNodeBehavior: true,
          },
          {
            id: "finish",
            type: "terminate",
            x: 240,
            y: 0,
            params: {
              terminalStatus: "done",
              hiddenMode: "legacy",
            },
            inputs: {},
          },
        ],
        edges: [
          {
            from: "trigger",
            to: "finish",
            fromPort: "failed",
            hiddenEdgeBehavior: "legacy",
          },
        ],
      },
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.definition).toBeNull();
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.source.unknown_top_level_field",
          path: "/hiddenTopLevel",
        }),
        expect.objectContaining({
          code: "migration.source.unknown_node_field",
          nodeId: "trigger",
          path: "/nodes/0/hiddenNodeBehavior",
        }),
        expect.objectContaining({
          code: "migration.source.unknown_edge_field",
          nodeId: "trigger",
          path: "/edges/0/hiddenEdgeBehavior",
        }),
        expect.objectContaining({
          code: "migration.node.unknown_parameter",
          nodeId: "finish",
          path: "/nodes/1/params/hiddenMode",
        }),
        expect.objectContaining({
          code: "migration.edge.failure_port",
          nodeId: "trigger",
          path: "/edges/0/fromPort",
        }),
      ]),
    );
    expect(preview.conversions).not.toContainEqual(
      expect.objectContaining({
        code: "migration.source.compatibility_normalized",
      }),
    );

    const applyRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "apply",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
          expectedConversionHash: "0".repeat(64),
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(applyRes.status).toBe(422);
    expect(
      (
        await db.select().from(workflowDefinitionVersions)
      ).filter(({ definitionId }) => definitionId === 1),
    ).toHaveLength(1);

    const duplicateRes = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "Unsafe historical copy",
        source: { kind: "duplicate", definitionId: 1 },
        targetSchemaVersion: 2,
      }),
    );
    expect(duplicateRes.status).toBe(422);
    const definitionsRes = await handlerFor(definitionsGet)(
      new Request("http://worker.test/"),
    );
    expect((await definitionsRes.json()).definitions).toHaveLength(1);
  });

  it("keeps retired historical behavior as an explicit migration blocker", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition: {
        schemaVersion: 1,
        nodes: [
          {
            id: "trigger",
            type: "trigger_ticket_ai",
            x: 0,
            y: 0,
            params: {},
            inputs: {},
          },
          {
            id: "trace",
            type: "arthur_trace",
            x: 240,
            y: 0,
            params: {},
            inputs: {},
          },
          {
            id: "finish",
            type: "terminate",
            x: 480,
            y: 0,
            params: { terminalStatus: "done" },
            inputs: {},
          },
        ],
        edges: [
          { from: "trigger", to: "trace" },
          { from: "trace", to: "finish", fromPort: "out" },
        ],
      },
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );

    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.definition).toBeNull();
    expect(preview.conversionHash).toBeNull();
    expect(preview.blockers).toContainEqual(
      expect.objectContaining({
        code: "migration.source.retired_arthur_trace",
        nodeId: "trace",
        path: "/nodes/1/type",
      }),
    );
  });

  it("feeds benign missing-input compatibility upgrades into the converter", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition: {
        schemaVersion: 1,
        nodes: [
          {
            id: "trigger",
            type: "trigger_ticket_ai",
            x: 0,
            y: 0,
            params: {},
          },
          {
            id: "finish",
            type: "terminate",
            x: 240,
            y: 0,
            params: { terminalStatus: "done" },
          },
        ],
        edges: [{ from: "trigger", to: "finish" }],
      },
      createdById: "legacy",
      createdByLabel: "Legacy",
      restoredFromVersion: null,
    });

    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.blockers).toEqual([]);
    expect(preview.definition).toMatchObject({ schemaVersion: 2 });
    expect(preview.conversions).toContainEqual(
      expect.objectContaining({
        code: "migration.source.compatibility_normalized",
      }),
    );
  });

  it("allows members to preview but not apply", async () => {
    await saveDraft(migratableV1Definition(), 0);
    state.sessionUserId = "user_member";
    const previewRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "preview",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();

    const applyRes = await migrate(
      jsonRequest(
        "POST",
        {
          mode: "apply",
          sourceVersion: 1,
          targetSchemaVersion: 2,
          expectedDraftRevision: 1,
          expectedConversionHash: preview.conversionHash,
        },
        "http://worker.test/d/1/migrate",
      ),
    );
    expect(applyRes.status).toBe(403);
  });
});

describe("POST /api/v1/workflow-definitions/:id/prompt-preview", () => {
  const preview = paramHandler(
    "post",
    "/d/:id/prompt-preview",
    detailPromptPreview,
  );

  it("compiles one block from the exact unsaved v2 candidate without caching it", async () => {
    const definition = defaultWorkflowDefinitionV2({
      includeReview: false,
      provider: "claude",
    });
    const res = await preview(
      jsonRequest(
        "POST",
        { definition, blockId: "planning" },
        "http://worker.test/d/1/prompt-preview",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({
      blockId: "planning",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sections: [
        expect.objectContaining({ kind: "profile" }),
        expect.objectContaining({ kind: "block" }),
        expect.objectContaining({ kind: "runtime" }),
      ],
      provenance: expect.arrayContaining([
        expect.objectContaining({
          kind: "profile",
          id: BUILTIN_HARNESS_PROFILE_IDS.claude,
          version: 1,
        }),
      ]),
      unresolvedSources: expect.arrayContaining([
        expect.objectContaining({ kind: "repository" }),
      ]),
      issues: [],
    });
  });

  it("keeps the preview parent organization-scoped to an existing definition", async () => {
    const definition = defaultWorkflowDefinitionV2({
      includeReview: false,
    });
    const res = await preview(
      jsonRequest(
        "POST",
        { definition, blockId: "planning" },
        "http://worker.test/d/999/prompt-preview",
      ),
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/workflow-definitions/:id/validate", () => {
  const validate = paramHandler("post", "/d/:id/validate", detailValidate);

  it("reports deployment issues without rejecting the editable draft", async () => {
    const invalid = withInvalidBinding(VALID_DEFINITION);
    const save = await paramHandler("put", "/d/:id", detailPut)(
      jsonRequest(
        "PUT",
        { definition: invalid, expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(save.status).toBe(200);

    const res = await validate(
      jsonRequest("POST", { definition: invalid }, "http://worker.test/d/1/validate"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "deployment",
          severity: "error",
          nodeId: expect.any(String),
          path: expect.any(String),
          message: expect.stringContaining("unknown block"),
        }),
      ]),
    );
    expect(body.nodeContracts).toMatchObject({
      [invalid.nodes.find((node) => node.type === "update_ticket_status")!.id]: {
        type: "update_ticket_status",
        availability: { available: true, unavailableReason: null },
      },
    });
  });

  it("accepts a deployable graph", async () => {
    const res = await validate(
      jsonRequest("POST", { definition: VALID_DEFINITION }, "http://worker.test/d/1/validate"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      valid: true,
      issues: [],
      nodeContracts: {
        [VALID_DEFINITION.nodes[0]!.id]: {
          type: VALID_DEFINITION.nodes[0]!.type,
        },
      },
    });
  });

  it("returns structured schema issues without mutating the saved draft", async () => {
    await saveDraft(VALID_DEFINITION, 0);
    const res = await validate(
      jsonRequest(
        "POST",
        { definition: { schemaVersion: 2, nodes: [], edges: [] } },
        "http://worker.test/d/1/validate",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: false,
      issues: [
        {
          code: "deployment",
          severity: "error",
          nodeId: null,
          path: "/nodes",
          message: "Workflow must contain at least one trigger block.",
        },
      ],
      nodeContracts: {},
      availableValuesByNode: {},
    });

    const detail = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect((await detail.json()).meta.draftRevision).toBe(1);
  });
});

describe("POST /api/v1/workflow-definitions/:id/deploy", () => {
  const deploy = paramHandler("post", "/d/:id/deploy", detailDeploy);

  it("deploys one exact saved semantic version", async () => {
    await saveDraft(VALID_DEFINITION, 0);
    const res = await deploy(
      jsonRequest(
        "POST",
        { expectedDraftRevision: 1, expectedDeployedVersion: null },
        "http://worker.test/d/1/deploy",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ currentVersion: 1, deployedVersion: 1, draftRevision: 1 });
    expect(body.deployed).toMatchObject({ version: 1, definition: semantic(VALID_DEFINITION) });
  });

  it("rejects a draft that is not deployable", async () => {
    await saveDraft(withUnreachableNode(VALID_DEFINITION), 0);
    const res = await deploy(
      jsonRequest(
        "POST",
        { expectedDraftRevision: 1, expectedDeployedVersion: null },
        "http://worker.test/d/1/deploy",
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "Workflow has validation errors",
      issues: [
        expect.objectContaining({
          code: "deployment",
          severity: "error",
          nodeId: expect.any(String),
          message: expect.stringContaining("not reachable"),
        }),
      ],
    });
  });

  it("409s on stale expected state", async () => {
    await saveDraft(VALID_DEFINITION, 0);
    const res = await deploy(
      jsonRequest(
        "POST",
        { expectedDraftRevision: 0, expectedDeployedVersion: null },
        "http://worker.test/d/1/deploy",
      ),
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/v1/workflow-definitions/:id/layout", () => {
  const layout = paramHandler("patch", "/d/:id/layout", detailLayout);
  const nodeId = VALID_DEFINITION.nodes[0]!.id;

  it("persists layout with an independent compare-and-set revision", async () => {
    await saveDraft(VALID_DEFINITION, 0);
    const nextLayout = {
      nodes: { [nodeId]: { x: 140, y: 280 } },
      edges: {
        "stable-edge": { bend: { x: 240, y: 320 } },
      },
    };
    const res = await layout(
      jsonRequest(
        "PATCH",
        { layout: nextLayout, expectedLayoutRevision: 0 },
        "http://worker.test/d/1/layout",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toMatchObject({ draftRevision: 1, layoutRevision: 1 });
    expect(body.layout).toEqual(nextLayout);

    const detail = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    const detailBody = await detail.json();
    expect(detailBody.layout).toEqual(nextLayout);
    expect(detailBody.draft.nodes.find((node: { id: string }) => node.id === nodeId)).toMatchObject({
      x: 140,
      y: 280,
    });
  });

  it("409s on a stale layout revision", async () => {
    const nextLayout = {
      nodes: { [nodeId]: { x: 140, y: 280 } },
      edges: {},
    };
    await layout(
      jsonRequest(
        "PATCH",
        { layout: nextLayout, expectedLayoutRevision: 0 },
        "http://worker.test/d/1/layout",
      ),
    );
    const res = await layout(
      jsonRequest(
        "PATCH",
        { layout: nextLayout, expectedLayoutRevision: 0 },
        "http://worker.test/d/1/layout",
      ),
    );
    expect(res.status).toBe(409);
  });

  it("normalizes legacy node-only layout requests", async () => {
    const res = await layout(
      jsonRequest(
        "PATCH",
        {
          layout: { nodes: { [nodeId]: { x: 75, y: 125 } } },
          expectedLayoutRevision: 0,
        },
        "http://worker.test/d/1/layout",
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).layout).toEqual({
      nodes: { [nodeId]: { x: 75, y: 125 } },
      edges: {},
    });
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
    await deployDraft(1, null, 2);
    // The deployed id 2 snapshot carries trigger_ticket_ai and id 1 owns it.
    const res = await patch(jsonRequest("PATCH", { enabled: true }, "http://worker.test/d/2"));
    expect(res.status).toBe(409);
  });

  it("enables a definition once the conflicting one is disabled", async () => {
    await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    await deployDraft(1, null, 2);
    let res = await patch(jsonRequest("PATCH", { enabled: false }, "http://worker.test/d/1"));
    expect(res.status).toBe(200);
    res = await patch(jsonRequest("PATCH", { enabled: true }, "http://worker.test/d/2"));
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(true);
  });

  it("409s when enabling a draft-only definition", async () => {
    await handlerFor(definitionsPost)(
      jsonRequest("POST", { name: "Second flow", source: { kind: "default" } }),
    );
    await patch(jsonRequest("PATCH", { enabled: false }, "http://worker.test/d/1"));
    const res = await patch(jsonRequest("PATCH", { enabled: true }, "http://worker.test/d/2"));
    expect(res.status).toBe(409);
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

describe("POST /api/v1/workflow-definitions/:id/rollback", () => {
  const rollback = paramHandler("post", "/d/:id/rollback", detailRollback);

  it("selects an existing immutable version without copying it", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    await saveAndDeploy(OTHER_DEFINITION, 1, 1);
    const res = await rollback(
      jsonRequest(
        "POST",
        { version: 1, expectedDeployedVersion: 2 },
        "http://worker.test/d/1/rollback",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployed).toMatchObject({ version: 1, definition: semantic(VALID_DEFINITION) });
    expect(body.meta).toMatchObject({ currentVersion: 2, deployedVersion: 1 });

    const detail = await paramHandler("get", "/d/:id", detailGet)(
      new Request("http://worker.test/d/1"),
    );
    expect((await detail.json()).versions.map((version: { version: number }) => version.version)).toEqual([
      2,
      1,
    ]);
  });

  it("404s on an unknown version", async () => {
    const res = await rollback(
      jsonRequest(
        "POST",
        { version: 42, expectedDeployedVersion: null },
        "http://worker.test/d/1/rollback",
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns structured 422 issues when the selected v2 prompt is invalid", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    const invalid = defaultWorkflowDefinitionV2({ includeReview: false });
    invalid.nodes.find((node) => node.id === "planning")!.configuration.prompt =
      "{{unknown}}";
    await saveWorkflowDefinitionDraft(db, {
      definitionId: 1,
      definition: invalid,
      expectedDraftRevision: 1,
      actor: STORE_ACTOR,
    });

    const res = await rollback(
      jsonRequest(
        "POST",
        { version: 2, expectedDeployedVersion: 1 },
        "http://worker.test/d/1/rollback",
      ),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "Workflow has validation errors",
      issues: [
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          nodeId: "planning",
        }),
      ],
    });
  });

  it("rejects members with 403", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    state.sessionUserId = "user_member";
    const res = await rollback(
      jsonRequest(
        "POST",
        { version: 1, expectedDeployedVersion: 1 },
        "http://worker.test/d/1/rollback",
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/workflow-definitions/:id/restore (compatibility alias)", () => {
  const restore = paramHandler("post", "/d/:id/restore", detailRestore);

  it("uses rollback selection semantics", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    await saveAndDeploy(OTHER_DEFINITION, 1, 1);
    const res = await restore(
      jsonRequest(
        "POST",
        { version: 1, expectedDeployedVersion: 2 },
        "http://worker.test/d/1/restore",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployed.version).toBe(1);
  });

  it("returns structured 422 issues for an invalid v2 compatibility restore", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    const invalid = defaultWorkflowDefinitionV2({ includeReview: false });
    invalid.nodes.find((node) => node.id === "planning")!.configuration.prompt =
      "{{plan}}";
    await saveWorkflowDefinitionDraft(db, {
      definitionId: 1,
      definition: invalid,
      expectedDraftRevision: 1,
      actor: STORE_ACTOR,
    });

    const res = await restore(
      jsonRequest(
        "POST",
        { version: 2, expectedDeployedVersion: 1 },
        "http://worker.test/d/1/restore",
      ),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "Workflow has validation errors",
      issues: [
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          nodeId: "planning",
        }),
      ],
    });
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
      { value: "10010", label: "AI Review" },
      { value: "10011", label: "Done" },
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
  it("saves mutable drafts against the default definition", async () => {
    let res = await handlerFor(shimPut)(
      jsonRequest("PUT", { definition: VALID_DEFINITION, expectedDraftRevision: 0 }),
    );
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.draft).toEqual(semantic(VALID_DEFINITION));
    expect(body.meta).toMatchObject({ id: 1, draftRevision: 1, deployedVersion: null });

    res = await handlerFor(shimPut)(
      jsonRequest("PUT", { definition: OTHER_DEFINITION, expectedDraftRevision: 1 }),
    );
    body = await res.json();
    expect(body.draft).toEqual(semantic(OTHER_DEFINITION));
    expect(body.meta.draftRevision).toBe(2);

    const getRes = await handlerFor(shimGet)(new Request("http://worker.test/"));
    const getBody = await getRes.json();
    expect(getBody.current.version).toBe(2);
    expect(getBody.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("accepts a deploy-invalid graph as a draft", async () => {
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", {
        definition: withInvalidBinding(VALID_DEFINITION),
        expectedDraftRevision: 0,
      }),
    );
    expect(res.status).toBe(200);
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
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", { definition: def, expectedDraftRevision: 0 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual(semantic(def));
  });

  it("rejects members with 403", async () => {
    state.sessionUserId = "user_member";
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", { definition: VALID_DEFINITION, expectedDraftRevision: 0 }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a definition that fails the schema with 400 Invalid definition", async () => {
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", {
        definition: withBadParam(VALID_DEFINITION),
        expectedDraftRevision: 0,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.statusText).toMatch(/^Invalid definition:/);
  });

  it("accepts an unreachable graph as a draft", async () => {
    const res = await handlerFor(shimPut)(
      jsonRequest("PUT", {
        definition: withUnreachableNode(VALID_DEFINITION),
        expectedDraftRevision: 0,
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/workflow-definition/restore (shim)", () => {
  it("selects the requested immutable version", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    await saveAndDeploy(OTHER_DEFINITION, 1, 1);
    const res = await handlerFor(shimRestore)(
      jsonRequest("POST", { version: 1, expectedDeployedVersion: 2 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployed).toMatchObject({ version: 1, definition: semantic(VALID_DEFINITION) });
  });

  it("404s on an unknown version", async () => {
    const res = await handlerFor(shimRestore)(
      jsonRequest("POST", { version: 42, expectedDeployedVersion: null }),
    );
    expect(res.status).toBe(404);
  });

  it("returns structured 422 issues for an invalid v2 version", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    const invalid = defaultWorkflowDefinitionV2({ includeReview: false });
    invalid.nodes.find((node) => node.id === "planning")!.configuration.prompt =
      "{{unknown}}";
    await saveWorkflowDefinitionDraft(db, {
      definitionId: 1,
      definition: invalid,
      expectedDraftRevision: 1,
      actor: STORE_ACTOR,
    });

    const res = await handlerFor(shimRestore)(
      jsonRequest("POST", { version: 2, expectedDeployedVersion: 1 }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      issues: [
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          nodeId: "planning",
        }),
      ],
    });
  });

  it("rejects members with 403", async () => {
    await saveAndDeploy(VALID_DEFINITION, 0, null);
    state.sessionUserId = "user_member";
    const res = await handlerFor(shimRestore)(
      jsonRequest("POST", { version: 1, expectedDeployedVersion: 1 }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/session", () => {
  it("reports workflow edit and dispatch capabilities per role", async () => {
    let res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect(await res.json()).toMatchObject({
      actorLabel: "Admin",
      canEditWorkflows: true,
      canDispatchWorkflows: true,
    });

    state.sessionUserId = "user_member";
    res = await handlerFor(sessionGet)(new Request("http://worker.test/"));
    expect(await res.json()).toMatchObject({
      canEditWorkflows: false,
      canDispatchWorkflows: false,
    });
  });
});
