import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    // The one key this file resets: the environment answers 7 for it, so a
    // reset has something other than the registry default (3) to fall back to,
    // which is the whole difference between "clear the row" and "set it back to
    // the default".
    MAX_CONCURRENT_AGENTS: 7,
  },
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { mcpAuditEvents, organization, settings, settingsVersions } from "../../db/schema.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { policyFor } from "../policy.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { registerSettingsTools } from "./settings.js";

const ORG_ID = "org-execute";
const NOW = new Date("2026-09-12T09:00:00.000Z");

const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";

// A write needs this scope and nothing else, so asserting the happy path with
// only it is what proves the tool is not quietly riding on mcp:read.
const WRITE_ONLY: ReadonlySet<McpScope> = new Set(["settings:write"]);
/** Consent to author workflows, and nothing else: the nearest miss. */
const AUTHORING_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read", "workflows:write"]);
const READ_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read"]);

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
  // isSet() reads process.env directly (infra/settings-environment.ts), so the
  // variable has to be present here as well as in the mocked parsed env for the
  // resolution to label the value "environment" rather than "default".
  process.env.MAX_CONCURRENT_AGENTS = "7";
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  delete process.env.MAX_CONCURRENT_AGENTS;
});

async function connectedClient(
  actorOverrides: Partial<McpActorContext> = {},
): Promise<Client> {
  const server = new McpServer({ name: "settings-test", version: "0.1.0" });
  registerSettingsTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({
        organizationId: ORG_ID,
        role: "owner",
        scopes: new Set(["mcp:read", "settings:write"]),
        ...actorOverrides,
      }),
    }),
  );
  const client = new Client({ name: "settings-test-client", version: "1.0.0" });
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

function errorOf(result: ToolResult): { code: string; message: string } {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

type SettingView = {
  key: string;
  value: unknown;
  source: string;
  group: string;
  editable: boolean;
  role: string | null;
  appliesToRunsInFlight: string;
  requiresRedeploy: boolean;
};

function settingsOf(result: ToolResult): SettingView[] {
  return dataOf(result).settings as SettingView[];
}

describe("settings.list", () => {
  it("resolves every registry key and says which of them a write may touch", async () => {
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const result = await client.callTool({ name: "settings.list", arguments: {} });
    const rows = settingsOf(result);

    expect(result.isError).not.toBe(true);
    const concurrency = rows.find((row) => row.key === "MAX_CONCURRENT_AGENTS");
    expect(concurrency).toMatchObject({
      value: 7,
      source: "environment",
      group: "capacity",
      editable: true,
      role: "owner_or_admin",
      appliesToRunsInFlight: "immediate",
    });
    // The repositories group has a screen of its own: repositories.activate
    // states what stops passing before anything is flipped, and a generic
    // write must not be a second, quieter way to flip it.
    const catalog = rows.filter((row) => row.group === "repositories");
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((row) => row.editable === false && row.role === null)).toBe(true);
    // And this transport's own group, for a different reason: a client must not
    // be able to raise the ceilings it is being held to, or switch off the
    // surface it is talking through.
    const transport = rows.filter((row) => row.group === "mcp");
    expect(transport.map((row) => row.key)).toContain("MCP_TOOL_TIMEOUT_MS");
    expect(transport.every((row) => row.editable === false && row.role === null)).toBe(true);
    // And the switch that decides whether the transport answers at all, which
    // the registry files under `features` because that is where the dashboard
    // shows it. Refused here by name for the same reason as the group.
    const enabled = rows.find((row) => row.key === "MCP_ENABLED");
    expect(enabled).toMatchObject({ group: "features", editable: false, role: null });
  });

  it("says which keys the running code still reads from the environment", async () => {
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const rows = settingsOf(await client.callTool({ name: "settings.list", arguments: {} }));
    const allowlist = rows.find((row) => row.key === "PRE_PR_CHECKS_ALLOWED_ENV");

    // Storing this one records the decision and changes nothing until the
    // worker is redeployed, and "next run" would be a promise it does not keep.
    expect(allowlist).toMatchObject({
      requiresRedeploy: true,
      appliesToRunsInFlight: "after redeploy",
    });
    expect(
      rows.find((row) => row.key === "MAX_CONCURRENT_AGENTS"),
    ).toMatchObject({ requiresRedeploy: false, appliesToRunsInFlight: "immediate" });
  });

  // The registry deliberately holds no credential: keys, tokens and URLs stay in
  // the environment. This is the assertion that keeps it that way, because the
  // day one is added the list above would publish its value.
  it("publishes no key that looks like a credential", async () => {
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const rows = settingsOf(await client.callTool({ name: "settings.list", arguments: {} }));

    expect(
      rows.filter((row) => /SECRET|TOKEN|PASSWORD|_KEY$|CREDENTIAL/u.test(row.key)),
    ).toEqual([]);
  });
});

