/**
 * Three repository-catalog MCP rows the QA matrix found unpinned (epic AIW-338).
 *
 * `repositories.test.ts` next door covers list, get, list_versions, upsert,
 * set_enabled, activate_preview, activate, import and suggest. These are the
 * three it does not:
 *
 *   M14 `repositories.import_preview` had no test at all, on either surface.
 *   M17 the tool advertises a looser `path` than the handler enforces.
 *   M12 a client registered before the configuration scopes existed still
 *       cannot reach the configuration tools, however it re-authorizes.
 *
 * M12 is the one that needs the real actor resolution rather than a fabricated
 * actor: what caps a token is the stored client row, and every test in the
 * sibling suite hands the tools an actor that was never resolved from one. So
 * this file drives `resolveMcpActor` against a seeded `oauth_client` and feeds
 * the actor it produces to the same tools.
 *
 * `vi.mock` is hoisted per file and cannot be shared; the harness itself
 * (`actorFor`, `depsFor`) is imported from `test-support/mcp.ts`, as next door.
 */
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
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    DASHBOARD_ORG_SLUG: "execute",
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MAX_CONCURRENT_AGENTS: 3,
  },
  getConfiguredVcsProviders: () => [],
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../services/repository-discovery/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/repository-discovery/index.js")>();
  return { ...actual, listCachedRepositoryDirectory: async () => state.directory };
});

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { member, oauthClient, organization, user } from "../../db/schema.js";
import { upsertRepositoryProfile } from "../../db/repositories/repository-catalog.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { resolveMcpActor } from "../../services/mcp/actor-resolution.js";
import { settingsSnapshotFromEnvironment } from "../../services/settings/snapshot.js";
import { MCP_TOOL_CATALOG } from "../tool-catalog.js";
import { registerRepositoryCatalogTools } from "./repositories.js";

const ORG_ID = "org-execute";
const NOW = new Date("2026-09-13T09:00:00.000Z");
const KEY_ONE = "11111111-1111-4111-8111-111111111111";

const WRITE: ReadonlySet<McpScope> = new Set(["mcp:read", "repositories:write"]);

let db: Db;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.directory = { repositories: [], providers: [] };
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
});

function option(repoPath: string, provider: "github" | "gitlab" = "github") {
  const [owner, name] = repoPath.split("/");
  return {
    provider,
    repoPath,
    name: name ?? repoPath,
    owner: owner ?? "",
    defaultBranch: "main",
    private: true,
    archived: false,
  };
}

async function connectedClient(
  actorOverrides: Partial<McpActorContext> = {},
): Promise<Client> {
  return connectedClientForActor(
    actorFor({ organizationId: ORG_ID, role: "owner", scopes: WRITE, ...actorOverrides }),
  );
}

/** The same harness, but taking a whole actor: M12 needs the one
 *  `resolveMcpActor` produced rather than one this file wrote. */
