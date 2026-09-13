import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  directory: {
    repositories: [] as Array<Record<string, unknown>>,
    providers: [] as Array<Record<string, unknown>>,
  },
  /** Empty on every test but the one that needs a suggestion to actually run:
   *  no provider configured is what the suggestion path finds when it goes
   *  looking for one, and the refusal that produces is its own test. */
  providers: [] as Array<Record<string, unknown>>,
}));

/** The two things a suggestion spends money on, held so one test can keep a
 *  call in flight while a second call arrives under the same key. */
const suggestion = vi.hoisted(() => ({
  loadProfile: vi.fn(),
  generateProviderText: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MAX_CONCURRENT_AGENTS: 3,
    ANTHROPIC_API_KEY: "anthropic-key",
  },
  getConfiguredVcsProviders: () => state.providers,
  getVcsProviderConfig: () => state.providers[0],
}));
vi.mock("../../infra/llm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/llm.js")>()),
  generateProviderText: suggestion.generateProviderText,
}));
vi.mock("../../adapters/vcs/create-vcs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/vcs/create-vcs.js")>()),
  createRepositoryProfileSource: () => ({ loadProfile: suggestion.loadProfile }),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
// The provider listing is the one thing the import half cannot do from a test
// database. Mocked at the discovery cluster's own interface, which is the
// boundary `import.ts` imports, so what is substituted is a service answer and
// not an HTTP client.
vi.mock("../../services/repository-discovery/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/repository-discovery/index.js")>();
  return { ...actual, listCachedRepositoryDirectory: async () => state.directory };
});

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  activeRuns,
  mcpAuditEvents,
  organization,
  repositorySuggestions,
  workflowOwnedBranches,
} from "../../db/schema.js";
import {
  activateRepositoryCatalog,
  setRepositoryEnabled,
  upsertRepositoryProfile,
} from "../../db/repositories/repository-catalog.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { policyFor } from "../policy.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { MCP_MAX_TOOL_TIMEOUT_MS, mcpToolTimeoutMs } from "../execute-tool.js";
import {
  REPOSITORY_SUGGESTION_TIMEOUT_MS,
  resetRepositorySuggestionsInFlightForTests,
} from "../../services/repository-catalog/index.js";
import {
  REPOSITORY_PROFILE_DEADLINE_MS as TOOL_PROFILE_DEADLINE_MS,
  registerRepositoryCatalogTools,
  repositorySuggestionDeadlineMs,
} from "./repositories.js";

const ORG_ID = "org-execute";
const NOW = new Date("2026-09-12T09:00:00.000Z");

const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";
const KEY_THREE = "33333333-3333-4333-8333-333333333333";

/** What the repository says about itself, as the profile source hands it over.
 *  Only the join is under test here; the bundle's content is irrelevant. */
const PROFILE_BUNDLE = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  description: "The API",
  readme: "# acme api",
  manifests: [{ path: "package.json", content: '{"scripts":{"test":"vitest"}}' }],
  lockfiles: ["pnpm-lock.yaml"],
  ciDefinitions: [],
  languages: ["TypeScript"],
  truncated: [],
};

/** What the model answers with, in the shape the suggestion schema asks for. */
const PROPOSAL = {
  description: "The team's public API.",
  rules: "- never force push",
  groups: [{ name: "test", commands: ["pnpm test"] }],
};

const WRITE_ONLY: ReadonlySet<McpScope> = new Set(["repositories:write"]);
const READ_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read"]);
/** Consent to author workflows, and nothing else: the nearest miss, and the
 *  whole reason the catalog does not ride on that scope. */
const AUTHORING_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read", "workflows:write"]);

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.directory = { repositories: [], providers: [] };
  state.providers = [];
  suggestion.loadProfile.mockReset();
  suggestion.generateProviderText.mockReset();
  resetRepositorySuggestionsInFlightForTests();
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function seedRepository(input: {
  path: string;
  enabled: boolean;
  description?: string;
  rules?: string;
  scriptGroups?: Record<string, unknown> | null;
}): Promise<number> {
  const saved = await upsertRepositoryProfile(db, {
    provider: "github",
    path: input.path,
    description: input.description ?? "",
    rules: input.rules ?? "",
    relationships: [],
    scriptGroups:
      input.scriptGroups === undefined
        ? { provider: "github", repoPath: input.path, groups: {} }
        : input.scriptGroups,
    gateGroups: null,
    actorId: "user-execute",
    actorLabel: "Ada",
    reason: "seeded",
    enabled: input.enabled,
  });
  if (!input.enabled) await setRepositoryEnabled(db, { id: saved.id, enabled: false });
  return saved.id;
}

async function connectedClient(
  actorOverrides: Partial<McpActorContext> = {},
): Promise<Client> {
  const server = new McpServer({ name: "repositories-test", version: "0.1.0" });
  registerRepositoryCatalogTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({
        organizationId: ORG_ID,
        role: "owner",
        scopes: new Set(["mcp:read", "repositories:write"]),
        ...actorOverrides,
      }),
    }),
  );
  const client = new Client({ name: "repositories-test-client", version: "1.0.0" });
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

