// The MCP half of a skill edit reaching runs: a deployment skill a profile
// pins is rewritten by a redeploy, and only refresh plus publish move the
// profile onto the new bytes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessProfileDraftManifestV1 } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/harness";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    DASHBOARD_ORG_SLUG: "profiles",
  },
  // A deployment skill never needs a provider; reaching for one fails loudly.
  getVcsProviderConfig: () => {
    throw new Error("No VCS provider is configured");
  },
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

import type { Db } from "../../db/client.js";
import { member, organization, user } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  createHarnessProfileDraft,
  discoverDeploymentSkills,
  importDeploymentSkills,
} from "../../services/harness/index.js";
import type { McpActorContext } from "../contracts.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { registerProfileTools } from "./profiles.js";

const ORG_ID = "org-profiles";
const ADMIN_ID = "user-admin";
const NOW = new Date("2026-09-25T10:00:00.000Z");

let db: Db;
let workingDirectory: string;

function draft(): HarnessProfileDraftManifestV1 {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...value
  } = structuredClone(BUILTIN_HARNESS_PROFILE_MANIFESTS[BUILTIN_HARNESS_PROFILE_IDS.codex]);
  return value;
}

function writeSkill(description: string): void {
  const directory = join(workingDirectory, "skills", "review-rules");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: review-rules\ndescription: ${description}\n---\n\n# review-rules\n`,
  );
}

/** A profile whose draft pins the deployment skill as it is shipped now. */
async function profilePinningTheSkill(): Promise<{ profileId: string; artifactHash: string }> {
  const discovered = await discoverDeploymentSkills();
  const [artifact] = await importDeploymentSkills({
    organizationId: ORG_ID,
    actorId: ADMIN_ID,
    skills: [discovered.skills[0]!],
  });
  const withSkill = draft();
  withSkill.skills = [{ artifactHash: artifact!.artifactHash, name: "review-rules" }];
  const created = await createHarnessProfileDraft({
    slug: "review-profile",
    draft: withSkill,
    actor: { organizationId: ORG_ID, role: "admin", id: ADMIN_ID },
  });
  return { profileId: created.id, artifactHash: artifact!.artifactHash };
}

const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: ORG_ID, name: "Profiles", slug: "profiles" });
  await db.insert(user).values({
    id: ADMIN_ID,
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
  });
  await db
    .insert(member)
    .values({ id: "member-admin", organizationId: ORG_ID, userId: ADMIN_ID, role: "admin" });
  // The reader resolves `skills/` against the working directory, where the
  // build drops the copy each function ships with.
  workingDirectory = mkdtempSync(join(tmpdir(), "mcp-profiles-"));
  vi.spyOn(process, "cwd").mockReturnValue(workingDirectory);
  writeSkill("Client-specific review rules.");
});

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
  rmSync(workingDirectory, { force: true, recursive: true });
});

async function connectedClient(
  actor: McpActorContext = actorFor({
    organizationId: ORG_ID,
    userId: ADMIN_ID,
    role: "admin",
    scopes: new Set(["mcp:read", "workflows:write"]),
  }),
): Promise<Client> {
  const server = new McpServer({ name: "profiles-test", version: "0.1.0" });
  registerProfileTools(server, depsFor(db, () => NOW, { actor }));
  const client = new Client({ name: "profiles-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as { data: T; error?: never } & Record<string, unknown>;
}

function errorOf(result: unknown): { code: string } {
  const [first] = (result as { content: Array<{ text: string }> }).content;
  return (JSON.parse(first!.text) as { error: { code: string } }).error;
}

describe("profiles tools", () => {
  it("moves a pinned deployment skill onto the redeployed bytes and publishes it", async () => {
    const { profileId, artifactHash } = await profilePinningTheSkill();
    const client = await connectedClient();

    const listed = await call<{
      profiles: Array<{ profileId: string; draftRevision: number; draftSkills: unknown[] }>;
    }>(client, "profiles.list", {});
    const profile = listed.data.profiles.find((candidate) => candidate.profileId === profileId);
    expect(profile?.draftSkills).toEqual([{ name: "review-rules", artifactHash }]);

    // The redeploy: same skill path, new bytes.
    writeSkill("Rules the client rewrote.");
    const refreshed = await call<{ artifactHash: string; changed: boolean; draftRevision: number }>(
      client,
      "profiles.refresh_skill",
      {
        profileId,
        expectedRevision: profile!.draftRevision,
        artifactHash,
        idempotencyKey: randomUUID(),
      },
    );
    expect(refreshed.data.changed).toBe(true);
    expect(refreshed.data.artifactHash).not.toBe(artifactHash);

    const published = await call<{ version: number; changed: boolean; skills: unknown[] }>(
      client,
      "profiles.publish",
      {
        profileId,
        expectedRevision: refreshed.data.draftRevision,
        idempotencyKey: randomUUID(),
      },
    );
    expect(published.data).toMatchObject({
      version: 1,
      changed: true,
      skills: [{ name: "review-rules", artifactHash: refreshed.data.artifactHash }],
    });

    const detail = await call<{ publishedVersion: number; publishedSkills: unknown[] }>(
      client,
      "profiles.get",
      { profileId },
    );
    expect(detail.data).toMatchObject({
      publishedVersion: 1,
      publishedSkills: [{ name: "review-rules", artifactHash: refreshed.data.artifactHash }],
    });
  });

  it("publishes nothing when the draft already is the published version", async () => {
    const { profileId } = await profilePinningTheSkill();
    const client = await connectedClient();
    const first = await call<{ version: number }>(client, "profiles.publish", {
      profileId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    const again = await call<{ version: number; changed: boolean }>(client, "profiles.publish", {
      profileId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(again.data).toMatchObject({ version: first.data.version, changed: false });
  });

  it("refuses a stale revision with CONFLICT and leaves the pin where it was", async () => {
    const { profileId, artifactHash } = await profilePinningTheSkill();
    const client = await connectedClient();
    writeSkill("Rules the client rewrote.");

    const stale = await client.callTool({
      name: "profiles.refresh_skill",
      arguments: { profileId, expectedRevision: 7, artifactHash, idempotencyKey: randomUUID() },
    });

    expect(stale.isError).toBe(true);
    expect(errorOf(stale).code).toBe("CONFLICT");
    const detail = await call<{ draftSkills: unknown[] }>(client, "profiles.get", { profileId });
    expect(detail.data.draftSkills).toEqual([{ name: "review-rules", artifactHash }]);
  });

  it("keeps the writes to the roles that manage profiles", async () => {
    const { profileId } = await profilePinningTheSkill();
    const client = await connectedClient(
      actorFor({
        organizationId: ORG_ID,
        userId: ADMIN_ID,
        role: "member",
        scopes: new Set(["mcp:read", "workflows:write"]),
      }),
    );

    const refused = await client.callTool({
      name: "profiles.publish",
      arguments: { profileId, expectedRevision: 1, idempotencyKey: randomUUID() },
    });

    expect(refused.isError).toBe(true);
    expect(errorOf(refused).code).toBe("FORBIDDEN");
  });
});
