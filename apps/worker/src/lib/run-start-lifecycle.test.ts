import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { Db } from "../db/client.js";
import { activeRuns, workflowRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";

const mocks = vi.hoisted(() => ({
  cancelOwned: vi.fn(),
  cancelHosted: vi.fn(),
  hostedStatus: "running",
  confirmDrained: vi.fn(),
}));

vi.mock("./cancel-run.js", () => ({
  cancelSubjectRun: (...args: unknown[]) => mocks.cancelOwned(...args),
}));
vi.mock("../../env.js", () => ({ env: {} }));
vi.mock("./workflow-step-drain.js", () => ({
  confirmWorkflowStepsDrained: (...args: unknown[]) =>
    mocks.confirmDrained(...args),
}));
vi.mock("workflow/api", () => ({
  getRun: () => ({
    cancel: (...args: unknown[]) => mocks.cancelHosted(...args),
    get status() {
      return Promise.resolve(mocks.hostedStatus);
    },
  }),
}));

const {
  reconcileStartupWatchdog,
  STARTUP_TIMEOUT_REASON,
} = await import("./run-start-lifecycle.js");

const now = new Date("2026-07-27T12:00:00.000Z");
let db: Db;
const registry = {} as RunRegistryAdapter;

beforeEach(async () => {
  db = await createTestDb();
  mocks.cancelOwned.mockReset().mockResolvedValue(true);
  mocks.cancelHosted.mockReset().mockImplementation(async () => {
    mocks.hostedStatus = "cancelled";
  });
  mocks.confirmDrained.mockReset().mockResolvedValue(true);
  mocks.hostedStatus = "running";
});

async function insertRun(input: {
  runId?: string;
  deadline: Date;
  entryStartedAt?: Date | null;
  withOwner?: boolean;
}) {
  const runId = input.runId ?? "run-startup";
  const subjectKey = `ticket:jira:${runId.toUpperCase()}`;
  await db.insert(workflowRuns).values({
    runId,
    status: "running",
    subjectKey,
    ticketKey: runId.toUpperCase(),
    createdAt: new Date(now.getTime() - 11 * 60_000),
    startedAt: new Date(now.getTime() - 11 * 60_000),
    startupDeadlineAt: input.deadline,
    entryStartedAt: input.entryStartedAt ?? null,
  });
  if (input.withOwner) {
    await db.insert(activeRuns).values({
      subjectKey,
      ticketKey: runId.toUpperCase(),
      ownerToken: `owner:${runId}`,
      runId,
      state: "bound",
      runKind: "ticket",
    });
  }
  return { runId, subjectKey };
}

describe("startup watchdog", () => {
  it("does not select a run one millisecond before its deadline", async () => {
    await insertRun({ deadline: new Date(now.getTime() + 1) });
    await expect(
      reconcileStartupWatchdog({ db, runRegistry: registry, now }),
    ).resolves.toEqual({ selected: 0, cancelled: 0, retryable: 0 });
  });

  it("selects exactly at the ten-minute deadline and closes an orphaned run", async () => {
    const { runId } = await insertRun({ deadline: now });
    await expect(
      reconcileStartupWatchdog({ db, runRegistry: registry, now }),
    ).resolves.toEqual({ selected: 1, cancelled: 1, retryable: 0 });
    expect(mocks.cancelHosted).toHaveBeenCalledOnce();

    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId));
    expect(row).toMatchObject({
      status: "failed",
      statusReason: STARTUP_TIMEOUT_REASON,
    });
    expect(row?.diagnosticId).toMatch(/^diag_/);
  });

  it("never applies the startup watchdog after application entry begins", async () => {
    await insertRun({
      deadline: new Date(now.getTime() - 60_000),
      entryStartedAt: new Date(now.getTime() - 30_000),
    });
    await expect(
      reconcileStartupWatchdog({ db, runRegistry: registry, now }),
    ).resolves.toEqual({ selected: 0, cancelled: 0, retryable: 0 });
  });

  it("closes the exact active owner before marking the startup failure", async () => {
    const { runId, subjectKey } = await insertRun({
      deadline: new Date(now.getTime() - 1),
      withOwner: true,
    });
    await expect(
      reconcileStartupWatchdog({ db, runRegistry: registry, now }),
    ).resolves.toEqual({ selected: 1, cancelled: 1, retryable: 0 });
    expect(mocks.cancelOwned).toHaveBeenCalledWith(
      subjectKey,
      { ownerToken: `owner:${runId}`, runId },
      registry,
      undefined,
      STARTUP_TIMEOUT_REASON,
    );
  });

  it("keeps cancellation failures retryable and never records a false terminal row", async () => {
    const { runId } = await insertRun({
      deadline: new Date(now.getTime() - 1),
    });
    mocks.cancelHosted.mockRejectedValueOnce(new Error("provider unavailable"));
    mocks.hostedStatus = "running";

    await expect(
      reconcileStartupWatchdog({ db, runRegistry: registry, now }),
    ).resolves.toEqual({ selected: 1, cancelled: 0, retryable: 1 });
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId));
    expect(row?.status).toBe("running");
    expect(row?.diagnosticId).toMatch(/^diag_/);
  });

  it("waits for hosted terminal confirmation after cancellation is accepted", async () => {
    const { runId } = await insertRun({
      deadline: new Date(now.getTime() - 1),
    });
    mocks.cancelHosted.mockResolvedValueOnce(undefined);
    mocks.hostedStatus = "running";

    await expect(
      reconcileStartupWatchdog({ db, runRegistry: registry, now }),
    ).resolves.toEqual({ selected: 1, cancelled: 0, retryable: 1 });
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId));
    expect(row?.status).toBe("running");
  });
});
