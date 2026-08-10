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
  warn: vi.fn(),
}));
const state = vi.hoisted(() => ({
  db: undefined as Db | undefined,
}));

vi.mock("./cancel-run.js", () => ({
  cancelSubjectRun: (...args: unknown[]) => mocks.cancelOwned(...args),
}));
vi.mock("./logger.js", () => ({
  logger: {
    warn: mocks.warn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../../env.js", () => ({ env: {} }));
vi.mock("../db/client.js", () => ({
  getDb: () => {
    if (!state.db) throw new Error("Test database is not ready");
    return state.db;
  },
}));
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
  commitHostedStart,
  recordAndCancelOrphanStartedRun,
  reconcileStartupWatchdog,
  STARTUP_TIMEOUT_REASON,
} = await import("./run-start-lifecycle.js");

const now = new Date("2026-07-27T12:00:00.000Z");
let db: Db;
const registry = {} as RunRegistryAdapter;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  mocks.cancelOwned.mockReset().mockResolvedValue(true);
  mocks.cancelHosted.mockReset().mockImplementation(async () => {
    mocks.hostedStatus = "cancelled";
  });
  mocks.confirmDrained.mockReset().mockResolvedValue(true);
  mocks.warn.mockReset();
  mocks.hostedStatus = "running";
});

function warnedMessages(): string[] {
  return mocks.warn.mock.calls.map((call) => call[1] as string);
}

const started = {
  subjectKey: "ticket:jira:PROJ-1",
  ticketKey: "PROJ-1",
  ownerToken: "owner-a",
  kind: "ticket" as const,
  runId: "run-started",
};

function boundOwner(overrides: Record<string, unknown> = {}) {
  return {
    subjectKey: started.subjectKey,
    ticketKey: started.ticketKey,
    ownerToken: started.ownerToken,
    kind: started.kind,
    runId: started.runId,
    state: "bound",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function throwingCommitRegistry(owner: unknown): RunRegistryAdapter {
  return {
    commitStartedRun: vi.fn().mockRejectedValue(new Error("connection lost")),
    get: vi.fn().mockResolvedValue(owner),
  } as unknown as RunRegistryAdapter;
}

async function insertStartedRunRow(): Promise<void> {
  await db.insert(workflowRuns).values({
    runId: started.runId,
    status: "running",
    subjectKey: started.subjectKey,
    ticketKey: started.ticketKey,
  });
}

describe("hosted start commit", () => {
  it("accepts an exact owner/run after an ambiguous commit exception", async () => {
    await insertStartedRunRow();
    const runRegistry = throwingCommitRegistry(boundOwner());

    await expect(commitHostedStart(runRegistry, started)).resolves.toBe(true);
    expect(mocks.cancelHosted).not.toHaveBeenCalled();
    expect(warnedMessages()).not.toContain(
      "dispatch_start_bound_without_run_row",
    );
  });

  it("treats a bound claim with no run row as an orphan instead of a start", async () => {
    const runRegistry = throwingCommitRegistry(boundOwner());

    await expect(commitHostedStart(runRegistry, started)).resolves.toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKey: started.subjectKey,
        runId: started.runId,
        ownerToken: started.ownerToken,
        claimState: "bound",
      }),
      "dispatch_start_bound_without_run_row",
    );
    expect(mocks.cancelHosted).toHaveBeenCalledOnce();
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, started.runId));
    expect(row).toMatchObject({
      status: "failed",
      statusReason: "Hosted workflow start lost dispatch ownership.",
    });
  });

  it("keeps the run alive when the run row lookup itself fails", async () => {
    state.db = {
      select: () => {
        throw new Error("read failed");
      },
    } as unknown as Db;
    const runRegistry = throwingCommitRegistry(boundOwner());

    await expect(commitHostedStart(runRegistry, started)).resolves.toBe(true);
    expect(warnedMessages()).toContain(
      "dispatch_start_run_row_check_unconfirmed",
    );
    expect(mocks.cancelHosted).not.toHaveBeenCalled();
  });

  it("never reads the run row when the commit itself succeeds", async () => {
    state.db = undefined;
    const runRegistry = {
      commitStartedRun: vi.fn().mockResolvedValue(true),
      get: vi.fn(),
    } as unknown as RunRegistryAdapter;

    await expect(commitHostedStart(runRegistry, started)).resolves.toBe(true);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.cancelHosted).not.toHaveBeenCalled();
  });

  it("records an orphan when an ambiguous commit left the claim with another owner", async () => {
    const runRegistry = throwingCommitRegistry(
      boundOwner({ ownerToken: "owner-b" }),
    );

    await expect(commitHostedStart(runRegistry, started)).resolves.toBe(false);
    expect(mocks.cancelHosted).toHaveBeenCalledOnce();
    expect(warnedMessages()).not.toContain(
      "dispatch_start_bound_without_run_row",
    );
  });

  it("does not cancel when an ambiguous commit cannot be rechecked", async () => {
    const runRegistry = {
      commitStartedRun: vi.fn().mockRejectedValue(new Error("connection lost")),
      get: vi.fn().mockRejectedValue(new Error("database unavailable")),
    } as unknown as RunRegistryAdapter;

    await expect(commitHostedStart(runRegistry, started)).rejects.toThrow(
      "database unavailable",
    );
    expect(mocks.cancelHosted).not.toHaveBeenCalled();
  });

  it("records and cancels a confirmed orphan candidate", async () => {
    const runRegistry = {
      commitStartedRun: vi.fn().mockResolvedValue(false),
    } as unknown as RunRegistryAdapter;

    await expect(commitHostedStart(runRegistry, started)).resolves.toBe(false);
    expect(mocks.cancelHosted).toHaveBeenCalledOnce();
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, started.runId));
    expect(row).toMatchObject({
      status: "failed",
      statusReason: "Hosted workflow start lost dispatch ownership.",
    });
    expect(row?.diagnosticId).toMatch(/^diag_/);
  });

  it("records direct orphan cleanup after terminal cancellation", async () => {
    await recordAndCancelOrphanStartedRun({
      ...started,
      runId: "run-direct-orphan",
    });

    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, "run-direct-orphan"));
    expect(row).toMatchObject({
      status: "failed",
      statusReason: "Hosted workflow start lost dispatch ownership.",
    });
  });
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
