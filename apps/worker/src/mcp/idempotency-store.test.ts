import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { mcpIdempotencyKeys, organization } from "../db/schema.js";
import type { IdempotencyInput } from "./contracts.js";
import {
  beginMcpMutation,
  completeMcpMutation,
  failMcpMutation,
} from "./idempotency-store.js";

let db: Db;
const now = new Date("2026-08-11T12:00:00.000Z");
const expiresAt = new Date("2026-08-12T12:00:00.000Z");

function input(overrides: Partial<IdempotencyInput> = {}): IdempotencyInput {
  return {
    organizationId: "org-idem-a",
    actorSubject: "user:idem",
    clientId: "client-idem",
    toolName: "workflows.dispatch",
    idempotencyKey: "key-idem-1",
    payloadHash: "payload-hash-a",
    now,
    expiresAt,
    ...overrides,
  };
}

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values([
    { id: "org-idem-a", name: "Idem A", slug: "idem-a" },
    { id: "org-idem-b", name: "Idem B", slug: "idem-b" },
  ]);
});

describe("MCP mutation idempotency", () => {
  it("normalizes begin database failures without exposing driver details", async () => {
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "insert") {
          return () => {
            throw new Error("raw begin database detail");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(beginMcpMutation(failingDb, input())).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });
  });

  it("normalizes completion database failures without exposing driver details", async () => {
    const decision = await beginMcpMutation(db, input());
    if (decision.kind !== "execute") throw new Error("expected execution lease");
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return () => {
            throw new Error("raw completion database detail");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(
      completeMcpMutation(failingDb, decision.leaseId, { runId: "run-17" }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });
  });

  it("normalizes failure persistence errors without exposing driver details", async () => {
    const decision = await beginMcpMutation(db, input());
    if (decision.kind !== "execute") throw new Error("expected execution lease");
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update") {
          return () => {
            throw new Error("raw failure database detail");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(
      failMcpMutation(failingDb, decision.leaseId, "INTERNAL_ERROR"),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });
  });

  it("executes once and replays the completed response for the same payload", async () => {
    const first = await beginMcpMutation<{ runId: string }>(db, input());
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await completeMcpMutation(db, first.leaseId, { runId: "run-17" });

    await expect(beginMcpMutation<{ runId: string }>(db, input())).resolves.toEqual({
      kind: "replay",
      response: { runId: "run-17" },
    });
  });

  it("rejects reuse with a different payload hash", async () => {
    await beginMcpMutation(db, input());

    await expect(
      beginMcpMutation(db, input({ payloadHash: "payload-hash-b" })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
  });

  it("has exactly one concurrent insert winner", async () => {
    const settled = await Promise.allSettled([
      beginMcpMutation(db, input()),
      beginMcpMutation(db, input()),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT", retryable: true },
    });
    const rows = await db.select().from(mcpIdempotencyKeys);
    expect(rows).toHaveLength(1);
  });

  it("replays a failed terminal outcome without executing again", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await failMcpMutation(db, first.leaseId, "DEPENDENCY_UNAVAILABLE");

    await expect(beginMcpMutation(db, input())).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
    });
  });

  it("reclaims a key at the exact 24-hour expiry boundary", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await completeMcpMutation(db, first.leaseId, { runId: "old-run" });

    const reclaimed = await beginMcpMutation(
      db,
      input({
        payloadHash: "payload-hash-b",
        now: expiresAt,
        expiresAt: new Date("2026-08-13T12:00:00.000Z"),
      }),
    );

    expect(reclaimed.kind).toBe("execute");
    const rows = await db
      .select()
      .from(mcpIdempotencyKeys)
      .where(eq(mcpIdempotencyKeys.organizationId, "org-idem-a"));
    expect(rows).toMatchObject([
      {
        payloadHash: "payload-hash-b",
        state: "started",
        expiresAt: new Date("2026-08-13T12:00:00.000Z"),
      },
    ]);
  });

  it("scopes the same key by tenant, actor, client, and tool", async () => {
    const variants = [
      input(),
      input({ organizationId: "org-idem-b" }),
      input({ actorSubject: "service:idem" }),
      input({ clientId: "client-idem-2" }),
      input({ toolName: "workflows.dispatch_preflight" }),
    ];

    const decisions = await Promise.all(variants.map((variant) => beginMcpMutation(db, variant)));
    expect(decisions.every((decision) => decision.kind === "execute")).toBe(true);
  });
});
