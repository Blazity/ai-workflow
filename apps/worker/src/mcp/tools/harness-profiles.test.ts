import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { harnessProfiles, organization } from "../../db/schema.js";
import { forkHarnessProfileOnDb } from "../../harness-profiles/draft-authoring.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { registerHarnessProfileTools } from "./harness-profiles.js";

const ORG_ID = "org-execute";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({ id: ORG_ID, name: "Execute", slug: "execute" });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "harness-profiles-test", version: "0.1.0" });
  registerHarnessProfileTools(
    server,
    depsFor(db, () => new Date("2026-09-25T00:00:00.000Z"), {
      actor: actorFor({ scopes: new Set(["mcp:read"]) }),
    }),
  );
  const client = new Client({ name: "harness-profiles-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type Profile = {
  profileId: string;
  slug: string;
  name: string;
  system: boolean;
  provider: string;
  model: string;
  publishedVersion: number | null;
  pin: { profileId: string; version: number } | null;
};

async function listed(client: Client): Promise<Profile[]> {
  const result = await client.callTool({ name: "harness_profiles.list", arguments: {} });
  expect(result.isError).not.toBe(true);
  return (result.structuredContent as { data: { profiles: Profile[] } }).data.profiles;
}

describe("harness_profiles.list", () => {
  // Red when: a graph authored over MCP has no way to learn which profile to
  // pin, and every agent block runs the built-in default.
  it("names each profile's provider and model, and the pin an agent block takes", async () => {
    const client = await connectedClient();

    const profiles = await listed(client);

    const system = profiles.filter((profile) => profile.system);
    expect(system.length).toBeGreaterThan(0);
    for (const profile of system) {
      expect(profile.model.length).toBeGreaterThan(0);
      expect(["claude", "codex"]).toContain(profile.provider);
      // Exactly the shape configuration.harnessProfile validates.
      expect(profile.pin).toEqual({
        profileId: profile.profileId,
        version: profile.publishedVersion,
      });
    }
  });

  it("lists a profile nobody published yet with no pin, rather than one that would not run", async () => {
    const client = await connectedClient();
    const source = (await listed(client)).find((profile) => profile.system);
    const [row] = await db
      .select({ draftRevision: harnessProfiles.draftRevision })
      .from(harnessProfiles)
      .where(eq(harnessProfiles.id, source!.profileId));
    const fork = await forkHarnessProfileOnDb(db, {
      profileId: source!.profileId,
      slug: "team-draft",
      expectedRevision: row!.draftRevision,
      actor: { organizationId: ORG_ID, role: "admin", id: "admin" },
    });

    const draft = (await listed(client)).find((profile) => profile.profileId === fork.id);

    expect(draft).toMatchObject({
      slug: "team-draft",
      system: false,
      publishedVersion: null,
      pin: null,
    });
  });
});
