import { describe, it, expect, vi } from "vitest";
import { collectBlockStatuses } from "./collect-block-statuses.js";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { workflowRuns } from "../../db/schema.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import type { BlockRunState } from "@shared/contracts";

function makeRegistry(
  entries: Array<{ ticketKey: string; runId: string }>,
): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: vi.fn(),
    listAll: vi.fn().mockResolvedValue(entries),
    registerSandbox: vi.fn(),
    getSandboxId: vi.fn(),
    getEntryCreatedAt: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

interface RowInput {
  runId: string;
  status?: string | null;
  blockStatuses?: Record<string, BlockRunState> | null;
  updatedAt?: Date;
  completedAt?: Date | null;
  definitionVersion?: number | null;
  definitionId?: number | null;
}

async function insert(db: Db, over: RowInput) {
  await db.insert(workflowRuns).values({
    runId: over.runId,
    workflowId: "wf_agent",
    workflowName: "Agent",
    status: over.status ?? "running",
    ticketKey: "AWT-1",
    definitionVersion: over.definitionVersion ?? 1,
    definitionId: over.definitionId ?? null,
    blockStatuses:
      over.blockStatuses === undefined
        ? { b1: { status: "running" } }
        : over.blockStatuses,
    ...(over.updatedAt ? { updatedAt: over.updatedAt } : {}),
    ...(over.completedAt !== undefined ? { completedAt: over.completedAt } : {}),
  });
}

describe("collectBlockStatuses", () => {
  it("prefers a live run over a newer completed row", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "done",
      status: "success",
      updatedAt: new Date("2026-07-10T12:00:00Z"),
      completedAt: new Date("2026-07-10T12:00:00Z"),
      blockStatuses: { b1: { status: "ok" } },
    });
    await insert(db, {
      runId: "live",
      status: "running",
      updatedAt: new Date("2026-07-10T10:00:00Z"),
      blockStatuses: { b1: { status: "running" } },
    });
    const registry = makeRegistry([{ ticketKey: "AWT-1", runId: "live" }]);

    const snap = await collectBlockStatuses({ registry, db });
    expect(snap?.runId).toBe("live");
    expect(snap?.source).toBe("live");
    expect(snap?.blockStatuses).toEqual({ b1: { status: "running" } });
  });

  it("among multiple live runs picks the most recently updated", async () => {
    const db = await createTestDb();
    await insert(db, { runId: "old", updatedAt: new Date("2026-07-10T09:00:00Z") });
    await insert(db, { runId: "new", updatedAt: new Date("2026-07-10T11:00:00Z") });
    const registry = makeRegistry([
      { ticketKey: "AWT-1", runId: "old" },
      { ticketKey: "AWT-2", runId: "new" },
    ]);

    const snap = await collectBlockStatuses({ registry, db });
    expect(snap?.runId).toBe("new");
    expect(snap?.source).toBe("live");
  });

  it("falls back to the latest success/failed row with block statuses", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "older",
      status: "success",
      updatedAt: new Date("2026-07-10T08:00:00Z"),
      completedAt: new Date("2026-07-10T08:00:00Z"),
    });
    await insert(db, {
      runId: "newer",
      status: "failed",
      updatedAt: new Date("2026-07-10T09:00:00Z"),
      completedAt: new Date("2026-07-10T09:00:00Z"),
      blockStatuses: { b1: { status: "fail", error: "boom" } },
    });
    const registry = makeRegistry([]);

    const snap = await collectBlockStatuses({ registry, db });
    expect(snap?.runId).toBe("newer");
    expect(snap?.source).toBe("last");
    expect(snap?.status).toBe("failed");
    expect(snap?.blockStatuses).toEqual({ b1: { status: "fail", error: "boom" } });
  });

  it("ignores rows with null block statuses", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "live-null",
      status: "running",
      blockStatuses: null,
      updatedAt: new Date("2026-07-10T10:00:00Z"),
    });
    await insert(db, {
      runId: "done-null",
      status: "success",
      blockStatuses: null,
      completedAt: new Date("2026-07-10T11:00:00Z"),
      updatedAt: new Date("2026-07-10T11:00:00Z"),
    });
    const registry = makeRegistry([{ ticketKey: "AWT-1", runId: "live-null" }]);

    expect(await collectBlockStatuses({ registry, db })).toBeNull();
  });

  it("excludes blocked runs from the completed fallback", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "blocked",
      status: "blocked",
      completedAt: new Date("2026-07-10T11:00:00Z"),
      updatedAt: new Date("2026-07-10T11:00:00Z"),
      blockStatuses: { b1: { status: "warn" } },
    });
    const registry = makeRegistry([]);

    expect(await collectBlockStatuses({ registry, db })).toBeNull();
  });

  it("returns null when there are no runs", async () => {
    const db = await createTestDb();
    const registry = makeRegistry([]);
    expect(await collectBlockStatuses({ registry, db })).toBeNull();
  });

  it("carries definitionId in the snapshot", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "done",
      status: "success",
      completedAt: new Date("2026-07-10T12:00:00Z"),
      updatedAt: new Date("2026-07-10T12:00:00Z"),
      definitionId: 42,
    });
    const snap = await collectBlockStatuses({ registry: makeRegistry([]), db });
    expect(snap?.definitionId).toBe(42);
  });

  it("filters a live run by definitionId", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "other",
      updatedAt: new Date("2026-07-10T11:00:00Z"),
      definitionId: 1,
    });
    await insert(db, {
      runId: "wanted",
      updatedAt: new Date("2026-07-10T10:00:00Z"),
      definitionId: 2,
    });
    const registry = makeRegistry([
      { ticketKey: "AWT-1", runId: "other" },
      { ticketKey: "AWT-2", runId: "wanted" },
    ]);

    const snap = await collectBlockStatuses({ registry, db, definitionId: 2 });
    expect(snap?.runId).toBe("wanted");
    expect(snap?.source).toBe("live");
  });

  it("filters the completed fallback by definitionId", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "newer-other",
      status: "success",
      completedAt: new Date("2026-07-10T12:00:00Z"),
      updatedAt: new Date("2026-07-10T12:00:00Z"),
      definitionId: 1,
    });
    await insert(db, {
      runId: "older-wanted",
      status: "success",
      completedAt: new Date("2026-07-10T09:00:00Z"),
      updatedAt: new Date("2026-07-10T09:00:00Z"),
      definitionId: 2,
    });
    const snap = await collectBlockStatuses({ registry: makeRegistry([]), db, definitionId: 2 });
    expect(snap?.runId).toBe("older-wanted");
    expect(snap?.source).toBe("last");
  });

  it("returns null when no run matches the definitionId filter", async () => {
    const db = await createTestDb();
    await insert(db, {
      runId: "live",
      updatedAt: new Date("2026-07-10T10:00:00Z"),
      definitionId: 1,
    });
    await insert(db, {
      runId: "done",
      status: "success",
      completedAt: new Date("2026-07-10T11:00:00Z"),
      updatedAt: new Date("2026-07-10T11:00:00Z"),
      definitionId: 1,
    });
    const registry = makeRegistry([{ ticketKey: "AWT-1", runId: "live" }]);
    expect(await collectBlockStatuses({ registry, db, definitionId: 99 })).toBeNull();
  });
});
