// memory.list, asked for one subject, on a deployment that holds far more than
// one listing: the MCP half of what the repository page shows.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
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
  },
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

import type { Db } from "../../db/client.js";
import { upsertMemoryDocument } from "../../db/repositories/memory.js";
import { agentMemoryDocuments, organization, user } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import { registerMemoryTools } from "./memory.js";

const ORG_ID = "org-memory";
const NOW = new Date("2026-09-23T10:00:00.000Z");
const REPO = "repo:github:acme/web";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  await db.insert(organization).values({ id: ORG_ID, name: "Memory", slug: "memory" });
  await db.insert(user).values({
    id: "user-memory",
    name: "Ada Lovelace",
    email: "ada@example.com",
    emailVerified: true,
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "memory-test", version: "0.1.0" });
  registerMemoryTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({ organizationId: ORG_ID, role: "member", scopes: new Set(["mcp:read"]) }),
    }),
  );
  const client = new Client({ name: "memory-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** A repository's two documents, older than 120 of other subjects written since. */
async function busyDeployment(): Promise<void> {
  for (const docPath of ["facts", "lessons"]) {
    await upsertMemoryDocument(db, {
      subjectKey: REPO,
      docPath,
      ticketKey: null,
      content: `${docPath} of acme/web`,
      sourceRunId: "run_old",
    });
  }
  await db
    .update(agentMemoryDocuments)
    .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
    .where(eq(agentMemoryDocuments.subjectKey, REPO));
  for (let index = 0; index < 120; index += 1) {
    await upsertMemoryDocument(db, {
      subjectKey: `ticket:jira:AIW-${index}`,
      docPath: `ai-workflow/memory/AIW-${index}.md`,
      ticketKey: `AIW-${index}`,
      content: "notes",
      sourceRunId: `run_${index}`,
    });
  }
}

type Listing = {
  documents: Array<{ subjectKey: string; docPath: string }>;
  complete: boolean;
};

function listingOf(result: Awaited<ReturnType<Client["callTool"]>>): Listing {
  return (result.structuredContent as { data: Listing }).data;
}

describe("memory.list", () => {
  it("lists one subject's documents whatever their age when asked for that subject", async () => {
    await busyDeployment();
    const client = await connectedClient();

    const everything = listingOf(await client.callTool({ name: "memory.list", arguments: {} }));
    // The premise: the newest page of everything does not reach them.
    expect(everything.complete).toBe(false);
    expect(everything.documents.some((document) => document.subjectKey === REPO)).toBe(false);

    const result = await client.callTool({
      name: "memory.list",
      arguments: { subjectKey: REPO },
    });

    expect(result.isError).not.toBe(true);
    expect(listingOf(result)).toMatchObject({
      complete: true,
      documents: [
        { subjectKey: REPO, docPath: "facts" },
        { subjectKey: REPO, docPath: "lessons" },
      ],
    });
  });
});
