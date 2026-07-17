import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { activeRunSandboxes } from "../../db/schema.js";
import { activeRuns } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { PostgresRunRegistry } from "./postgres.js";

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  registry = new PostgresRunRegistry(db);
});

const subjectKey = "ticket:jira:PROJ-1";

describe("owner-CAS run claims", () => {
  it("reserves an unclaimed subject without pretending a workflow is bound", async () => {
    expect(
      await registry.reserve({
        subjectKey,
        ticketKey: "PROJ-1",
        ownerToken: "owner-a",
        kind: "ticket",
      }),
    ).toBe(true);

    expect(await registry.get(subjectKey)).toMatchObject({
      subjectKey,
      ticketKey: "PROJ-1",
      ownerToken: "owner-a",
      runId: null,
      state: "reserved",
      kind: "ticket",
    });
  });

  it("does not let a retry replace an existing owner", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(
      await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-b", kind: "ticket" }),
    ).toBe(false);
    expect((await registry.get(subjectKey))?.ownerToken).toBe("owner-a");
  });

  it("only lets the reservation owner bind a candidate workflow run", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });

    expect(await registry.bindRun(subjectKey, "owner-b", "run-loser")).toBe(false);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-winner")).toBe(true);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-retry")).toBe(false);
    expect(await registry.get(subjectKey)).toMatchObject({ state: "bound", runId: "run-winner" });
  });

  it("returns whether owner-matching terminal release actually deleted", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    await registry.bindRun(subjectKey, "owner-a", "run-winner");

    expect(await registry.release(subjectKey, "owner-b", "run-winner")).toBe(false);
    expect(await registry.release(subjectKey, "owner-a", "run-other")).toBe(false);
    expect(await registry.release(subjectKey, "owner-a", "run-winner")).toBe(true);
    expect(await registry.release(subjectKey, "owner-a", "run-winner")).toBe(false);
  });

  it("cannot terminal-release an unbound reservation and cannot reservation-release a bound run", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(await registry.release(subjectKey, "owner-a", "run-a")).toBe(false);
    expect(await registry.bindRun(subjectKey, "owner-a", "run-a")).toBe(true);
    expect(await registry.releaseReservation(subjectKey, "owner-a")).toBe(false);
    expect((await registry.get(subjectKey))?.runId).toBe("run-a");
  });

  it("lets only the owner discard an unbound reservation", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(await registry.releaseReservation(subjectKey, "owner-b")).toBe(false);
    expect(await registry.releaseReservation(subjectKey, "owner-a")).toBe(true);
    expect(await registry.get(subjectKey)).toBeNull();
  });

  it("owner-only reservation handoff never overwrites a bound run", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    expect(await registry.handoff(subjectKey, "owner-a", "owner-b")).toBe(true);
    expect((await registry.get(subjectKey))?.ownerToken).toBe("owner-b");
    await registry.bindRun(subjectKey, "owner-b", "run-b");
    expect(await registry.handoff(subjectKey, "owner-b", "owner-c")).toBe(false);
    expect((await registry.get(subjectKey))?.runId).toBe("run-b");
  });

  it("CAS-hands an exact parked run to one unbound successor reservation", async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-parked", kind: "ticket" });
    await registry.bindRun(subjectKey, "owner-parked", "run-parked");

    expect(
      await registry.handoffBoundRun(subjectKey, "owner-parked", "run-other", "owner-loser"),
    ).toBe(false);
    expect(
      await registry.handoffBoundRun(subjectKey, "owner-parked", "run-parked", "owner-successor"),
    ).toBe(true);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-successor",
      runId: null,
      state: "reserved",
    });
    expect(
      await registry.handoffBoundRun(subjectKey, "owner-parked", "run-parked", "owner-second"),
    ).toBe(false);
    expect(await registry.bindRun(subjectKey, "owner-successor", "run-winner")).toBe(true);
    expect(await registry.bindRun(subjectKey, "owner-successor", "run-retry-loser")).toBe(false);
  });
});