describe("settings.get", () => {
  it("answers one key with the changes recorded against it", async () => {
    const client = await connectedClient();
    await client.callTool({
      name: "settings.set",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        value: 5,
        reason: "one slot per reviewer",
        idempotencyKey: KEY_ONE,
      },
    });

    const result = await client.callTool({
      name: "settings.get",
      arguments: { key: "MAX_CONCURRENT_AGENTS" },
    });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.setting).toMatchObject({ value: 5, source: "stored", editable: true });
    expect(data.versions).toEqual([
      expect.objectContaining({
        key: "MAX_CONCURRENT_AGENTS",
        previousValue: null,
        newValue: 5,
        reason: "one slot per reviewer",
      }),
    ]);
  });

  it("pages the history and says when there is more of it", async () => {
    const client = await connectedClient();
    for (const [index, value] of [4, 5, 6].entries()) {
      await client.callTool({
        name: "settings.set",
        arguments: {
          key: "MAX_CONCURRENT_AGENTS",
          value,
          reason: `change ${index}`,
          idempotencyKey: `6666666${index}-6666-4666-8666-666666666666`,
        },
      });
    }

    const first = dataOf(
      await client.callTool({
        name: "settings.get",
        arguments: { key: "MAX_CONCURRENT_AGENTS", limit: 2 },
      }),
    );
    const firstPage = first.versions as Array<{ id: number; newValue: number }>;

    expect(firstPage.map((row) => row.newValue)).toEqual([6, 5]);
    expect(first.hasMore).toBe(true);

    const second = dataOf(
      await client.callTool({
        name: "settings.get",
        arguments: {
          key: "MAX_CONCURRENT_AGENTS",
          limit: 2,
          before: firstPage[1]?.id,
        },
      }),
    );

    expect((second.versions as Array<{ newValue: number }>).map((row) => row.newValue)).toEqual(
      [4],
    );
    expect(second.hasMore).toBe(false);
  });

  it("refuses a key the registry does not know instead of answering empty", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "settings.get",
      arguments: { key: "NOT_A_SETTING" },
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("unknown_key"),
    });
  });
});