function errorOf(result: ToolResult): {
  code: string;
  message: string;
  retryAfterMs?: number;
} {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

async function previewDigest(client: Client): Promise<string> {
  const result = await client.callTool({
    name: "repositories.activate_preview",
    arguments: {},
  });
  return dataOf(result).previewDigest as string;
}

describe("repositories.list", () => {
  it("answers with every row and whether the catalog decides access yet", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const result = await client.callTool({ name: "repositories.list", arguments: {} });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.state).toMatchObject({ activated: false, bridge: true });
    expect(
      (data.repositories as Array<{ path: string; enabled: boolean; source: string }>).map(
        (row) => [row.path, row.enabled, row.source],
      ),
    ).toEqual([
      ["acme/api", true, "manual"],
      ["acme/web", false, "manual"],
    ]);
  });

  // D6 / row M13. An agent deciding whether a repository is worth opening reads
  // this list, and "has it got any script groups" was the one thing the row
  // could not answer. Counted rather than listed: the names are one
  // `repositories.get` away and a listing of every group of every repository is
  // the payload nobody asked for.
  it("says how many script groups each repository declares", async () => {
    await seedRepository({
      path: "acme/api",
      enabled: true,
      scriptGroups: {
        provider: "github",
        repoPath: "acme/api",
        groups: { test: { commands: ["pnpm test"] }, lint: { commands: ["pnpm lint"] } },
      },
    });
    await seedRepository({ path: "acme/web", enabled: false, scriptGroups: null });
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const data = dataOf(
      await client.callTool({ name: "repositories.list", arguments: {} }),
    );

    expect(
      (data.repositories as Array<{ path: string; scriptGroupCount: number }>).map(
        (row) => [row.path, row.scriptGroupCount],
      ),
    ).toEqual([
      ["acme/api", 2],
      ["acme/web", 0],
    ]);
  });
});

describe("repositories.get", () => {
  it("carries the profile the engine resolves and how many versions exist", async () => {
    const id = await seedRepository({
      path: "acme/api",
      enabled: true,
      description: "The public API",
      rules: "Never touch the migrations by hand",
    });
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const data = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );

    expect(data.repository).toMatchObject({ id, path: "acme/api", profileVersion: 1 });
    expect(data.currentProfile).toMatchObject({
      version: 1,
      description: "The public API",
      rules: "Never touch the migrations by hand",
      reason: "seeded",
    });
    expect(data.versionsCount).toBe(1);
  });

  it("answers NOT_FOUND for a repository the catalog does not hold", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.get",
      arguments: { repositoryId: 4242 },
    });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("repositories.list_versions", () => {
  it("names what each version moved compared with the one it replaced", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true, description: "v1" });
    const client = await connectedClient();
    await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        rules: "Ask before renaming a table",
        reason: "write the rules down",
        idempotencyKey: KEY_ONE,
      },
    });

    const data = dataOf(
      await client.callTool({
        name: "repositories.list_versions",
        arguments: { repositoryId: id },
      }),
    );
    const versions = data.versions as Array<{ version: number; changedFields: string[] }>;

    // Newest first, and the oldest diffs against nothing, so it names every
    // field it recorded rather than coming back empty.
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[0]?.changedFields).toEqual(["rules"]);
    expect(versions[1]?.changedFields).toEqual([
      "description",
      "rules",
      "relationships",
      "scriptGroups",
    ]);
  });
});

