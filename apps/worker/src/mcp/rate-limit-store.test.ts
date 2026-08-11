import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { mcpRateLimitWindows, organization } from "../db/schema.js";
import type { McpActorContext, McpToolName } from "./contracts.js";
import { consumeMcpRateLimit } from "./rate-limit-store.js";

let db: Db;
const now = new Date("2026-08-11T12:34:30.000Z");

function actor(overrides: Partial<McpActorContext> = {}): McpActorContext {
  return {
    kind: "user",
    subject: "user:rate",
    userId: "user-rate",
    clientId: "client-rate",
    organizationId: "org-rate-a",
    organizationSlug: "rate-a",
    role: "admin",
    scopes: new Set(["mcp:read", "runs:dispatch"]),
    audience: "https://worker.example.com/mcp",
    ...overrides,
  };
}

async function consume(
  actorContext = actor(),
  toolName: McpToolName = "runs.get",
  limit = 2,
  at = now,
) {
  return consumeMcpRateLimit({ db, actor: actorContext, toolName, limit, now: at });
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values([
    { id: "org-rate-a", name: "Rate A", slug: "rate-a" },
    { id: "org-rate-b", name: "Rate B", slug: "rate-b" },
  ]);
});

describe("MCP database rate limiting", () => {
  it("returns remaining budget and a safe retryAfterMs when the limit is exceeded", async () => {
    await expect(consume()).resolves.toEqual({ remaining: 1, retryAfterMs: 30_000 });
    await expect(consume()).resolves.toEqual({ remaining: 0, retryAfterMs: 30_000 });
    await expect(consume()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it("starts a fresh budget at the exact minute boundary", async () => {
    await consume(actor(), "runs.get", 1, new Date("2026-08-11T12:34:59.999Z"));
    await expect(
      consume(actor(), "runs.get", 1, new Date("2026-08-11T12:35:00.000Z")),
    ).resolves.toEqual({ remaining: 0, retryAfterMs: 60_000 });
  });

  it("separates counters by tenant, actor, client, and tool", async () => {
    await consume();
    const variants: Array<[McpActorContext, McpToolName]> = [
      [actor({ organizationId: "org-rate-b", organizationSlug: "rate-b" }), "runs.get"],
      [actor({ subject: "user:rate-2" }), "runs.get"],
      [actor({ clientId: "client-rate-2" }), "runs.get"],
      [actor(), "runs.trace"],
    ];

    for (const [variantActor, toolName] of variants) {
      await expect(consume(variantActor, toolName)).resolves.toMatchObject({ remaining: 1 });
    }
  });

  it("increments atomically under concurrent read and mutation budgets", async () => {
    const readDecisions = await Promise.all(
      Array.from({ length: 12 }, () => consume(actor(), "runs.get", 12)),
    );
    const mutationDecisions = await Promise.all(
      Array.from({ length: 3 }, () => consume(actor(), "workflows.dispatch", 3)),
    );

    expect(readDecisions.map((decision) => decision.remaining).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(mutationDecisions.map((decision) => decision.remaining).sort()).toEqual([0, 1, 2]);
    const rows = await db
      .select()
      .from(mcpRateLimitWindows)
      .where(eq(mcpRateLimitWindows.organizationId, "org-rate-a"));
    expect(rows).toMatchObject([
      { toolName: "runs.get", requestCount: 12 },
      { toolName: "workflows.dispatch", requestCount: 3 },
    ]);
  });
});
