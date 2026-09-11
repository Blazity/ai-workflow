import { createApp, createRouter, toWebHandler } from "h3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { BUILTIN_HARNESS_PROFILE_IDS, RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type { Db } from "../../../db/client.js";
import {
  member,
  organization,
  user,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../../../db/schema.js";
import { createTestDb } from "../../../db/test-db.js";
import { defaultWorkflowDefinitionV2 } from "../../../workflow-definition/default.js";
import {
  deployWorkflowDefinition,
  saveWorkflowDefinitionDraft,
} from "../../../services/workflow-definitions/policy-operations.js";

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

vi.mock("../../../config/env.js", () => ({ env: state.env }));
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
const detailCatalog = (await import("./workflow-definitions/[id]/catalog.post.js")).default;
const detailPromptPreview = (
  await import("./workflow-definitions/[id]/prompt-preview.post.js")
).default;
const sessionGet = (await import("./session.get.js")).default;

const VALID_DEFINITION = defaultWorkflowDefinitionV2({ includeReview: false });
const OTHER_DEFINITION = defaultWorkflowDefinitionV2({ includeReview: true });
const STORE_ACTOR = { role: "admin" as const, id: "user_admin", label: "Admin" };

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

function withBadParam(def: WorkflowDefinitionV2): WorkflowDefinitionV2 {
  return {
    ...def,
    edges: "bad" as never,
  };
}

function withUnreachableNode(def: WorkflowDefinitionV2): WorkflowDefinitionV2 {
  const statusId = def.nodes.find((node) => node.type === "update_ticket_status")!.id;
  return {
    ...def,
    edges: def.edges.filter((edge) => edge.to !== statusId),
  };
}

function withInvalidBinding(def: WorkflowDefinitionV2): WorkflowDefinitionV2 {
  return {
    ...def,
    nodes: def.nodes.map((node) =>
      node.type === "update_ticket_status"
        ? {
            ...node,
            inputs: {
              target: {
                kind: "reference",
                reference: "steps.ghost.output.target",
              },
            },
          }
        : node,
    ),
  };
}

function semantic(definition: WorkflowDefinitionV2): WorkflowDefinitionV2 {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
  };
}

async function saveDraft(
  definition: WorkflowDefinitionV2,
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
  definition: WorkflowDefinitionV2,
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
      version: 2,
    });
    expect(body.templates.map((template: { name: string }) => template.name)).toEqual([
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

  it("lists a retired deployment with effective status and no active triggers", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition: {
        schemaVersion: 1,
        nodes: [{ id: "legacy-trigger", type: "trigger_ticket_ai" }],
        edges: [],
      },
      createdById: "user_admin",
      createdByLabel: "Admin",
    });
    await db
      .update(workflowDefinitions)
      .set({
        deployedVersion: 1,
        enabled: true,
        triggerTypes: ["trigger_ticket_ai"],
      })
      .where(eq(workflowDefinitions.id, 1));

    const res = await handlerFor(definitionsGet)(new Request("http://worker.test/"));
    const body = await res.json();

    expect(body.definitions[0]).toMatchObject({
      enabled: true,
      deployedVersion: 1,
      deployedSchema: "legacy-v1",
      retiredMessage: RETIRED_SCHEMA_MESSAGE,
      triggerTypes: [],
    });
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
              version: 2,
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
      version: 2,
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

  it("refuses to duplicate a retired definition instead of substituting a default", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition: { schemaVersion: 1, nodes: [], edges: [] },
      createdById: "user_admin",
      createdByLabel: "Admin",
    });
    await db
      .update(workflowDefinitions)
      .set({ deployedVersion: 1 })
      .where(eq(workflowDefinitions.id, 1));

    const res = await handlerFor(definitionsPost)(
      jsonRequest("POST", {
        name: "Retired copy",
        source: { kind: "duplicate", definitionId: 1 },
      }),
    );

    expect(res.status).toBe(409);
    expect(res.statusText).toBe(RETIRED_SCHEMA_MESSAGE);
    expect(await res.json()).toMatchObject({ statusMessage: RETIRED_SCHEMA_MESSAGE });
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
    const limitedDefinition: WorkflowDefinitionV2 = {
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
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "deployment",
          severity: "error",
          nodeId: expect.any(String),
          path: expect.any(String),
          message: expect.stringContaining("unknown block"),
        }),
      ]),
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
          version: 2,
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

describe("POST /api/v1/workflow-definitions/:id/catalog", () => {
  const catalog = paramHandler("post", "/d/:id/catalog", detailCatalog);

  it("returns a no-store authoring catalog for an unsaved v2 candidate", async () => {
    const definition = defaultWorkflowDefinitionV2({ includeReview: false });
    const res = await catalog(
      jsonRequest(
        "POST",
        { definition },
        "http://worker.test/d/1/catalog",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({
      nodeContracts: expect.any(Object),
      catalogByNode: expect.any(Object),
    });
  });

  it("rejects malformed bodies without changing the saved draft", async () => {
    const before = await handlerFor(detailGet)(
      new Request("http://worker.test/?id=1"),
    );
    const res = await catalog(
      jsonRequest(
        "POST",
        { definition: { schemaVersion: 2, nodes: "invalid" } },
        "http://worker.test/d/1/catalog",
      ),
    );
    const after = await handlerFor(detailGet)(
      new Request("http://worker.test/?id=1"),
    );

    expect(res.status).toBe(400);
    expect(await after.json()).toEqual(await before.json());
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

  it("returns 409 when the selected version is a stored legacy definition", async () => {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 1,
      version: 1,
      definition: { schemaVersion: 1, nodes: [], edges: [] },
      createdById: "user_admin",
      createdByLabel: "Admin",
    });

    const res = await rollback(
      jsonRequest(
        "POST",
        { version: 1, expectedDeployedVersion: null },
        "http://worker.test/d/1/rollback",
      ),
    );

    expect(res.status).toBe(409);
    expect(res.statusText).toBe(RETIRED_SCHEMA_MESSAGE);
    expect(await res.json()).toMatchObject({
      statusCode: 409,
      statusMessage: RETIRED_SCHEMA_MESSAGE,
    });
  });

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