describe("repositories.list_versions, paged", () => {
  async function seedThreeVersions(client: Client, id: number): Promise<void> {
    await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        rules: "Ask before renaming a table",
        reason: "write the rules down",
        idempotencyKey: KEY_ONE,
      },
    });
    await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        description: "The public API",
        reason: "describe it",
        idempotencyKey: KEY_TWO,
      },
    });
  }

  it("hands back one page, says there is more, and pages on with before", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();
    await seedThreeVersions(client, id);

    const first = dataOf(
      await client.callTool({
        name: "repositories.list_versions",
        arguments: { repositoryId: id, limit: 2 },
      }),
    );
    const firstPage = first.versions as Array<{
      version: number;
      changedFields: string[] | null;
    }>;

    expect(firstPage.map((row) => row.version)).toEqual([3, 2]);
    expect(first.hasMore).toBe(true);
    expect(firstPage[0]?.changedFields).toEqual(["description"]);
    // Version 2 replaced version 1, which is not on this page: claiming a diff
    // against a version the caller was never given is the lie this null avoids.
    expect(firstPage[1]?.changedFields).toBeNull();

    const second = dataOf(
      await client.callTool({
        name: "repositories.list_versions",
        arguments: { repositoryId: id, limit: 2, before: 2 },
      }),
    );
    const secondPage = second.versions as Array<{
      version: number;
      changedFields: string[] | null;
    }>;

    expect(secondPage.map((row) => row.version)).toEqual([1]);
    expect(second.hasMore).toBe(false);
    // The oldest version of all replaced nothing, so it names what it recorded
    // rather than coming back null.
    expect(secondPage[0]?.changedFields).toEqual([
      "description",
      "rules",
      "relationships",
      "scriptGroups",
    ]);
  });

  it("counts the history in the database, not by measuring a page", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();
    await seedThreeVersions(client, id);

    const page = dataOf(
      await client.callTool({
        name: "repositories.list_versions",
        arguments: { repositoryId: id, limit: 1 },
      }),
    );
    const entry = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );

    expect((page.versions as unknown[]).length).toBe(1);
    expect(entry.versionsCount).toBe(3);
  });

  it("answers NOT_FOUND for a repository the catalog does not hold", async () => {
    const client = await connectedClient();

    expect(
      errorOf(
        await client.callTool({
          name: "repositories.list_versions",
          arguments: { repositoryId: 4242 },
        }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("repositories.upsert", () => {
  it("leaves the fields it was not given exactly as the stored profile has them", async () => {
    const id = await seedRepository({
      path: "acme/api",
      enabled: true,
      description: "The public API",
      rules: "Never touch the migrations by hand",
    });
    const client = await connectedClient({ scopes: WRITE_ONLY });

    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        rules: "Ask before renaming a table",
        reason: "the old rule was about a migration tool we dropped",
        idempotencyKey: KEY_ONE,
      },
    });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.version).toBe(2);
    // Named by the write itself, not inferred from the version moving.
    expect(data).toMatchObject({ unchanged: false, changedFields: ["rules"] });
    // Read back through a token that may read: a write-only token gets this far
    // and no further, which is the point of splitting the two scopes.
    const reader = await connectedClient();
    const after = dataOf(
      await reader.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.currentProfile).toMatchObject({
      // Given, so it moved.
      rules: "Ask before renaming a table",
      // Omitted, so it did NOT: an absent field never reaches the statement,
      // which carries the stored value forward.
      description: "The public API",
      scriptGroups: { provider: "github", repoPath: "acme/api", groups: {} },
      reason: "the old rule was about a migration tool we dropped",
    });
  });

  it("says so when the save asked for nothing the profile does not already say", async () => {
    const id = await seedRepository({
      path: "acme/api",
      enabled: true,
      description: "The public API",
    });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: id,
          provider: "github",
          path: "acme/api",
          description: "The public API",
          reason: "retrying a save I am not sure landed",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    // A row per save that changed nothing would turn the History tab into a log
    // of clicks, so no version is minted and the reply says which of the two
    // happened rather than leaving it to be read off a number that did not move.
    expect(data).toMatchObject({ unchanged: true, version: 1, changedFields: [] });
    const after = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.versionsCount).toBe(1);
  });

  it("clears a nullable field only when the call says null", async () => {
    const id = await seedRepository({
      path: "acme/api",
      enabled: true,
      scriptGroups: {
        provider: "github",
        repoPath: "acme/api",
        groups: { "unit-tests": { commands: ["pnpm test"] } },
      },
    });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: id,
          provider: "github",
          path: "acme/api",
          scriptGroups: null,
          reason: "no checks apply to this repository any more",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data).toMatchObject({ unchanged: false, changedFields: ["scriptGroups"] });
    const after = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.currentProfile).toMatchObject({ scriptGroups: null, version: 2 });
  });

  it("carries the whole-run checks ceiling this repository asks for", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: id,
          provider: "github",
          path: "acme/api",
          batchTimeoutMinutes: 45,
          reason: "the integration suite needs longer than the default",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data).toMatchObject({ changedFields: ["batchTimeoutMinutes"] });
    const after = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.currentProfile).toMatchObject({ batchTimeoutMinutes: 45 });
  });

  it("creates a repository the catalog has never seen, switched off", async () => {
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: 0,
          provider: "gitlab",
          path: "acme/group/infra",
          description: "Terraform for the cluster",
          reason: "first pass at the profile",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    // Writing a profile says what to run in a repository, never that the agent
    // may enter one.
    expect(data.repository).toMatchObject({
      provider: "gitlab",
      path: "acme/group/infra",
      enabled: false,
      profileVersion: 1,
    });
  });

  // D11. `enabled` on an existing repository used to be accepted and silently
  // discarded, which on the wire reads exactly like a grant that landed and
  // taught agents there were two ways to grant access. Refused when it would
  // MOVE the switch; the test below covers the value that moves nothing.
  it("refuses an enabled that would move the switch, and names the tool that grants", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: false });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        enabled: true,
        reason: "trying the quiet way in",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "enabled is not a profile field and this save would change it; use the switch on the Repositories list or repositories.set_enabled",
    });
    const after = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.repository).toMatchObject({ enabled: false, profileVersion: 1 });
  });

  // The other half of D11 as the gate settled it. Agents were told this field
  // was ignored on an edit, so a payload that repeats the switch's current
  // value asks for no change and must not lose the profile edit it carries.
  it("accepts an enabled that repeats where the switch already stands", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: false });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: id,
          provider: "github",
          path: "acme/api",
          description: "second save",
          enabled: false,
          reason: "an idempotent body",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data.repository).toMatchObject({ id, enabled: false });
    expect(data.changedFields).toContain("description");
  });

  it("still creates an enabled repository when the call is a create", async () => {
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: 0,
          provider: "github",
          path: "acme/new",
          enabled: true,
          reason: "first profile",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data.repository).toMatchObject({ path: "acme/new", enabled: true });
  });

  // D3 / row P24. The save is deliberately permissive (the documented uv setup
  // preset is exactly this shape), so the refusal an operator does not get is
  // replaced by a warning they do.
  it("returns a warning for every command that downloads and runs remote code", async () => {
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: 0,
          provider: "github",
          path: "acme/python",
          scriptGroups: {
            provider: "github",
            repoPath: "acme/python",
            setup: ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
            groups: { test: { commands: ["uv run pytest"] } },
          },
          reason: "the documented uv preset",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data.warnings).toEqual([
      {
        group: "setup",
        command: "curl -LsSf https://astral.sh/uv/install.sh | sh",
        kind: "remote_execution",
      },
    ]);
    // Warned, not refused: the profile is stored.
    expect(data.repository).toMatchObject({ path: "acme/python", profileVersion: 1 });
  });

  it("returns an empty warning list when every command is local", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: false });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.upsert",
        arguments: {
          repositoryId: id,
          provider: "github",
          path: "acme/api",
          rules: "never force push",
          reason: "house rules",
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data.warnings).toEqual([]);
  });

  // D12 / rows P29, P30. The refinements live in the contract, so this is the
  // MCP half of the same rule the route and the dashboard parse.
  it("refuses a relationship list that names one repository twice or names itself", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: false });
    const other = await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient();

    const itself = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        relationships: [{ repositoryId: id, label: "itself" }],
        reason: "a loop",
        idempotencyKey: KEY_ONE,
      },
    });
    expect(errorOf(itself).message).toContain("cannot be related to itself");

    const twice = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        relationships: [
          { repositoryId: other, label: "the client" },
          { repositoryId: other, label: "again" },
        ],
        reason: "a duplicate",
        idempotencyKey: KEY_TWO,
      },
    });
    expect(errorOf(twice).message).toContain("related twice");

    // An id the catalog does not hold is still accepted: the row it names may
    // be imported later.
    const unknown = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        relationships: [{ repositoryId: 4242, label: "imported next week" }],
        reason: "a forward reference",
        idempotencyKey: KEY_THREE,
      },
    });
    expect(unknown.isError).not.toBe(true);
  });

  it("refuses a create for a path the catalog already holds rather than editing it", async () => {
    const id = await seedRepository({
      path: "acme/api",
      enabled: true,
      description: "The public API",
    });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: 0,
        provider: "github",
        path: "acme/api",
        rules: "Ask before renaming a table",
        reason: "working from a stale list",
        idempotencyKey: KEY_ONE,
      },
    });

    // The route reconciles this into an edit. Here it is refused with the id to
    // use, because an agent that sends 0 believes it is creating and the write
    // would otherwise mint a version on somebody's configured repository under
    // a reason written for a new one.
    expect(errorOf(result)).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(`repositoryId ${id}`),
    });
    const after = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.currentProfile).toMatchObject({ description: "The public API", version: 1 });
  });

  it("refuses a save built on a profile that has moved since it was read", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        rules: "Ask first",
        expectedProfileVersion: 7,
        reason: "stale read",
        idempotencyKey: KEY_ONE,
      },
    });

    // The service's own refusal, raised by the predicate the writing statement
    // carries rather than by a read this tool made first, so the version it
    // names is the one the write saw and nothing landed.
    expect(errorOf(result)).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("profile version 1"),
    });
    expect(errorOf(result).message).toContain("Nothing was written");
    const after = dataOf(
      await client.callTool({ name: "repositories.get", arguments: { repositoryId: id } }),
    );
    expect(after.repository).toMatchObject({ profileVersion: 1 });
  });

  it("refuses a script group name the engine could never resolve", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        scriptGroups: {
          provider: "github",
          repoPath: "acme/api",
          groups: { "Unit Tests": { commands: ["pnpm test"] } },
        },
        reason: "add the test group",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("invalid_script_group_name"),
    });
  });

  it("refuses a member holding the scope, and a client-credentials token", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const member = await connectedClient({ role: "member" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });
    const args = {
      repositoryId: id,
      provider: "github",
      path: "acme/api",
      rules: "Ask first",
      reason: "not yours to change",
      idempotencyKey: KEY_ONE,
    };

    expect(
      errorOf(await member.callTool({ name: "repositories.upsert", arguments: args })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await service.callTool({
          name: "repositories.upsert",
          arguments: { ...args, idempotencyKey: KEY_TWO },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a read-only token before it reaches the catalog", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient({ scopes: READ_ONLY });

    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        rules: "Ask first",
        reason: "read-only client",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  });
});

describe("repositories.set_enabled", () => {
  it("flips the switch without minting a profile version", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: false });
    const client = await connectedClient({ scopes: WRITE_ONLY });

    const data = dataOf(
      await client.callTool({
        name: "repositories.set_enabled",
        arguments: {
          repositoryId: id,
          enabled: true,
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(data.repository).toMatchObject({ id, enabled: true, profileVersion: 1 });
    expect(data.enabledRemaining).toBe(1);
  });

  it("says when the switch just left the catalog with nothing enabled", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({
        name: "repositories.set_enabled",
        arguments: { repositoryId: id, enabled: false, idempotencyKey: KEY_ONE },
      }),
    );

    // The number that matters after the flip is not this row's flag: on an
    // activated catalog zero enabled repositories halts every next run.
    expect(data.enabledRemaining).toBe(0);
  });

  it("answers NOT_FOUND for a repository that does not exist", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.set_enabled",
      arguments: {
        repositoryId: 4242,
        enabled: true,
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a member and a client-credentials token", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: false });
    const member = await connectedClient({ role: "member" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });
    const args = {
      repositoryId: id,
      enabled: true,
      idempotencyKey: KEY_ONE,
    };

    expect(
      errorOf(await member.callTool({ name: "repositories.set_enabled", arguments: args })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await service.callTool({
          name: "repositories.set_enabled",
          arguments: { ...args, idempotencyKey: KEY_TWO },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("repositories.activate_preview", () => {
  it("states both populations and the repositories holding a run claim", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    await seedRepository({ path: "acme/web", enabled: false });
    await db.insert(activeRuns).values({
      subjectKey: "ticket:AIW-1",
      ticketKey: "AIW-1",
      ownerToken: "owner-1",
      runId: "wrun_1",
      state: "bound",
    });
    await db.insert(workflowOwnedBranches).values({
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/web",
      branchName: "ai/aiw-1",
    });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({ name: "repositories.activate_preview", arguments: {} }),
    );

    expect(data.state).toMatchObject({ activated: false, bridge: true });
    expect((data.keeping as Array<{ key: string }>).map((row) => row.key)).toEqual([
      "github:acme/api",
    ]);
    expect((data.stopping as Array<{ key: string }>).map((row) => row.key)).toEqual([
      "github:acme/web",
    ]);
    expect(data.claimed).toEqual([
      expect.objectContaining({
        key: "github:acme/web",
        ticketKeys: ["AIW-1"],
        runIds: ["wrun_1"],
      }),
    ]);
    expect(data.previewDigest).toMatch(/^sha256:[\da-f]{64}$/u);
  });

  it("refuses a member: the preview names the tickets and runs in flight", async () => {
    const client = await connectedClient({ role: "member", scopes: READ_ONLY });

    const result = await client.callTool({
      name: "repositories.activate_preview",
      arguments: {},
    });

    expect(errorOf(result)).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  });
});

describe("repositories.activate", () => {
  it("ends the bridge against the population the caller read", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.activate",
      arguments: {
        previewDigest: await previewDigest(client),
        reason: "the catalog is curated now",
        idempotencyKey: KEY_ONE,
      },
    });
    const data = dataOf(result);

    expect(result.isError).not.toBe(true);
    expect(data.state).toMatchObject({ activated: true, bridge: false });
    const list = dataOf(await client.callTool({ name: "repositories.list", arguments: {} }));
    expect(list.state).toMatchObject({ activated: true });
  });

  it("refuses a catalog with nothing enabled, in the dialog's own words", async () => {
    await seedRepository({ path: "acme/api", enabled: false });
    await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient();
    const digest = await previewDigest(client);

    const result = await client.callTool({
      name: "repositories.activate",
      arguments: {
        previewDigest: digest,
        reason: "let us start clean",
        idempotencyKey: KEY_ONE,
      },
    });

    // The digest is correct and the refusal is still right: confirming here
    // would stop dispatch selecting anything at all, which is why the dashboard
    // does not offer the button.
    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "no repository in this catalog is enabled, so activating would stop dispatch selecting every repository at once; enable at least one first",
    });
    const list = dataOf(await client.callTool({ name: "repositories.list", arguments: {} }));
    expect(list.state).toMatchObject({ activated: false, bridge: true });
  });

  it("refuses a digest taken before the catalog moved, and activates nothing", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    const disabledId = await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient();
    const stale = await previewDigest(client);

    // Somebody enables a repository between the preview and the confirmation,
    // so the populations the caller read no longer describe the catalog.
    await client.callTool({
      name: "repositories.set_enabled",
      arguments: {
        repositoryId: disabledId,
        enabled: true,
        idempotencyKey: KEY_TWO,
      },
    });

    const result = await client.callTool({
      name: "repositories.activate",
      arguments: {
        previewDigest: stale,
        reason: "the catalog is curated now",
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("previewDigest"),
    });
    const list = dataOf(await client.callTool({ name: "repositories.list", arguments: {} }));
    expect(list.state).toMatchObject({ activated: false, bridge: true });
  });

  it("is owner only and refuses a client-credentials token", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    const owner = await connectedClient();
    const digest = await previewDigest(owner);
    const admin = await connectedClient({ role: "admin" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });

    expect(
      errorOf(
        await admin.callTool({
          name: "repositories.activate",
          arguments: { previewDigest: digest, reason: "let me", idempotencyKey: KEY_ONE },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await service.callTool({
          name: "repositories.activate",
          arguments: { previewDigest: digest, reason: "let me", idempotencyKey: KEY_TWO },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    // The role list is the lock, exactly as it is for runs.answer_clarification.
    expect(policyFor("repositories.activate").roles).toEqual(["owner"]);
  });

  it("refuses when a repository takes a run claim after the preview was read", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    await seedRepository({ path: "acme/web", enabled: false });
    const client = await connectedClient();
    const digest = await previewDigest(client);

    // A claim appears, so the service's own acknowledgement check refuses even
    // though the digest still matches the rows.
    await db.insert(activeRuns).values({
      subjectKey: "ticket:AIW-2",
      ticketKey: "AIW-2",
      ownerToken: "owner-2",
      runId: "wrun_2",
      state: "bound",
    });
    await db.insert(workflowOwnedBranches).values({
      ticketKey: "AIW-2",
      provider: "github",
      repoPath: "acme/web",
      branchName: "ai/aiw-2",
    });

    const result = await client.callTool({
      name: "repositories.activate",
      arguments: {
        previewDigest: digest,
        reason: "the catalog is curated now",
        idempotencyKey: KEY_ONE,
      },
    });

    // The recomputed population now carries the claim, so the digest is the
    // first thing to disagree; either way nothing is activated.
    expect(result.isError).toBe(true);
    expect(["VALIDATION_FAILED", "CONFLICT"]).toContain(errorOf(result).code);
    const list = dataOf(await client.callTool({ name: "repositories.list", arguments: {} }));
    expect(list.state).toMatchObject({ activated: false });
  });

  it("reports an already activated catalog rather than pretending it was off", async () => {
    await seedRepository({ path: "acme/api", enabled: true });
    await activateRepositoryCatalog(db, {
      actorId: "user-execute",
      reason: "seeded activated",
    });
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({ name: "repositories.activate_preview", arguments: {} }),
    );

    expect(data.state).toMatchObject({ activated: true, bridge: false });
  });
});

describe("repositories.import", () => {
  beforeEach(() => {
    state.directory = {
      repositories: [
        {
          provider: "github",
          repoPath: "Acme/Api",
          name: "Api",
          owner: "Acme",
          defaultBranch: "main",
          private: true,
          archived: false,
        },
        {
          provider: "github",
          repoPath: "acme/docs",
          name: "docs",
          owner: "acme",
          defaultBranch: "main",
          private: false,
          archived: false,
        },
      ],
      providers: [
        { provider: "github", status: "ready" },
        { provider: "gitlab", status: "not_connected" },
      ],
    };
  });

  it("marks what the catalog already holds, then creates only the rest", async () => {
    await seedRepository({ path: "acme/api", enabled: false });
    const client = await connectedClient();

    const preview = dataOf(
      await client.callTool({ name: "repositories.import_preview", arguments: {} }),
    );
    expect(
      (preview.repositories as Array<{ key: string; inCatalog: boolean }>).map((row) => [
        row.key,
        row.inCatalog,
      ]),
    ).toEqual([
      ["github:acme/api", true],
      ["github:acme/docs", false],
    ]);

    const imported = dataOf(
      await client.callTool({
        name: "repositories.import",
        arguments: {
          repositoryKeys: ["github:acme/api", "github:acme/docs", "github:acme/gone"],
          idempotencyKey: KEY_ONE,
        },
      }),
    );

    expect(imported).toMatchObject({
      imported: 1,
      alreadyPresent: ["github:acme/api"],
      skipped: ["github:acme/gone"],
      repositoryCount: 2,
    });
  });

  it("refuses the whole call when a provider could not be listed", async () => {
    state.directory.providers = [
      { provider: "github", status: "error", error: "401" },
      { provider: "gitlab", status: "not_connected" },
    ];
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.import",
      arguments: {
        repositoryKeys: ["github:acme/docs"],
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: expect.stringContaining("provider_unavailable"),
    });
  });

  it("refuses a member and a client-credentials token", async () => {
    const member = await connectedClient({ role: "member" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });
    const args = {
      repositoryKeys: ["github:acme/docs"],
      idempotencyKey: KEY_ONE,
    };

    expect(
      errorOf(await member.callTool({ name: "repositories.import", arguments: args })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await service.callTool({
          name: "repositories.import",
          arguments: { ...args, idempotencyKey: KEY_TWO },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await member.callTool({ name: "repositories.import_preview", arguments: {} }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("repositories.suggest", () => {
  it("carries the wait back when the repository has had its hour's worth", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    for (let index = 0; index < 10; index += 1) {
      await db.insert(repositorySuggestions).values({
        repositoryId: id,
        actorId: "user-execute",
        actorLabel: "Ada",
        model: "test-model",
        outcome: "proposed",
        createdAt: new Date(Date.now() - 60_000),
      });
    }
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.suggest",
      arguments: {
        repositoryId: id,
        idempotencyKey: KEY_ONE,
      },
    });

    expect(errorOf(result)).toMatchObject({ code: "RATE_LIMITED" });
    expect(errorOf(result).retryAfterMs).toBeGreaterThan(0);
    // A refusal is not a call: nothing was asked of the provider and no row was
    // written, so the history keeps holding the ten that cost money.
    expect(await db.select().from(repositorySuggestions)).toHaveLength(10);
  });

  it("forwards a provider failure as DEPENDENCY_UNAVAILABLE, with its constant", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();

    // Nothing is configured to read a repository from, so the profile source
    // half of the call fails: a 502 from the service carrying a symbolic
    // constant, never a provider's own prose.
    const result = await client.callTool({
      name: "repositories.suggest",
      arguments: { repositoryId: id, idempotencyKey: KEY_ONE },
    });

    expect(errorOf(result)).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "profile_source_failed",
      retryable: true,
    });
    // The failed attempt is still recorded, because it is what the hourly
    // budget counts and what the cost page reads.
    const rows = await db.select().from(repositorySuggestions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("failed");
  });

  // D13 / row S17. The mutation wrapper refuses a second call under the same
  // key while the first holds the lease, and for every other tool that refusal
  // is right. For this one it was the place this surface was meaner than the
  // screen it mirrors: a second browser click AWAITS the answer already being
  // paid for, while an agent retried into the same refusal for as long as the
  // model took.
  it("joins the suggestion already running when the same key comes back in flight", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    state.providers = [
      { kind: "github", auth: { appId: 1, privateKeyBase64: "cGVt", installationId: 2 } },
    ];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    suggestion.loadProfile.mockImplementation(async () => {
      await held;
      return PROFILE_BUNDLE;
    });
    suggestion.generateProviderText.mockResolvedValue({
      object: PROPOSAL,
      text: "",
      usage: null,
    });
    const client = await connectedClient();
    const args = { repositoryId: id, idempotencyKey: KEY_ONE };

    const first = client.callTool({ name: "repositories.suggest", arguments: args });
    // The call is in flight once the service has reached the provider read.
    await vi.waitFor(() => expect(suggestion.loadProfile).toHaveBeenCalledTimes(1));
    const second = client.callTool({ name: "repositories.suggest", arguments: args });
    // The first call writes no audit row until it finishes, so the first row to
    // appear is the second call being refused the lease. Waiting for it is what
    // makes this a JOIN rather than an idempotent replay of a finished call.
    await vi.waitFor(async () => {
      const rows = await db.select().from(mcpAuditEvents);
      expect(rows.some((row) => row.outcome === "rejected")).toBe(true);
    });
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).not.toBe(true);
    expect(dataOf(secondResult).proposal).toEqual(dataOf(firstResult).proposal);
    // One provider call and one history row: the join never buys a second one.
    expect(suggestion.generateProviderText).toHaveBeenCalledTimes(1);
    expect(await db.select().from(repositorySuggestions)).toHaveLength(1);
  });

  it("still refuses the same key once the work it named is no longer in flight", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();

    // The first call fails fast (no provider configured) and the lease is
    // settled by the time the second arrives, so the ordinary idempotent replay
    // answers rather than a join: by then the answer is either stored or gone.
    const first = await client.callTool({
      name: "repositories.suggest",
      arguments: { repositoryId: id, idempotencyKey: KEY_ONE },
    });
    const second = await client.callTool({
      name: "repositories.suggest",
      arguments: { repositoryId: id, idempotencyKey: KEY_ONE },
    });

    expect(errorOf(first)).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(errorOf(second).code).not.toBe("CONFLICT");
  });

  it("answers NOT_FOUND for a repository that does not exist", async () => {
    const client = await connectedClient();

    const result = await client.callTool({
      name: "repositories.suggest",
      arguments: {
        repositoryId: 4242,
        idempotencyKey: KEY_THREE,
      },
    });

    expect(errorOf(result)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a member and a client-credentials token before it spends anything", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const member = await connectedClient({ role: "member" });
    const service = await connectedClient({
      kind: "service",
      role: "service",
      userId: null,
      subject: "client-execute",
    });
    const args = {
      repositoryId: id,
      idempotencyKey: KEY_ONE,
    };

    expect(
      errorOf(await member.callTool({ name: "repositories.suggest", arguments: args })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      errorOf(
        await service.callTool({
          name: "repositories.suggest",
          arguments: { ...args, idempotencyKey: KEY_TWO },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(repositorySuggestions)).toEqual([]);
  });
});

describe("the audit trail", () => {
  it("records the repository a write touched, never the reason as text", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient();

    await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: id,
        provider: "github",
        path: "acme/api",
        rules: "Ask before renaming a table",
        reason: "MARKER-4b7e12 the team asked for it",
        idempotencyKey: KEY_ONE,
      },
    });

    const rows = await db.select().from(mcpAuditEvents);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.toolName === "repositories.upsert")).toBe(true);
    expect(rows.some((row) => row.outcome === "success")).toBe(true);
    expect(rows.some((row) => row.targetRefs.includes("github:acme/api"))).toBe(true);
    // The reason belongs on the profile version, where the History tab reads
    // it. The audit row records that a write happened and what it touched, and
    // keeping operator prose out of a table retained for a year is deliberate.
    expect(JSON.stringify(rows)).not.toContain("MARKER-4b7e12");
    const versions = dataOf(
      await client.callTool({
        name: "repositories.list_versions",
        arguments: { repositoryId: id },
      }),
    ).versions as Array<{ reason: string }>;
    expect(versions[0]?.reason).toBe("MARKER-4b7e12 the team asked for it");
  });
});

describe("the scopes this surface asks for", () => {
  // The whole point of S8: consent to author workflows is not consent to decide
  // which repositories the platform may enter.
  it("refuses a token holding only the authoring scope on every catalog write", async () => {
    const id = await seedRepository({ path: "acme/api", enabled: true });
    const client = await connectedClient({ scopes: AUTHORING_ONLY });
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      {
        name: "repositories.upsert",
        arguments: {
          repositoryId: id,
          provider: "github",
          path: "acme/api",
          rules: "Ask first",
          reason: "wrong scope",
          idempotencyKey: KEY_ONE,
        },
      },
      {
        name: "repositories.set_enabled",
        arguments: { repositoryId: id, enabled: false, idempotencyKey: KEY_TWO },
      },
      {
        name: "repositories.activate",
        arguments: {
          previewDigest: `sha256:${"0".repeat(64)}`,
          reason: "wrong scope",
          idempotencyKey: KEY_THREE,
        },
      },
      {
        name: "repositories.import",
        arguments: {
          repositoryKeys: ["github:acme/docs"],
          idempotencyKey: "44444444-4444-4444-8444-444444444444",
        },
      },
      {
        name: "repositories.suggest",
        arguments: {
          repositoryId: id,
          idempotencyKey: "55555555-5555-4555-8555-555555555555",
        },
      },
      // The two previews are gated behind the write scope as well, because each
      // exists to feed one of the writes above.
      { name: "repositories.activate_preview", arguments: {} },
      { name: "repositories.import_preview", arguments: {} },
    ];

    for (const call of calls) {
      expect(
        errorOf(await client.callTool(call)),
        `${call.name} accepted a workflows:write token`,
      ).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    }
    // And the plain reads are untouched by the split: the same token still sees
    // the catalog, because knowing what exists is not a configuration change.
    expect(
      (await client.callTool({ name: "repositories.list", arguments: {} })).isError,
    ).not.toBe(true);
  });

  it("keeps the suggestion deadline pinned to the bound it is derived from", async () => {
    const { REPOSITORY_PROFILE_DEADLINE_MS: adapterDeadline } = await import(
      "../../adapters/vcs/repository-profile-source.js"
    );

    // Restated in the tool because the app tier may not import the adapter tier;
    // this is the assertion that keeps the restatement true.
    expect(TOOL_PROFILE_DEADLINE_MS).toBe(adapterDeadline);
    expect(TOOL_PROFILE_DEADLINE_MS + REPOSITORY_SUGGESTION_TIMEOUT_MS).toBeLessThanOrEqual(
      MCP_MAX_TOOL_TIMEOUT_MS,
    );
  });

  it("waits out a joined suggestion on the suggestion's deadline, not the read path's", () => {
    const { settings } = depsFor(db, () => NOW);

    // What `executeMcpMutation` computes for the call that STARTS the work,
    // from the `minimumTimeoutMs` the suggest tool hands it.
    const suggestionDeadline = mcpToolTimeoutMs(
      settings,
      TOOL_PROFILE_DEADLINE_MS + REPOSITORY_SUGGESTION_TIMEOUT_MS,
    );

    expect(repositorySuggestionDeadlineMs(settings)).toBe(suggestionDeadline);

    // And the bound the join would have inherited had it trusted the read
    // path's signal: the deployment's own tool timeout, which is shorter, so
    // the second caller would have been told TIMEOUT while the work it asked
    // about was still inside its own budget.
    expect(mcpToolTimeoutMs(settings)).toBeLessThan(suggestionDeadline);
  });
});
