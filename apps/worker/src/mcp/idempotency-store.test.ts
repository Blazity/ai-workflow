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
  releaseMcpMutation,
  sweepMcpIdempotencyKeys,
} from "./idempotency-store.js";

let db: Db;
const now = new Date("2026-08-11T12:00:00.000Z");
// What begin receives is a lease deadline, in minutes, and what a terminal row
// carries is the lifetime of the answer, in hours. One column holds both, so a
// fixture that blurs them would hide the whole defect these tests cover.
const LEASE_MS = 5 * 60_000;
const RESPONSE_TTL_MS = 24 * 60 * 60 * 1_000;

function input(overrides: Partial<IdempotencyInput> = {}): IdempotencyInput {
  const startedAt = overrides.now ?? now;
  return {
    organizationId: "org-idem-a",
    actorSubject: "user:idem",
    clientId: "client-idem",
    toolName: "workflows.dispatch",
    idempotencyKey: "key-idem-1",
    payloadHash: "payload-hash-a",
    now: startedAt,
    expiresAt: new Date(startedAt.getTime() + LEASE_MS),
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
      completeMcpMutation(failingDb, decision.leaseId, { runId: "run-17" }, now),
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
      failMcpMutation(failingDb, decision.leaseId, "INTERNAL_ERROR", now),
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
    await completeMcpMutation(db, first.leaseId, { runId: "run-17" }, now);

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

  // A replayed outcome is a record of an attempt that is over, not a fresh
  // verdict, so calling it retryable would send an agent round a loop that
  // cannot end: nothing about repeating this key changes what is stored.
  it("replays a failed terminal outcome as final, pointing at the way out", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await failMcpMutation(db, first.leaseId, "DEPENDENCY_UNAVAILABLE", now);

    await expect(beginMcpMutation(db, input())).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: false,
      message: expect.stringContaining("runs.get"),
    });
    await expect(beginMcpMutation(db, input())).rejects.toMatchObject({
      message: expect.stringContaining("new idempotency key"),
    });
  });

  it("replays a stored timeout as final rather than as a lease to take over", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await failMcpMutation(db, first.leaseId, "TIMEOUT", now);

    await expect(
      beginMcpMutation(db, input({ now: new Date(now.getTime() + 60 * 60_000) })),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      message: expect.stringContaining("new idempotency key"),
    });
  });

  it("reclaims a key at the exact 24-hour expiry boundary", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await completeMcpMutation(db, first.leaseId, { runId: "old-run" }, now);

    const boundary = new Date(now.getTime() + RESPONSE_TTL_MS);
    const reclaimed = await beginMcpMutation(
      db,
      input({ payloadHash: "payload-hash-b", now: boundary }),
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
        expiresAt: new Date(boundary.getTime() + LEASE_MS),
      },
    ]);
  });

  // The lease deadline and the lifetime of the stored answer are two different
  // clocks sharing one column. A mutation that never reported back has to hand
  // its key over in minutes, while a mutation that did answer has to keep
  // answering for a day: reading the column without the row's state confuses
  // "this attempt is gone" with "this key is still spoken for".
  it("hands an abandoned lease to the next caller once its deadline passes", async () => {
    const abandoned = await beginMcpMutation(db, input());
    expect(abandoned.kind).toBe("execute");

    const takenOver = await beginMcpMutation(
      db,
      input({ now: new Date(now.getTime() + LEASE_MS) }),
    );

    expect(takenOver.kind).toBe("execute");
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toHaveLength(1);
  });

  // Taking an abandoned lease over is a retry of the request it names, so the
  // payload decides whether this is that request at all. Stamping a new payload
  // onto the row would let one key dispatch a second, different ticket, and
  // would leave the abandoned attempt able to write its answer into a row that
  // by then describes something else.
  it("refuses a different payload on a key whose lease was abandoned", async () => {
    await beginMcpMutation(db, input());

    await expect(
      beginMcpMutation(
        db,
        input({ payloadHash: "payload-hash-b", now: new Date(now.getTime() + LEASE_MS) }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });

    const rows = await db.select().from(mcpIdempotencyKeys);
    expect(rows).toMatchObject([{ payloadHash: "payload-hash-a", state: "started" }]);
  });

  it("refuses a duplicate while the lease is still live", async () => {
    await beginMcpMutation(db, input());

    await expect(
      beginMcpMutation(db, input({ now: new Date(now.getTime() + LEASE_MS - 1) })),
    ).rejects.toMatchObject({ code: "CONFLICT", retryable: true });
  });

  it("replays a completed response long after the lease deadline", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await completeMcpMutation(db, first.leaseId, { runId: "run-17" }, now);

    // An hour in, the lease is long dead and the answer is not, so the repeat
    // has to be answered rather than executed a second time.
    await expect(
      beginMcpMutation<{ runId: string }>(
        db,
        input({ now: new Date(now.getTime() + 60 * 60_000) }),
      ),
    ).resolves.toEqual({ kind: "replay", response: { runId: "run-17" } });
  });

  // A released attempt is one whose failure said nothing about the key, so the
  // key has to come back free. The identifier has to come back different too:
  // the dispatch request it names is already dead, and reusing it would point a
  // retry straight back at the failure it is retrying.
  it("frees a released key for a fresh lease under a new identifier", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");

    await releaseMcpMutation(db, first.leaseId);
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toHaveLength(0);

    const retry = await beginMcpMutation(db, input());
    expect(retry.kind).toBe("execute");
    if (retry.kind !== "execute") throw new Error("expected execution lease");
    expect(retry.leaseId).not.toBe(first.leaseId);
  });

  it("refuses to release a lease that is no longer active", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await completeMcpMutation(db, first.leaseId, { runId: "run-17" }, now);

    await expect(releaseMcpMutation(db, first.leaseId)).rejects.toMatchObject({
      code: "CONFLICT",
      retryable: true,
    });
    await expect(db.select().from(mcpIdempotencyKeys)).resolves.toHaveLength(1);
  });

  it("normalizes release database failures without exposing driver details", async () => {
    const decision = await beginMcpMutation(db, input());
    if (decision.kind !== "execute") throw new Error("expected execution lease");
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "delete") {
          return () => {
            throw new Error("raw release database detail");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(releaseMcpMutation(failingDb, decision.leaseId)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Dependency unavailable",
      retryable: true,
    });
  });

  it("replays a persisted failure long after the lease deadline", async () => {
    const first = await beginMcpMutation(db, input());
    if (first.kind !== "execute") throw new Error("expected execution lease");
    await failMcpMutation(db, first.leaseId, "VALIDATION_FAILED", now);

    await expect(
      beginMcpMutation(db, input({ now: new Date(now.getTime() + 60 * 60_000) })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
  });

  // Every key ever used stays in the table otherwise: nothing on the request
  // path deletes a row it can no longer read, it only takes one over.
  it("sweeps keys past their expiry and leaves the live ones", async () => {
    await beginMcpMutation(
      db,
      input({
        idempotencyKey: "key-expired",
        now: new Date(now.getTime() - LEASE_MS - 1_000),
      }),
    );
    await beginMcpMutation(db, input({ idempotencyKey: "key-live" }));

    await expect(sweepMcpIdempotencyKeys(db, now)).resolves.toEqual({ deleted: 1 });
    const rows = await db.select().from(mcpIdempotencyKeys);
    expect(rows.map((row) => row.idempotencyKey)).toEqual(["key-live"]);
  });

  it("sweeps one bounded batch per pass, oldest first", async () => {
    for (const minutesAgo of [30, 20, 10]) {
      await beginMcpMutation(
        db,
        input({
          idempotencyKey: `key-${minutesAgo}`,
          now: new Date(now.getTime() - minutesAgo * 60_000),
        }),
      );
    }

    await expect(sweepMcpIdempotencyKeys(db, now, { limit: 2 })).resolves.toEqual({
      deleted: 2,
    });
    const rows = await db.select().from(mcpIdempotencyKeys);
    expect(rows.map((row) => row.idempotencyKey)).toEqual(["key-10"]);
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
