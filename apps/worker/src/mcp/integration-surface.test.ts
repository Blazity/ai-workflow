import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an agent that has never seen this deployment learns by asking, and what
 * it still cannot learn however it asks.
 *
 * The build ships no integration yet, so this file declares one. Everything
 * else is real: the tools are the registered handlers, the state goes through
 * the resolver the editor uses, and the answers travel back through the
 * envelope a client reads.
 */
const state = vi.hoisted(() => ({
  states: new Map<string, unknown>(),
  readFails: false,
  capabilities: [] as unknown[],
  capabilitiesFail: false,
}));

vi.mock("../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    JIRA_BASE_URL: "https://example.atlassian.net",
    ANTHROPIC_API_KEY: "sk-ant-test",
  },
}));

const DEMO_MANIFEST = vi.hoisted(() => {
  return {
    id: "demo",
    name: "Demo",
    description: "A provider core has never heard of.",
    connection: {
      fields: [
        { key: "baseUrl", label: "Site URL", env: "DEMO_BASE_URL", secret: false },
        { key: "apiToken", label: "API token", env: "DEMO_API_TOKEN", secret: true },
      ],
    },
    capabilities: [],
    blocks: [
      {
        type: "demo_announce",
        paramsSchema: undefined as unknown,
        contract: { ports: ["out"], allowsFailurePort: false },
        ui: {
          label: "Announce",
          description: "Announces a milestone.",
          glyph: "A",
          color: "#445566",
          softColor: "#EEF1F4",
        },
        defaults: { channel: "general" },
        inputs: {},
        output: { properties: {}, statusVariants: ["sent"] },
      },
    ],
    pages: [],
    health: [],
  };
});

vi.mock("@integrations/registry", async () => {
  const { z } = await import("zod");
  // The schema is attached here rather than in the hoisted literal above, which
  // runs before the zod import exists.
  const paramsSchema = z.object({ channel: z.string().min(1) }).strict();
  const blocksWithSchemas = DEMO_MANIFEST.blocks.map((block) =>
    Object.assign({}, block, { paramsSchema }),
  );
  const manifest = Object.assign({}, DEMO_MANIFEST, { blocks: blocksWithSchemas });
  const manifests = [manifest];
  const blocks = manifest.blocks.map((block) => ({ integrationId: manifest.id, block }));
  // The settings this registry's manifests declare, joined to core's the way
  // the real registry joins them, so the settings snapshot a request loads
  // resolves against this build of one integration.
  const { integrationSettingDefinitionsOf, settingDefinitionsOf } = await import("@integrations/sdk");
  const settingDefinitions = settingDefinitionsOf(manifests as never);
  return {
    integrationSettingDefinitions: integrationSettingDefinitionsOf(manifests as never),
    settingDefinitions,
    settingDefinition: (key: string) => settingDefinitions.find((definition) => definition.key === key),
    integrationManifests: manifests,
    integrationManifest: (id: string) => (id === manifest.id ? manifest : undefined),
    hasIntegration: (id: string) => id === manifest.id,
    integrationBlocks: blocks,
    integrationBlock: (type: string) =>
      blocks.find((entry) => entry.block.type === type),
    integrationsProviding: () => [],
  };
});

