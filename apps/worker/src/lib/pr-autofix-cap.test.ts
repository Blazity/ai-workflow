import { beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { prAutofixAttempts } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { enforcePrAutofixCap } from "./pr-autofix-cap.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const pr = {
  definitionId: "def_1",
  nodeId: "checks_failed_1",
  provider: "github",
  repoPath: "acme/api",
  prNumber: 42,
};
const otherNode = { ...pr, nodeId: "review_fix_1" };
const otherPr = { ...pr, prNumber: 43 };

const t0 = new Date("2026-08-19T10:00:00.000Z");
const t1 = new Date("2026-08-19T10:05:00.000Z");
const t2 = new Date("2026-08-19T10:10:00.000Z");
const t3 = new Date("2026-08-19T10:15:00.000Z");

describe("enforcePrAutofixCap", () => {
  it("writes nothing at all when no cap is configured", async () => {
    await expect(enforcePrAutofixCap(db, pr, undefined, t0)).resolves.toBeNull();

    await expect(db.select().from(prAutofixAttempts)).resolves.toEqual([]);
  });

  it("refuses a non-positive cap without writing a row", async () => {
    // Out of the authored 1..10 range, so unreachable; it must not leave a row
    // behind that a later, valid cap would inherit.
    await expect(enforcePrAutofixCap(db, pr, 0, t0)).resolves.toEqual({
      max: 0,
      allowed: false,
      attempts: 0,
    });

    await expect(db.select().from(prAutofixAttempts)).resolves.toEqual([]);
  });

  it("admits the first dispatch and records one attempt", async () => {
    await expect(enforcePrAutofixCap(db, pr, 3, t0)).resolves.toEqual({
      max: 3,
      allowed: true,
      attempts: 1,
    });

    await expect(db.select().from(prAutofixAttempts)).resolves.toEqual([
      {
        definitionId: "def_1",
        nodeId: "checks_failed_1",
        provider: "github",
        repoPath: "acme/api",
        prNumber: 42,
        attempts: 1,
        updatedAt: t0,
      },
    ]);
  });

  it("counts every call, so the dispatch at the cap is still admitted", async () => {
    await expect(enforcePrAutofixCap(db, pr, 2, t0)).resolves.toEqual({
      max: 2,
      allowed: true,
      attempts: 1,
    });

    // The cap is a budget, not a ceiling to stay under: spending the last unit
    // is allowed.
    await expect(enforcePrAutofixCap(db, pr, 2, t1)).resolves.toEqual({
      max: 2,
      allowed: true,
      attempts: 2,
    });

    await expect(enforcePrAutofixCap(db, pr, 2, t2)).resolves.toEqual({
      max: 2,
      allowed: false,
      attempts: 3,
    });

    await expect(db.select().from(prAutofixAttempts)).resolves.toMatchObject([
      { attempts: 3, updatedAt: t2 },
    ]);
  });

  it("keeps counting after a refusal, so max + 1 happens exactly once", async () => {
    const max = 2;
    const attempts: number[] = [];
    for (const now of [t0, t1, t2, t3]) {
      const decision = await enforcePrAutofixCap(db, pr, max, now);
      attempts.push(decision?.attempts ?? -1);
    }

    // A later stage sends the exhaustion notice on the crossing itself, so the
    // counter must climb past the cap instead of resting on it.
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(attempts.filter((count) => count === max + 1)).toEqual([max + 1]);
  });

  it("keeps two trigger nodes of one definition on independent counters", async () => {
    await enforcePrAutofixCap(db, pr, 1, t0);
    await expect(enforcePrAutofixCap(db, pr, 1, t1)).resolves.toMatchObject({
      allowed: false,
      attempts: 2,
    });

    // Two nodes are two loops over the same pull request; one exhausting its
    // budget says nothing about the other.
    await expect(enforcePrAutofixCap(db, otherNode, 1, t2)).resolves.toMatchObject({
      allowed: true,
      attempts: 1,
    });

    await expect(
      db.select().from(prAutofixAttempts).orderBy(asc(prAutofixAttempts.nodeId)),
    ).resolves.toMatchObject([
      { nodeId: "checks_failed_1", attempts: 2 },
      { nodeId: "review_fix_1", attempts: 1 },
    ]);
  });

  it("keeps two pull requests of one repository on independent counters", async () => {
    await enforcePrAutofixCap(db, pr, 1, t0);
    await expect(enforcePrAutofixCap(db, pr, 1, t1)).resolves.toMatchObject({
      allowed: false,
      attempts: 2,
    });

    await expect(enforcePrAutofixCap(db, otherPr, 1, t2)).resolves.toMatchObject({
      allowed: true,
      attempts: 1,
    });

    await expect(
      db.select().from(prAutofixAttempts).orderBy(asc(prAutofixAttempts.prNumber)),
    ).resolves.toMatchObject([
      { prNumber: 42, attempts: 2 },
      { prNumber: 43, attempts: 1 },
    ]);
  });

  it("loses no increment when deliveries for one pull request arrive together", async () => {
    // The whole update is one INSERT ... ON CONFLICT DO UPDATE, so every caller
    // reads the row it just wrote and none can act on a value another caller is
    // about to overwrite. PGlite serializes these, which is what makes the
    // assertion deterministic; on Postgres the row lock does it.
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => enforcePrAutofixCap(db, pr, 2, t0)),
    );

    const counted = decisions.map((decision) => decision?.attempts ?? -1).sort((a, b) => a - b);
    expect(counted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(decisions.filter((decision) => decision?.allowed).length).toBe(2);
    await expect(db.select().from(prAutofixAttempts)).resolves.toMatchObject([{ attempts: 10 }]);
  });
});