async function connectedClientForActor(actor: McpActorContext): Promise<Client> {
  const server = new McpServer({ name: "repositories-matrix", version: "0.1.0" });
  registerRepositoryCatalogTools(server, depsFor(db, () => NOW, { actor }));
  const client = new Client({ name: "repositories-matrix-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );
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

describe("repositories.import_preview", () => {
  it("M14: lists what the installation exposes, marks what the catalog holds, and carries a status per provider", async () => {
    await upsertRepositoryProfile(db, {
      provider: "github",
      // Stored in the provider's own casing; the key it is matched on is cased
      // down, which is what makes a re-import of the same repository a no-op.
      path: "Acme/Api",
      description: "",
      rules: "",
      relationships: [],
      scriptGroups: null,
      gateGroups: null,
      actorId: "user-execute",
      actorLabel: "Ada",
      reason: "seeded",
    });
    state.directory = {
      repositories: [option("acme/api"), option("acme/web"), option("acme/ops", "gitlab")],
      providers: [
        { provider: "github", status: "ready" },
        // A provider whose listing failed is a DIFFERENT answer from a provider
        // nobody connected, and neither empties the list. The tool description
        // says to read `providers` before concluding a repository is gone, so
        // the field has to survive the envelope.
        { provider: "gitlab", status: "error" },
      ],
    };
    const client = await connectedClient();

    const data = dataOf(
      await client.callTool({ name: "repositories.import_preview", arguments: {} }),
    );

    expect(
      (data.repositories as Array<{ key: string; path: string; inCatalog: boolean }>).map(
        (row) => [row.key, row.path, row.inCatalog],
      ),
    ).toEqual([
      ["github:acme/api", "acme/api", true],
      ["github:acme/web", "acme/web", false],
      ["gitlab:acme/ops", "acme/ops", false],
    ]);
    expect(data.providers).toEqual([
      { provider: "github", status: "ready" },
      { provider: "gitlab", status: "error" },
    ]);
  });

  it("M14: keeps the write's scope and role list, unlike the HTTP route it mirrors", async () => {
    state.directory = {
      repositories: [option("acme/api")],
      providers: [{ provider: "github", status: "ready" }],
    };

    // A member with a read scope is refused, even though the call changes
    // nothing. Its annotations still say read-only; what it does NOT take from
    // the read family is the scope and the role list. Deliberate, and stated at
    // `DEPLOYMENT_PREVIEW_POLICY` in mcp/policy.ts: a read that exists to feed a
    // privileged action is gated behind that action, and this one lists every
    // repository the installation exposes.
    const readOnly = await connectedClient({
      role: "member",
      scopes: new Set<McpScope>(["mcp:read"]),
    });
    expect(
      errorOf(
        await readOnly.callTool({ name: "repositories.import_preview", arguments: {} }),
      ),
    ).toMatchObject({ code: "INSUFFICIENT_SCOPE" });

    // The right scope and the wrong role is the other half of the same gate.
    const memberWithScope = await connectedClient({ role: "member", scopes: WRITE });
    expect(
      errorOf(
        await memberWithScope.callTool({
          name: "repositories.import_preview",
          arguments: {},
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });

    // The same read over HTTP is open to every dashboard role
    // (routes/api/v1/repository-catalog/import-preview.post.ts, "Open to every
    // dashboard role, like the rest of the catalog's reads"). The divergence is
    // the row: an operator scripting against one surface cannot assume the
    // other answers the same caller.
    const admin = await connectedClient();
    const allowed = await admin.callTool({
      name: "repositories.import_preview",
      arguments: {},
    });
    expect(allowed.isError).not.toBe(true);
    expect(dataOf(allowed).repositories).toHaveLength(1);
  });
});

describe("repositories.upsert, advertised schema versus enforced schema", () => {
  it("M17: advertises a plain string path and refuses anything that is not owner/name", async () => {
    // The advertised contract: a length-bounded string, no shape at all. A
    // client generating arguments from the published `inputSchema` has no way
    // to know "acme" will be refused.
    const advertised = MCP_TOOL_CATALOG["repositories.upsert"].inputSchema;
    expect(advertised.safeParse({
      repositoryId: 0,
      provider: "github",
      path: "acme",
      reason: "a path with no owner",
      idempotencyKey: KEY_ONE,
    }).success).toBe(true);

    const client = await connectedClient();
    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: 0,
        provider: "github",
        path: "acme",
        reason: "a path with no owner",
        idempotencyKey: KEY_ONE,
      },
    });

    // The handler re-parses through the HTTP contract, which carries the
    // `owner/name` regex, so the refusal is real and names the field. Pinned as
    // it behaves: the two schemas differ ON PURPOSE (the advertised one has to
    // stay a plain JSON Schema a client can render), and what must not change
    // silently is that the difference is a clean VALIDATION_FAILED rather than
    // a row created at a path nothing can resolve.
    expect(errorOf(result)).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(errorOf(result).message).toContain("path");
  });
});

describe("a client registered before the configuration scopes existed", () => {
  it("M12: cannot reach repositories.upsert however the token was issued", async () => {
    await db.insert(user).values({
      id: "user-old",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "member-old",
      organizationId: ORG_ID,
      userId: "user-old",
      role: "owner",
    });
    // The stored registration, as it was written before `repositories:write`
    // and `settings:write` were advertised. Dynamic registration writes every
    // scope the server advertised AT THE TIME into this column, so an old row
    // simply does not name them.
    await db.insert(oauthClient).values({
      id: "client-row-old",
      clientId: "client-old",
      referenceId: ORG_ID,
      redirectUris: ["https://client.example.com/callback"],
      scopes: ["mcp:read", "runs:dispatch", "workflows:write"],
    });

    // The token asks for the new scope. This is what "re-authorize and try
    // again" produces, because an access token can carry whatever the
    // authorization server minted.
    const actor = await resolveMcpActor(
      {
        clientId: "client-old",
        organizationId: ORG_ID,
        userId: "user-old",
        serviceRole: false,
        issuedScope: "mcp:read repositories:write",
        audience: "https://worker.example.com/mcp",
      },
      settingsSnapshotFromEnvironment(),
    );

    // The intersection with the stored registration is the ceiling, so the
    // scope the token claims is simply not in the actor's set. There is no
    // error at this point: the client looks fine and is short one capability.
    expect([...actor.scopes].sort()).toEqual(["mcp:read"]);
    expect(actor.role).toBe("owner");

    const client = await connectedClientForActor(actor);
    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: 0,
        provider: "github",
        path: "acme/api",
        reason: "an owner who cannot",
        idempotencyKey: KEY_ONE,
      },
    });

    // Owner role, person behind the token, correct organization, and still
    // refused. The fix is a new client registration or an edit to the stored
    // row's scopes, not another consent screen: the consent screen can only
    // offer what the registration already allows.
    expect(errorOf(result)).toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      message: "Insufficient scope",
    });
    expect(dataOf(await client.callTool({ name: "repositories.list", arguments: {} })))
      .toMatchObject({ repositories: [] });
  });

  it("M12: the same registration with the scope stored answers the call", async () => {
    await db.insert(user).values({
      id: "user-new",
      name: "Bob",
      email: "bob@example.com",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "member-new",
      organizationId: ORG_ID,
      userId: "user-new",
      role: "owner",
    });
    await db.insert(oauthClient).values({
      id: "client-row-new",
      clientId: "client-new",
      referenceId: ORG_ID,
      redirectUris: ["https://client.example.com/callback"],
      scopes: ["mcp:read", "repositories:write"],
    });

    const actor = await resolveMcpActor(
      {
        clientId: "client-new",
        organizationId: ORG_ID,
        userId: "user-new",
        serviceRole: false,
        issuedScope: "mcp:read repositories:write",
        audience: "https://worker.example.com/mcp",
      },
      settingsSnapshotFromEnvironment(),
    );
    expect([...actor.scopes].sort()).toEqual(["mcp:read", "repositories:write"]);

    const client = await connectedClientForActor(actor);
    const result = await client.callTool({
      name: "repositories.upsert",
      arguments: {
        repositoryId: 0,
        provider: "github",
        path: "acme/api",
        reason: "a registration that names the scope",
        idempotencyKey: KEY_ONE,
      },
    });

    // So the refusal above is about the registration and nothing else: same
    // role, same organization, same token request, one stored row different.
    expect(result.isError).not.toBe(true);
    expect(dataOf(result).repository).toMatchObject({ path: "acme/api" });
  });
});
