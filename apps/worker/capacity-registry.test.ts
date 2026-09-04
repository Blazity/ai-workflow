import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapacityFixtureOwnershipError,
  CapacityRegistry,
  createCapacityCampaign,
  createNeonCapacitySeedExecutor,
  withCapacityReservations,
} from "./e2e/helpers/capacity-registry.js";
import { PostgresRunRegistry } from "./src/adapters/run-registry/postgres.js";
import { RESERVATION_BIND_GRACE_MS } from "./src/adapters/run-registry/types.js";
import type { Db } from "./src/db/client.js";
import {
  activeRuns,
  dispatchCapacityQueue,
  workflowRuns,
} from "./src/db/schema.js";
import { createTestDb } from "./src/db/test-db.js";

let db: Db;
let fixtures: CapacityRegistry;

beforeEach(
  async () => {
    db = await createTestDb();
    fixtures = new CapacityRegistry(db);
  },
  30_000,
);

function campaign(id: string, slots = 3) {
  return createCapacityCampaign(slots, () => id);
}

describe("owner-scoped capacity fixtures", () => {
  it("submits lock-before-baseline as one ReadCommitted Neon transaction", async () => {
    // PGlite exposes one embedded session, so it cannot reproduce two Neon
    // HTTP sessions contending under MVCC. Lock down the production transport
    // contract instead: one transaction, lock first, baseline statement second.
    const query = vi.fn((text: string, params: unknown[] = []) => ({
      text,
      params,
    }));
    const transaction = vi.fn(async () => [
      [],
      [{ baseline_count: 0, inserted_count: 3 }],
    ]);
    const executor = createNeonCapacitySeedExecutor({
      query,
      transaction,
    } as unknown as Parameters<typeof createNeonCapacitySeedExecutor>[0]);
    const neonFixtures = new CapacityRegistry(db, executor);

    await expect(
      neonFixtures.seed(campaign("10101010-1010-4010-8010-101010101010")),
    ).resolves.toBe(3);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0].replace(/\s+/g, " ").trim()).toBe(
      "LOCK TABLE active_runs IN SHARE ROW EXCLUSIVE MODE",
    );
    expect(query.mock.calls[1]?.[0]).toMatch(/WITH baseline AS MATERIALIZED/i);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]?.[0]).toEqual([
      query.mock.results[0]?.value,
      query.mock.results[1]?.value,
    ]);
    expect(transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "ReadCommitted",
    });
  });

  it("atomically seeds fresh reservations against the current migrated schema", async () => {
    const owned = campaign("11111111-1111-4111-8111-111111111111");

    await expect(fixtures.seed(owned)).resolves.toBe(3);

    const rows = await db.select().from(activeRuns);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      owned.subjectKeys.map((subjectKey) =>
        expect.objectContaining({
          subjectKey,
          ownerToken: owned.ownerToken,
          ticketKey: null,
          runId: null,
          state: "reserved",
          runKind: "schedule",
        }),
      ),
    );
  });

  it("fails closed on a foreign baseline and preserves it byte-for-byte", async () => {
    await db.insert(activeRuns).values({
      subjectKey: "ticket:jira:FOREIGN-1",
      ticketKey: "FOREIGN-1",
      ownerToken: "foreign-owner",
      runId: "run-foreign",
      state: "bound",
      runKind: "ticket",
    });
    const before = await db.select().from(activeRuns);

    await expect(
      fixtures.seed(campaign("22222222-2222-4222-8222-222222222222")),
    ).rejects.toThrow(/baseline contains 1 active run/i);

    expect(await db.select().from(activeRuns)).toEqual(before);
  });

  it("isolates campaign cleanup and never uses another campaign as ownership", async () => {
    const ownedA = campaign("33333333-3333-4333-8333-333333333333", 2);
    const ownedB = campaign("44444444-4444-4444-8444-444444444444", 2);
    await fixtures.seed(ownedA);
    await db.insert(activeRuns).values(
      ownedB.subjectKeys.map((subjectKey) => ({
        subjectKey,
        ticketKey: null,
        ownerToken: ownedB.ownerToken,
        runId: null,
        state: "reserved",
        runKind: "schedule",
      })),
    );

    await expect(fixtures.cleanup(ownedA)).resolves.toBe(2);

    expect(
      (await db.select().from(activeRuns)).map((row) => row.subjectKey),
    ).toEqual(ownedB.subjectKeys);
  });

  it.each([
    {
      name: "owner",
      mutate: async (owned: ReturnType<typeof campaign>) => {
        await db
          .update(activeRuns)
          .set({ ownerToken: "foreign-owner" })
          .where(eq(activeRuns.subjectKey, owned.subjectKeys[0]!));
      },
    },
    {
      name: "state",
      mutate: async (owned: ReturnType<typeof campaign>) => {
        await db
          .update(activeRuns)
          .set({ state: "bound", runId: "run-unexpected" })
          .where(eq(activeRuns.subjectKey, owned.subjectKeys[0]!));
      },
    },
  ])(
    "refuses $name drift without deleting any campaign row",
    async ({ mutate }) => {
      const owned = campaign("55555555-5555-4555-8555-555555555555");
      await fixtures.seed(owned);
      await mutate(owned);

      await expect(fixtures.cleanup(owned)).rejects.toBeInstanceOf(
        CapacityFixtureOwnershipError,
      );

      expect(await db.select().from(activeRuns)).toHaveLength(3);
    },
  );

  it("makes exact reservation cleanup idempotent", async () => {
    const owned = campaign("66666666-6666-4666-8666-666666666666");
    await fixtures.seed(owned);

    await expect(fixtures.cleanup(owned)).resolves.toBe(3);
    await expect(fixtures.cleanup(owned)).resolves.toBe(0);
    expect(await db.select().from(activeRuns)).toEqual([]);
  });

  it("cleans after an assertion failure, but only after the release barrier", async () => {
    const owned = campaign("77777777-7777-4777-8777-777777777777");
    let barrierSawReservations = false;

    await expect(
      withCapacityReservations({
        registry: fixtures,
        campaign: owned,
        run: async () => {
          throw new Error("simulated assertion failure");
        },
        beforeRelease: async () => {
          barrierSawReservations =
            (await db.select().from(activeRuns)).length ===
            owned.subjectKeys.length;
        },
      }),
    ).rejects.toThrow("simulated assertion failure");

    expect(barrierSawReservations).toBe(true);
    expect(await db.select().from(activeRuns)).toEqual([]);
  });

  it("preserves reservations when the release barrier cannot confirm safety", async () => {
    const owned = campaign("88888888-8888-4888-8888-888888888888");

    await expect(
      withCapacityReservations({
        registry: fixtures,
        campaign: owned,
        run: async () => undefined,
        beforeRelease: async () => {
          throw new Error("ticket still in AI");
        },
      }),
    ).rejects.toThrow("ticket still in AI");

    expect(await db.select().from(activeRuns)).toHaveLength(3);
  });

  it("refreshes exact reservations and retains production expiry behavior", async () => {
    const owned = campaign("99999999-9999-4999-8999-999999999999");
    const registry = new PostgresRunRegistry(db);
    await fixtures.seed(owned);
    await db
      .update(activeRuns)
      .set({
        updatedAt: sql`now() - (${RESERVATION_BIND_GRACE_MS + 1_000} * interval '1 millisecond')`,
      })
      .where(eq(activeRuns.ownerToken, owned.ownerToken));

    expect(await registry.listCapacityConsumers()).toEqual([]);
    await expect(fixtures.refresh(owned)).resolves.toBe(3);
    expect(
      (await registry.listCapacityConsumers()).map((entry) => entry.subjectKey),
    ).toEqual(owned.subjectKeys);
  });

  it.each([
    {
      name: "owner",
      mutate: async (owned: ReturnType<typeof campaign>) => {
        await db
          .update(activeRuns)
          .set({ ownerToken: "foreign-owner" })
          .where(eq(activeRuns.subjectKey, owned.subjectKeys[0]!));
      },
    },
    {
      name: "state",
      mutate: async (owned: ReturnType<typeof campaign>) => {
        await db
          .update(activeRuns)
          .set({ state: "bound", runId: "run-unexpected" })
          .where(eq(activeRuns.subjectKey, owned.subjectKeys[0]!));
      },
    },
  ])("refuses $name drift without refreshing any row", async ({ mutate }) => {
    const owned = campaign("90909090-9090-4090-8090-909090909090");
    await fixtures.seed(owned);
    await db
      .update(activeRuns)
      .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(activeRuns.ownerToken, owned.ownerToken));
    await mutate(owned);
    const before = await db.select().from(activeRuns);

    await expect(fixtures.refresh(owned)).rejects.toBeInstanceOf(
      CapacityFixtureOwnershipError,
    );

    expect(await db.select().from(activeRuns)).toEqual(before);
  });

  it("counts ticket claims even when their run id is null", async () => {
    expect(await fixtures.countTicketClaims("AIW-TEST")).toBe(0);
    await db.insert(activeRuns).values({
      subjectKey: "ticket:jira:AIW-TEST",
      ticketKey: "AIW-TEST",
      ownerToken: "ticket-owner",
      runId: null,
      state: "reserved",
      runKind: "ticket",
    });

    expect(await fixtures.countTicketClaims("AIW-TEST")).toBe(1);
  });

  it("reads at-capacity and no-start evidence for the exact canonical ticket", async () => {
    await db.insert(dispatchCapacityQueue).values({ ticketKey: "AIW-OTHER" });
    await db.insert(activeRuns).values({
      subjectKey: "ticket:jira:AIW-TARGET",
      ticketKey: null,
      ownerToken: "ticket-owner",
      runId: null,
      state: "reserved",
      runKind: "ticket",
    });
    await db.insert(activeRuns).values({
      subjectKey: "ticket:jira:LEGACY-TARGET",
      ticketKey: "AIW-TARGET",
      ownerToken: "legacy-ticket-owner",
      runId: null,
      state: "reserved",
      runKind: "ticket",
    });
    await db.insert(workflowRuns).values({
      runId: "run-target",
      subjectKey: "ticket:jira:AIW-TARGET",
      ticketKey: null,
      status: "running",
    });
    await db.insert(workflowRuns).values({
      runId: "run-legacy-target",
      subjectKey: "ticket:jira:LEGACY-TARGET",
      ticketKey: "AIW-TARGET",
      status: "running",
    });

    await expect(fixtures.inspectTicketDispatch("AIW-TARGET")).resolves.toEqual({
      atCapacityQueued: false,
      activeClaims: 2,
      workflowRuns: 2,
    });

    await db.insert(dispatchCapacityQueue).values({ ticketKey: "AIW-TARGET" });
    await expect(fixtures.inspectTicketDispatch("AIW-TARGET")).resolves.toEqual({
      atCapacityQueued: true,
      activeClaims: 2,
      workflowRuns: 2,
    });
  });

  it("deletes only the exact test ticket's at-capacity evidence", async () => {
    await db.insert(dispatchCapacityQueue).values([
      { ticketKey: "AIW-TARGET" },
      { ticketKey: "AIW-FOREIGN" },
    ]);

    await expect(fixtures.deleteTicketCapacityEvidence("AIW-TARGET")).resolves.toBe(
      1,
    );

    expect(
      (await db.select().from(dispatchCapacityQueue)).map((row) => row.ticketKey),
    ).toEqual(["AIW-FOREIGN"]);
  });
});