import type {
  IntegrationCapabilityDto,
  IntegrationState,
  IntegrationStatus,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { organization } from "../db/schema.js";
import { actorFor, depsFor } from "../test-support/mcp.js";
import { testDeploymentIntegrations } from "../test-support/integrations.js";
import { createMcpServer } from "./server.js";

const DECLARED_VARIABLES = ["DEMO_BASE_URL", "DEMO_API_TOKEN"];

function integrationState(status: IntegrationStatus): IntegrationState {
  const usable = status === "connected";
  return {
    integrationId: "demo",
    enabled: status !== "disabled",
    source: "environment",
    status,
    connection: status === "disabled" ? "connected" : status,
    verification: { state: "never_tested" },
    failure:
      status === "failing"
        ? {
            reason: "environment_incomplete",
            // Exactly what S2 composes for a half-set environment: the one
            // sentence an admin needs and an agent must never see.
            message:
              "Set DEMO_API_TOKEN on this deployment, or store the values from the dashboard",
            missingVariables: ["DEMO_API_TOKEN"],
          }
        : null,
    usable,
    environment:
      status === "failing"
        ? {
            setVariables: ["DEMO_BASE_URL"],
            missingVariables: ["DEMO_API_TOKEN"],
            complete: false,
          }
        : { setVariables: DECLARED_VARIABLES, missingVariables: [], complete: true },
    stored: {
      latestVersion: 0,
      activeVersion: null,
      missingFields: [],
      complete: false,
      prepared: null,
    },
    pin: { integrationId: "demo", configFingerprint: "abcabcabcabc" },
    secretsKeyAvailable: true,
  };
}

function declare(status: IntegrationStatus): void {
  state.states = new Map([["demo", integrationState(status)]]);
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db
    .insert(organization)
    .values({ id: "org-execute", name: "Execute", slug: "execute" });
  state.readFails = false;
  state.capabilities = [];
  state.capabilitiesFail = false;
  declare("connected");
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(): Promise<Client> {
  const deps = depsFor(db, () => new Date("2026-09-19T10:00:00.000Z"), {
    actor: actorFor({
      scopes: new Set(["mcp:read", "runs:dispatch", "workflows:write"]),
    }),
    // This deployment, stated. Read on every call rather than once, because one
    // of the cases below is an admin changing a connection between two calls,
    // and a value captured here would answer both from the first read.
    loadDeploymentIntegrations: async () => {
      if (state.readFails) throw new Error("connection terminated unexpectedly");
      return testDeploymentIntegrations([...state.states.values()] as IntegrationState[]);
    },
    loadCapabilityOverview: async () => {
      if (state.capabilitiesFail) throw new Error("connection terminated unexpectedly");
      return { capabilities: state.capabilities as IntegrationCapabilityDto[] };
    },
  });
  // The real server: every tool an agent can reach, registered exactly once and
  // in the order the contract publishes them.
  const server = createMcpServer(deps);
  const client = new Client({ name: "surface-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function dataOf(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

type IntegrationFact = {
  id: string;
  name: string;
  status: string;
  usable: boolean;
  capabilities: string[];
  blocks: { type: string; available: boolean; unavailableReason: string | null }[];
};

async function integrationsOf(client: Client): Promise<IntegrationFact[]> {
  const result = await client.callTool({ name: "system.capabilities", arguments: {} });
  return dataOf(result).integrations as IntegrationFact[];
}

const DISPATCH_PREFLIGHT = {
  definitionId: 1,
  triggerNodeId: "trigger",
  input: { kind: "ticket" as const, ticketKey: "PROJ-1" },
};

const GRAPH = {
  schemaVersion: 2,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket enters the AI column",
      x: 40,
      y: 280,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "announce",
      type: "demo_announce",
      name: "Announce",
      x: 300,
      y: 280,
      configuration: { channel: "releases" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [{ id: "trigger-out-announce", from: "trigger", to: "announce" }],
};

async function createDefinition(client: Client): Promise<number> {
  const result = await client.callTool({
    name: "workflows.create",
    arguments: { name: "Demo workflow", idempotencyKey: randomUUID() },
  });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return dataOf(result).definitionId as number;
}

describe("what an agent learns from one question", () => {
  it("publishes the integration facts as part of one fixed answer shape", async () => {
    // Pinned here because nothing else would notice: the contract hash covers
    // tool names, descriptions, input schemas and annotations, so a field added
    // to or dropped from a RESPONSE moves nothing a client could check.
    const client = await connectedClient();

    const data = dataOf(await client.callTool({ name: "system.capabilities", arguments: {} }));

    expect(Object.keys(data).sort()).toEqual([
      "authoringAnnouncements",
      "capabilities",
      "contractHash",
      "deploymentClass",
      "enabledDomains",
      "integrations",
      "protocolVersions",
      "readScopes",
      "serverVersion",
    ]);
  });

  it("says which provider serves each capability, and never an admin's failure sentence", async () => {
    // The Integrations page could say memory runs on the built-in store, or
    // that a chosen engine refused; an agent building a workflow could not.
    // The refusal's own sentence carries the provider's failure text, which
    // is where a variable name lives, so it is replaced whole.
    state.capabilities = [
      {
        id: "memory",
        label: "Memory",
        cardinality: "one",
        declaredBy: ["demo"],
        serving: {
          kind: "refused",
          ids: ["demo"],
          reason:
            "Demo is switched on for memory and its connection is failing (Set DEMO_API_TOKEN on this deployment), so memory was not used",
        },
      },
      {
        id: "issue_tracker",
        label: "Issue tracker",
        cardinality: "one",
        declaredBy: [],
        serving: { kind: "none" },
      },
    ];
    const client = await connectedClient();

    const data = dataOf(await client.callTool({ name: "system.capabilities", arguments: {} }));

    expect(JSON.stringify(data.capabilities)).not.toMatch(/DEMO_API_TOKEN/i);
    expect(data.capabilities).toEqual([
      {
        id: "memory",
        label: "Memory",
        cardinality: "one",
        declaredBy: ["demo"],
        serving: {
          kind: "refused",
          ids: ["demo"],
          reason:
            "the provider chosen for it is not working, so nothing serves it; an admin can fix it on the Integrations page in the dashboard",
        },
      },
      {
        id: "issue_tracker",
        label: "Issue tracker",
        cardinality: "one",
        declaredBy: [],
        serving: { kind: "none" },
      },
    ]);
  });

  it("answers null for the capabilities it could not read, and the rest as usual", async () => {
    state.capabilitiesFail = true;
    const client = await connectedClient();

    const result = await client.callTool({ name: "system.capabilities", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result).capabilities).toBeNull();
    expect(dataOf(result).integrations).not.toBeNull();
  });

  it("still answers the rest when the integration state cannot be read", async () => {
    // This is the first call every client makes, and it is where protocol
    // versions, the contract hash and the announcement channel come from. A
    // database hiccup must not turn it into a dependency failure, and null must
    // not be mistaken for "this deployment has no integration".
    state.readFails = true;
    const client = await connectedClient();

    const result = await client.callTool({ name: "system.capabilities", arguments: {} });

    expect(result.isError).not.toBe(true);
    const data = dataOf(result);
    expect(data.integrations).toBeNull();
    expect(data.protocolVersions).toEqual(["2025-11-25", "2025-06-18"]);
    expect(data.contractHash).toEqual(expect.any(String));
  });

  it("names every integration, its state and the blocks it unlocks", async () => {
    const client = await connectedClient();

    expect(await integrationsOf(client)).toEqual([
      {
        id: "demo",
        name: "Demo",
        status: "connected",
        usable: true,
        capabilities: [],
        blocks: [{ type: "demo_announce", available: true, unavailableReason: null }],
      },
    ]);
  });

  it("agrees with the block catalog about every integration block", async () => {
    declare("disabled");
    const client = await connectedClient();

    const facts = await integrationsOf(client);
    const listed = (
      dataOf(await client.callTool({ name: "blocks.list", arguments: {} })).blocks as Array<{
        type: string;
        availability: { available: boolean; unavailableReason: string | null };
      }>
    ).filter((block) => block.type.startsWith("demo_"));

    expect(listed).toHaveLength(1);
    for (const block of facts[0]?.blocks ?? []) {
      const contract = listed.find((entry) => entry.type === block.type);
      expect(contract?.availability.available).toBe(block.available);
      expect(contract?.availability.unavailableReason).toBe(block.unavailableReason);
    }
  });

  it("answers the next call with the state an admin just changed", async () => {
    const client = await connectedClient();
    expect((await integrationsOf(client))[0]?.usable).toBe(true);

    declare("disabled");

    const after = await integrationsOf(client);
    expect(after[0]?.usable).toBe(false);
    expect(after[0]?.status).toBe("disabled");
  });
});

describe("what no answer may carry", () => {
  it("never names a variable, on any surface, for a half-configured integration", async () => {
    declare("failing");
    const client = await connectedClient();
    const definitionId = await createDefinition(client);

    const payloads = [
      JSON.stringify(
        await client.callTool({ name: "system.capabilities", arguments: {} }),
      ),
      JSON.stringify(await client.callTool({ name: "blocks.list", arguments: {} })),
      JSON.stringify(
        await client.callTool({ name: "blocks.get", arguments: { type: "demo_announce" } }),
      ),
      JSON.stringify(
        await client.callTool({
          name: "workflows.save_draft",
          arguments: {
            definitionId,
            expectedDraftRevision: 0,
            definition: GRAPH,
            idempotencyKey: randomUUID(),
          },
        }),
      ),
      // The dispatch preflight composes its own blocker sentence, and its
      // refusals leave as error messages the envelope sanitizer never sees.
      JSON.stringify(
        await client.callTool({
          name: "workflows.dispatch_preflight",
          arguments: DISPATCH_PREFLIGHT,
        }),
      ),
    ];

    for (const payload of payloads) {
      for (const name of DECLARED_VARIABLES) {
        expect(payload).not.toContain(name);
      }
    }
  });

  it("still tells the agent which integration to name to a person", async () => {
    declare("failing");
    const client = await connectedClient();

    const reason = (await integrationsOf(client))[0]?.blocks[0]?.unavailableReason ?? "";

    expect(reason).toContain("Demo");
    expect(reason).toContain("Integrations page");
  });
});

describe("saving a draft that uses an integration nobody connected", () => {
  it("stores the draft and says why it cannot be published, naming the integration", async () => {
    declare("not_connected");
    const client = await connectedClient();
    const definitionId = await createDefinition(client);

    const result = await client.callTool({
      name: "workflows.save_draft",
      arguments: {
        definitionId,
        expectedDraftRevision: 0,
        definition: GRAPH,
        idempotencyKey: randomUUID(),
      },
    });

    const data = dataOf(result);
    expect(result.isError).not.toBe(true);
    // Stored, exactly as the editor stores a draft that is not yet deployable.
    expect(data.draftRevision).toBe(1);
    expect(data.deployable).toBe(false);
    const issues = data.deploymentIssues as Array<{ nodeId: string; message: string }>;
    expect(issues.some((issue) => issue.nodeId === "announce")).toBe(true);
    expect(issues.map((issue) => issue.message).join(" ")).toContain("Demo is not connected");
    // The total, not the length of the capped list: an agent that fixed a
    // capped page and met another must be able to tell that from new damage.
    expect(data.deploymentIssueCount).toBe(issues.length);
  });

  it("reports a clean draft as deployable, so the flag means something", async () => {
    const client = await connectedClient();
    const definitionId = await createDefinition(client);

    const result = await client.callTool({
      name: "workflows.save_draft",
      arguments: {
        definitionId,
        expectedDraftRevision: 0,
        definition: GRAPH,
        idempotencyKey: randomUUID(),
      },
    });

    expect(dataOf(result)).toMatchObject({ deployable: true, deploymentIssues: [] });
  });
});