describe("subject metadata and capacity listing", () => {
  it("keeps synthetic PR subjects ticket-free", async () => {
    await registry.reserve({
      subjectKey: "pr:github:acme/api#42",
      ticketKey: null,
      ownerToken: "owner-pr",
      kind: "pr_trigger",
    });
    expect(await registry.listAll()).toEqual([
      expect.objectContaining({
        subjectKey: "pr:github:acme/api#42",
        ticketKey: null,
        ownerToken: "owner-pr",
        runId: null,
        state: "reserved",
        kind: "pr_trigger",
      }),
    ]);
  });

  it("records reservation and update timestamps", async () => {
    const before = Date.now();
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    const entry = await registry.get(subjectKey);
    expect(entry?.createdAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("rejects raw rows whose state and run id disagree", async () => {
    await expect(
      db.insert(activeRuns).values({
        subjectKey: "ticket:jira:PROJ-2",
        ticketKey: "PROJ-2",
        ownerToken: "owner-b",
        state: "reserved",
        runId: "run-should-be-null",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(activeRuns).values({
        subjectKey: "ticket:jira:PROJ-3",
        ticketKey: "PROJ-3",
        ownerToken: "owner-c",
        state: "bound",
        runId: null,
      }),
    ).rejects.toThrow();
  });
});

describe("owner-isolated child sandboxes", () => {
  beforeEach(async () => {
    await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken: "owner-a", kind: "ticket" });
    await registry.bindRun(subjectKey, "owner-a", "run-a");
  });

  it("registers and lists every scratch/code sandbox for the owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-code");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-scratch");
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([
      "sandbox-code",
      "sandbox-scratch",
    ]);
  });

  it("rejects sandbox registration by a stale owner", async () => {
    await expect(
      registry.registerSandbox(subjectKey, "owner-b", "sandbox-orphan"),
    ).rejects.toThrow("owner does not hold active run");
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
  });

  it("does not expose one owner's sandboxes through another owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-a");
    expect(await registry.listSandboxes(subjectKey, "owner-b")).toEqual([]);
  });

  it("unregisters one stopped sandbox without releasing the parked owner", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-code");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-scratch");
    expect(await registry.unregisterSandbox(subjectKey, "owner-a", "sandbox-code")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual(["sandbox-scratch"]);
    expect(await registry.get(subjectKey)).toMatchObject({ ownerToken: "owner-a", runId: "run-a" });
  });

  it("clears predecessor sandbox registrations during bound handoff", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-a");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-b");
    expect(await registry.handoffBoundRun(subjectKey, "owner-a", "run-a", "owner-next")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
    expect(await registry.listSandboxes(subjectKey, "owner-next")).toEqual([]);
  });

  it("enforces subject plus owner isolation at the database boundary", async () => {
    await expect(
      db.insert(activeRunSandboxes).values({
        subjectKey,
        ownerToken: "owner-b",
        sandboxId: "sandbox-b",
      }),
    ).rejects.toThrow();
  });

  it("terminal owner release removes all child sandbox registrations", async () => {
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-a");
    await registry.registerSandbox(subjectKey, "owner-a", "sandbox-b");
    expect(await registry.release(subjectKey, "owner-a", "run-a")).toBe(true);
    expect(await registry.listSandboxes(subjectKey, "owner-a")).toEqual([]);
  });
});

describe("ticket-only stores", () => {
  it("round-trips failed ticket and thread metadata independently of subject claims", async () => {
    const meta = {
      runId: "run-a",
      error: "failed",
      failedAt: "2026-07-17T12:00:00.000Z",
    };
    await registry.markFailed("PROJ-1", meta);
    await registry.setParent("PROJ-1", "1777542341.966359");
    expect(await registry.listAllFailed()).toEqual([{ ticketKey: "PROJ-1", meta }]);
    expect(await registry.getParent("PROJ-1")).toBe("1777542341.966359");
    await registry.clearFailedMark("PROJ-1");
    await registry.clearParent("PROJ-1");
    expect(await registry.isTicketFailed("PROJ-1")).toBe(false);
    expect(await registry.getParent("PROJ-1")).toBeNull();
  });
});