describe("settings.set", () => {
  it("stores the value with its reason and reports what took effect", async () => {
    const client = await connectedClient({ scopes: WRITE_ONLY });

    const result = await client.callTool({
      name: "settings.set",
      arguments: {
        key: "JOB_TIMEOUT_MS",
        value: 600_000,
        reason: "agents were finishing well inside ten minutes",
        idempotencyKey: KEY_ONE,
      },
    });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.setting).toMatchObject({
      key: "JOB_TIMEOUT_MS",
      value: 600_000,
      source: "stored",
      // Read before expecting an effect: every run already executing finishes
      // under the value it started with.
      appliesToRunsInFlight: "next run",
    });
    expect(await db.select().from(settings)).toEqual([
      expect.objectContaining({ key: "JOB_TIMEOUT_MS", value: 600_000 }),
    ]);
    expect(await db.select().from(settingsVersions)).toEqual([
      expect.objectContaining({
        key: "JOB_TIMEOUT_MS",
        reason: "agents were finishing well inside ten minutes",
      }),
    ]);
  });

  it("refuses a value the registry does not accept and writes nothing", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "settings.set",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        value: 0,
        reason: "stop everything",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("below_minimum"),
    });
    expect(await db.select().from(settings)).toEqual([]);
  });

  it("refuses the catalog switch and points at the tool that states the impact", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "settings.set",
      arguments: {
        key: "catalog.activated",
        value: true,
        reason: "skip the dialog",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("repositories.activate"),
    });
    expect(await db.select().from(settings)).toEqual([]);
  });

  // S2: the self-lockout. A tool that could write these would be a client
  // raising its own ceilings, or switching off the transport it is talking
  // through and leaving nobody able to switch it back from here.
  it.each(["MCP_TOOL_TIMEOUT_MS", "MCP_READ_RATE_LIMIT_PER_MINUTE"])(
    "refuses %s and names the screen it is changed on",
    async (key) => {
      const client = await connectedClient();

      const result = await client.callTool({
        name: "settings.set",
        arguments: {
          key,
          value: 300_000,
          reason: "more room for me",
          idempotencyKey: KEY_ONE,
        },
      });

      expect(errorOf(result)).toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("dashboard Settings page"),
      });
      expect(errorOf(result).message).toContain(key);
      expect(await db.select().from(settings)).toEqual([]);
    },
  );

  it("refuses MCP_ENABLED, the switch that decides whether it answers at all", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "settings.set",
      arguments: {
        key: "MCP_ENABLED",
        value: false,
        reason: "quieter deployment",
        idempotencyKey: KEY_ONE,
      },
    });

    // The registry files it under `features`, beside the other capability
    // switches, so a group rule alone would have missed it: a client could have
    // closed the door it was standing in.
    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("dashboard Settings page"),
    });
    expect(await db.select().from(settings)).toEqual([]);
  });

  it("replays the same idempotency key instead of recording a second version", async () => {
    const client = await connectedClient();
    const args = {
      key: "MAX_CONCURRENT_AGENTS",
      value: 5,
      reason: "one slot per reviewer",
      idempotencyKey: KEY_ONE,
    };

    await client.callTool({ name: "settings.set", arguments: args });
    const replay = await client.callTool({ name: "settings.set", arguments: args });

    expect(replay.isError).not.toBe(true);
    expect(dataOf(replay).setting).toMatchObject({ value: 5 });
    expect(await db.select().from(settingsVersions)).toHaveLength(1);
  });

  it("refuses a member holding the scope, and a client-credentials token", async () => {
    const member = await connectedClient({ role: "member" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });
    const args = {
      key: "MAX_CONCURRENT_AGENTS",
      value: 5,
      reason: "raise it",
      idempotencyKey: KEY_ONE,
    };

    expect(errorOf(await member.callTool({ name: "settings.set", arguments: args }))).toMatchObject(
      { code: "FORBIDDEN" },
    );
    expect(
      errorOf(await service.callTool({ name: "settings.set", arguments: { ...args, idempotencyKey: KEY_TWO } })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(settings)).toEqual([]);
  });

  it("refuses a read-only token before it reaches the store", async () => {
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await client.callTool({
      name: "settings.set",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        value: 5,
        reason: "raise it",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    expect(await db.select().from(settings)).toEqual([]);
  });
});

describe("settings.reset", () => {
  it("clears the stored row so the environment answers again, and records it", async () => {
    const client = await connectedClient();
    await client.callTool({
      name: "settings.set",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        value: 5,
        reason: "one slot per reviewer",
        idempotencyKey: KEY_ONE,
      },
    });

    const result = await client.callTool({
      name: "settings.reset",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        reason: "let the deployment decide again",
        idempotencyKey: KEY_TWO,
      },
    });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.removed).toBe(true);
    // Not the registry default (3): this deployment's environment says 7, and
    // "reset" hands the key back to the resolution order rather than pinning it.
    expect(data.setting).toMatchObject({ value: 7, source: "environment", default: 3 });
    expect(await db.select().from(settings)).toEqual([]);
    const versions = await db.select().from(settingsVersions);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      key: "MAX_CONCURRENT_AGENTS",
      previousValue: 5,
      newValue: 7,
      reason: "let the deployment decide again",
    });
  });

  it("reports a key that was never stored as removed: false, not as an error", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "settings.reset",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        reason: "make sure nothing is pinned",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(dataOf(result)).toMatchObject({ removed: false });
    expect(dataOf(result).setting).toMatchObject({ value: 7, source: "environment" });
    expect(await db.select().from(settingsVersions)).toEqual([]);
  });

  it("refuses an unknown key, an admin, and a client-credentials token", async () => {
    const owner = await connectedClient();
    const admin = await connectedClient({ role: "admin" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });

    expect(
      errorOf(
        await owner.callTool({
          name: "settings.reset",
          arguments: { key: "NOT_A_SETTING", reason: "typo", idempotencyKey: KEY_ONE },
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      errorOf(
        await admin.callTool({
          name: "settings.reset",
          arguments: {
            key: "MAX_CONCURRENT_AGENTS",
            reason: "clear it",
            idempotencyKey: KEY_TWO,
          },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await service.callTool({
          name: "settings.reset",
          arguments: {
            key: "MAX_CONCURRENT_AGENTS",
            reason: "clear it",
            idempotencyKey: "33333333-3333-4333-8333-333333333333",
          },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(["MCP_ENABLED", "MCP_TOOL_TIMEOUT_MS", "MCP_READ_RATE_LIMIT_PER_MINUTE"])(
    "refuses to clear %s either",
    async (key) => {
      const owner = await connectedClient();

      const result = await owner.callTool({
        name: "settings.reset",
        arguments: { key, reason: "back to the default", idempotencyKey: KEY_ONE },
      });

      // Clearing is a change to the same value by another route, so it is
      // refused by the same rule and pointed at the same screen.
      expect(errorOf(result)).toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("dashboard Settings page"),
      });
    },
  );

  it("refuses the catalog switch here too, with the same pointer set gives", async () => {
    const owner = await connectedClient();

    const result = await owner.callTool({
      name: "settings.reset",
      arguments: {
        key: "catalog.activated",
        reason: "put the bridge back",
        idempotencyKey: KEY_ONE,
      },
    });

    // Clearing the row would turn activation off by the back door, with none of
    // the population the activation dialog makes an owner read first.
    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("repositories.activate"),
    });
  });

  // The lock that does not depend on somebody remembering to keep a role list
  // closed: a token with no `sub` never holds workflows:write in the first
  // place (withoutAuthoringScopes), and these lists refuse it again.
  it("keeps the owner-only, person-only policy on the two clearing tools", () => {
    expect(policyFor("settings.reset").roles).toEqual(["owner"]);
    expect(policyFor("repositories.activate").roles).toEqual(["owner"]);
    expect(policyFor("settings.set").roles).not.toContain("service");
    expect(policyFor("settings.set").scope).toBe("settings:write");
    expect(policyFor("settings.reset").scope).toBe("settings:write");
  });
});

describe("the scopes this surface asks for", () => {
  it("refuses a token holding only the authoring scope on both writes", async () => {
    const client = await connectedClient({ scopes: AUTHORING_ONLY });

    expect(
      errorOf(
        await client.callTool({
          name: "settings.set",
          arguments: {
            key: "MAX_CONCURRENT_AGENTS",
            value: 5,
            reason: "wrong scope",
            idempotencyKey: KEY_ONE,
          },
        }),
      ),
    ).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    expect(
      errorOf(
        await client.callTool({
          name: "settings.reset",
          arguments: {
            key: "MAX_CONCURRENT_AGENTS",
            reason: "wrong scope",
            idempotencyKey: KEY_TWO,
          },
        }),
      ),
    ).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    // Reading what is configured is not a configuration change, so mcp:read
    // still answers.
    expect(
      (await client.callTool({ name: "settings.list", arguments: {} })).isError,
    ).not.toBe(true);
  });
});

describe("the audit trail", () => {
  it("records the key a settings write touched, never the reason as text", async () => {
    const client = await connectedClient();

    await client.callTool({
      name: "settings.set",
      arguments: {
        key: "MAX_CONCURRENT_AGENTS",
        value: 5,
        reason: "MARKER-7c41ab why the limit moved",
        idempotencyKey: KEY_ONE,
      },
    });

    const rows = await db.select().from(mcpAuditEvents);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.toolName === "settings.set")).toBe(true);
    expect(rows.some((row) => row.outcome === "success")).toBe(true);
    expect(rows.every((row) => JSON.stringify(row.targetRefs) === '["MAX_CONCURRENT_AGENTS"]')).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain("MARKER-7c41ab");
  });
});
