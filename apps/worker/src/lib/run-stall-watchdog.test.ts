import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import * as runTelemetry from "./telemetry/run-telemetry.js";

vi.mock("../../env.js", () => ({
  env: { COLUMN_AI: "AI" },
}));

const mocks = vi.hoisted(() => ({
  hostedStatus: "running" as string,
  statusError: null as Error | null,
  listSteps: vi.fn(),
  cancelRunDetailed: vi.fn(),
  cancelSubjectRunDetailed: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
const assertOwner = vi.hoisted(() => vi.fn());

vi.mock("workflow/api", () => ({
  getRun: () => ({
    get status() {
      return mocks.statusError
        ? Promise.reject(mocks.statusError)
        : Promise.resolve(mocks.hostedStatus);
    },
  }),
}));
vi.mock("workflow/runtime", () => ({
  getWorld: () => ({ steps: { list: mocks.listSteps } }),
}));
vi.mock("./cancel-run.js", () => ({
  cancelRunDetailed: (...args: unknown[]) => mocks.cancelRunDetailed(...args),
  cancelSubjectRunDetailed: (...args: unknown[]) =>
    mocks.cancelSubjectRunDetailed(...args),
}));
vi.mock("./logger.js", () => ({
  logger: { warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./active-run-owner.js", () => ({
  assertActiveRunOwnerState: assertOwner,
}));

const { findStalledStep, reconcileStalledRun, STALLED_STEP_AFTER_MS } =
  await import("./run-stall-watchdog.js");

// UP-4765 (2026-08-21): checkPhaseDone created 11:57:54, three attempts each
// killed at 800 s, nothing after it. The cron looked at 12:30.
const now = Date.parse("2026-08-21T12:30:00.000Z");
const stepCreatedAt = new Date("2026-08-21T11:57:54.679Z");

const entry = {
  subjectKey: "ticket:jira:UP-4765",
  ticketKey: "UP-4765",
  ownerToken: "owner-a",
  kind: "ticket" as const,
  runId: "wrun_stalled",
  state: "bound" as const,
  createdAt: now - 60 * 60_000,
  updatedAt: now - 60 * 60_000,
};
const registry = {} as RunRegistryAdapter;

function page(data: unknown[]) {
  return { data, cursor: null, hasMore: false };
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    stepId: "step_01M0J1WXT6K5Q6Q9T3DJED252E",
    stepName: "step//./src/sandbox/poll-agent//checkPhaseDone",
    status: "running",
    attempt: 3,
    createdAt: stepCreatedAt,
    startedAt: new Date("2026-08-21T11:57:54.845Z"),
    updatedAt: new Date("2026-08-21T12:16:01.903Z"),
    ...overrides,
  };
}

let db: Db;

async function runRow() {
  const [row] = await db
    .select({
      status: workflowRuns.status,
      statusReason: workflowRuns.statusReason,
      completedAt: workflowRuns.completedAt,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, entry.runId));
  return row;
}

function tracker(status = "AI"): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn().mockResolvedValue({
      id: "ticket-id",
      identifier: "UP-4765",
      title: "Ticket",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: status,
      attachments: [],
    }),
    moveTicket: vi.fn(),
    postComment: vi.fn(),
    searchTickets: vi.fn(),
  };
}

let issueTracker: IssueTrackerAdapter;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowRuns).values({
    runId: entry.runId,
    status: "running",
    subjectKey: entry.subjectKey,
    ticketKey: entry.ticketKey,
  });
  issueTracker = tracker();
  mocks.hostedStatus = "running";
  mocks.statusError = null;
  mocks.listSteps.mockReset().mockResolvedValue(page([step()]));
  mocks.cancelRunDetailed
    .mockReset()
    .mockResolvedValue({ cancelled: false, released: false, tornDown: true });
  mocks.cancelSubjectRunDetailed
    .mockReset()
    .mockResolvedValue({ cancelled: true, released: true, tornDown: true });
  assertOwner.mockReset().mockResolvedValue(undefined);
  mocks.warn.mockReset();
  mocks.info.mockReset();
});

function warned(): string[] {
  return mocks.warn.mock.calls.map((call) => call[1] as string);
}

function executeFinalFence() {
  mocks.cancelRunDetailed.mockImplementationOnce(async (...args: unknown[]) => {
    const fence = args[7];
    if (typeof fence !== "function") throw new Error("missing final fence");
    try {
      await fence({
        subjectKey: entry.subjectKey,
        ownerToken: entry.ownerToken,
        runId: entry.runId,
      });
      return { cancelled: true, released: true, tornDown: true };
    } catch {
      return { cancelled: false, released: false, tornDown: true };
    }
  });
}

describe("findStalledStep", () => {
  it("asks for the newest step only", async () => {
    await findStalledStep(entry.runId, now);
    expect(mocks.listSteps).toHaveBeenCalledWith({
      runId: entry.runId,
      resolveData: "none",
      pagination: { limit: 1, sortOrder: "desc" },
    });
  });

  it("reports the newest step when it has been running past the ceiling", async () => {
    await expect(findStalledStep(entry.runId, now)).resolves.toEqual({
      stepId: "step_01M0J1WXT6K5Q6Q9T3DJED252E",
      stepName: "step//./src/sandbox/poll-agent//checkPhaseDone",
      attempt: 3,
      createdAt: stepCreatedAt,
    });
  });

  it("ignores a running step still inside the ceiling", async () => {
    mocks.listSteps.mockResolvedValue(
      page([step({ createdAt: new Date(now - STALLED_STEP_AFTER_MS) })]),
    );
    await expect(findStalledStep(entry.runId, now)).resolves.toBeNull();
  });

  it("ignores a run whose newest step completed (between steps is not a stall)", async () => {
    mocks.listSteps.mockResolvedValue(page([step({ status: "completed" })]));
    await expect(findStalledStep(entry.runId, now)).resolves.toBeNull();
  });

  it("ignores a run with no steps yet", async () => {
    mocks.listSteps.mockResolvedValue(page([]));
    await expect(findStalledStep(entry.runId, now)).resolves.toBeNull();
  });

  it("ignores a stalled step with incomplete metadata", async () => {
    mocks.listSteps.mockResolvedValue(page([step({ attempt: undefined })]));
    await expect(findStalledStep(entry.runId, now)).resolves.toBeNull();
  });
});

describe("reconcileStalledRun", () => {
  it("does nothing for a claim that is not bound", async () => {
    await expect(
      reconcileStalledRun({
        entry: { ...entry, state: "parking" },
        runRegistry: registry,
        db,
        now,
      }),
    ).resolves.toBe(false);

    expect(mocks.listSteps).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("running");
  });

  it("fails the run with a reason and cancels it through the ticket path", async () => {
    const onReleased = vi.fn();

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        onSubjectReleased: onReleased,
        now,
      }),
    ).resolves.toBe(true);

    const row = await runRow();
    expect(row.status).toBe("failed");
    expect(row.statusReason).toContain('step "checkPhaseDone"');
    expect(row.statusReason).toContain("32 minutes");
    expect(row.statusReason).toContain("attempt 3");
    expect(row.completedAt).not.toBeNull();
    expect(mocks.cancelRunDetailed).toHaveBeenCalledWith(
      "UP-4765",
      { ownerToken: "owner-a", runId: "wrun_stalled" },
      registry,
      issueTracker,
      "Backlog",
      onReleased,
      row.statusReason,
      expect.any(Function),
    );
    expect(mocks.cancelSubjectRunDetailed).not.toHaveBeenCalled();
    expect(warned()).toEqual(
      expect.arrayContaining([
        "stall_watchdog_detected_dead_engine",
        "stall_watchdog_cancelled_stalled_run",
      ]),
    );
  });

  it("preserves a live Review/Done destination despite a requested Backlog move", async () => {
    issueTracker = tracker("Review");
    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(true);

    expect(mocks.cancelRunDetailed).toHaveBeenCalledWith(
      "UP-4765",
      expect.anything(),
      registry,
      issueTracker,
      "Backlog",
      undefined,
      expect.stringContaining("Run engine stalled"),
      expect.any(Function),
    );
    expect(mocks.info.mock.calls.map((call) => call[1] as string)).toContain(
      "stall_watchdog_preserved_ticket_destination",
    );
  });

  it("preserves AI to Review between the initial read and the final fence", async () => {
    const fetchTicket = vi.fn()
      .mockResolvedValueOnce({ trackerStatus: "AI" })
      .mockResolvedValueOnce({ trackerStatus: "Review" });
    const moveTicket = vi.fn();
    issueTracker = {
      fetchTicket,
      moveTicket,
      postComment: vi.fn(),
      searchTickets: vi.fn(),
    } as unknown as IssueTrackerAdapter;
    executeFinalFence();

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(true);

    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(moveTicket).not.toHaveBeenCalled();
    expect(assertOwner).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        subjectKey: entry.subjectKey,
        ownerToken: entry.ownerToken,
        runId: entry.runId,
      }),
      "cancelling",
    );
  });

  it("evicts Review to AI before releasing the torn-down owner", async () => {
    const fetchTicket = vi.fn()
      .mockResolvedValueOnce({ trackerStatus: "Review" })
      .mockResolvedValueOnce({ trackerStatus: "AI" });
    const moveTicket = vi.fn();
    issueTracker = {
      fetchTicket,
      moveTicket,
      postComment: vi.fn(),
      searchTickets: vi.fn(),
    } as unknown as IssueTrackerAdapter;
    executeFinalFence();

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(true);

    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(moveTicket).toHaveBeenCalledWith("UP-4765", "Backlog");
    expect((await runRow()).status).toBe("failed");
    await expect(mocks.cancelRunDetailed.mock.results[0]?.value).resolves.toEqual({
      cancelled: true,
      released: true,
      tornDown: true,
    });
  });

  it("retains the torn-down owner when the final Jira read is unavailable", async () => {
    const fetchTicket = vi.fn()
      .mockResolvedValueOnce({ trackerStatus: "AI" })
      .mockRejectedValueOnce(new Error("jira read lost"));
    const moveTicket = vi.fn();
    issueTracker = {
      fetchTicket,
      moveTicket,
      postComment: vi.fn(),
      searchTickets: vi.fn(),
    } as unknown as IssueTrackerAdapter;
    executeFinalFence();

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(true);

    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(moveTicket).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("failed");
    await expect(mocks.cancelRunDetailed.mock.results[0]?.value).resolves.toEqual({
      cancelled: false,
      released: false,
      tornDown: true,
    });
  });

  it("retains the owner when watchdog failure persistence throws", async () => {
    const persist = vi
      .spyOn(runTelemetry, "markRunFailedByWatchdog")
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(false);

    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("running");
    expect(warned()).toContain("stall_watchdog_status_write_failed");
    persist.mockRestore();
  });

  it("retains the owner when a Jira ticket has no live tracker", async () => {
    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(false);

    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("running");
    expect(warned()).toContain("stall_watchdog_ticket_tracker_missing");
  });

  it("retains the owner when a live Jira read fails", async () => {
    vi.mocked(issueTracker.fetchTicket).mockRejectedValueOnce(new Error("jira 503"));

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(false);

    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("running");
    expect(warned()).toContain("stall_watchdog_ticket_state_unreachable");
  });

  it.each(["typed error", "error code"])(
    "settles a deleted Jira ticket when the initial read returns a %s",
    async (notFoundShape) => {
      const notFound = notFoundShape === "typed error"
        ? new IssueTrackerNotFoundError("Jira issue", entry.ticketKey!)
        : Object.assign(new Error("gone"), { code: "NOT_FOUND" });
      const fetchTicket = vi.fn().mockRejectedValue(notFound);
      const moveTicket = vi.fn();
      issueTracker = {
        fetchTicket,
        moveTicket,
        postComment: vi.fn(),
        searchTickets: vi.fn(),
      } as unknown as IssueTrackerAdapter;
      executeFinalFence();

      await expect(
        reconcileStalledRun({
          entry,
          runRegistry: registry,
          db,
          issueTracker,
          moveTarget: "Backlog",
          now,
        }),
      ).resolves.toBe(true);

      expect((await runRow()).status).toBe("failed");
      expect(mocks.cancelRunDetailed).toHaveBeenCalledWith(
        entry.ticketKey,
        expect.anything(),
        registry,
        issueTracker,
        "Backlog",
        undefined,
        expect.stringContaining("Run engine stalled"),
        expect.any(Function),
      );
      expect(fetchTicket).toHaveBeenCalledTimes(2);
      expect(moveTicket).not.toHaveBeenCalled();
      expect(assertOwner).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          subjectKey: entry.subjectKey,
          ownerToken: entry.ownerToken,
          runId: entry.runId,
        }),
        "cancelling",
      );
    },
  );

  it("retains the owner when a live AI ticket has no safe move target", async () => {
    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        now,
      }),
    ).resolves.toBe(false);

    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("running");
    expect(warned()).toContain("stall_watchdog_ticket_move_target_missing");
  });

  it("cancels a ticketless subject on its own subject key", async () => {
    const prEntry = {
      ...entry,
      subjectKey: "pr:github:acme/app#9",
      ticketKey: null,
      kind: "pr_trigger" as const,
    };
    await db
      .update(workflowRuns)
      .set({ subjectKey: prEntry.subjectKey, ticketKey: null })
      .where(eq(workflowRuns.runId, entry.runId));

    await expect(
      reconcileStalledRun({ entry: prEntry, runRegistry: registry, db, now }),
    ).resolves.toBe(true);

    expect(mocks.cancelSubjectRunDetailed).toHaveBeenCalledWith(
      "pr:github:acme/app#9",
      { ownerToken: "owner-a", runId: "wrun_stalled" },
      registry,
      undefined,
      expect.stringContaining("Run engine stalled"),
    );
    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
  });

  it("leaves a run alone while its newest step is inside the ceiling", async () => {
    mocks.listSteps.mockResolvedValue(
      page([step({ createdAt: new Date(now - 5 * 60_000) })]),
    );

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        now,
      }),
    ).resolves.toBe(false);

    expect((await runRow()).status).toBe("running");
    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
    expect(mocks.cancelSubjectRunDetailed).not.toHaveBeenCalled();
  });

  it("does nothing when Workflow already reports the run terminal", async () => {
    mocks.hostedStatus = "cancelled";

    await expect(
      reconcileStalledRun({ entry, runRegistry: registry, db, now }),
    ).resolves.toBe(false);

    expect(mocks.listSteps).not.toHaveBeenCalled();
    expect((await runRow()).status).toBe("running");
  });

  it("retains the owner when the run status is unreachable", async () => {
    mocks.statusError = new Error("workflow api 503");

    await expect(
      reconcileStalledRun({ entry, runRegistry: registry, db, now }),
    ).resolves.toBe(false);

    expect(warned()).toContain("stall_watchdog_run_status_unreachable");
    expect((await runRow()).status).toBe("running");
  });

  it("retains the owner when the step list is unreachable", async () => {
    mocks.listSteps.mockRejectedValue(new Error("steps api 503"));

    await expect(
      reconcileStalledRun({ entry, runRegistry: registry, db, now }),
    ).resolves.toBe(false);

    expect(warned()).toContain("stall_watchdog_steps_unreachable");
    expect((await runRow()).status).toBe("running");
  });

  it("reports no action when the cancel never began, keeping the failed status for the retry", async () => {
    mocks.cancelRunDetailed.mockResolvedValue({ cancelled: false, released: false });

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(false);

    expect(warned()).toContain("stall_watchdog_cancel_unconfirmed");
    expect((await runRow()).status).toBe("failed");
  });

  it("retries cancellation when the prior watchdog failure has a later elapsed-minute reason", async () => {
    mocks.cancelRunDetailed
      .mockReset()
      .mockResolvedValueOnce({ cancelled: false, released: false })
      .mockResolvedValueOnce({ cancelled: true, released: true, tornDown: true });

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now,
      }),
    ).resolves.toBe(false);
    const firstReason = (await runRow()).statusReason;

    await expect(
      reconcileStalledRun({
        entry,
        runRegistry: registry,
        db,
        issueTracker,
        moveTarget: "Backlog",
        now: now + 60_000,
      }),
    ).resolves.toBe(true);

    const secondReason = (await runRow()).statusReason;
    expect(firstReason).toContain("32 minutes");
    expect(secondReason).toBe(firstReason);
    expect(mocks.cancelRunDetailed).toHaveBeenCalledTimes(2);
  });

  it("never overwrites a run that already settled on its own", async () => {
    await db
      .update(workflowRuns)
      .set({ status: "success" })
      .where(eq(workflowRuns.runId, entry.runId));

    await reconcileStalledRun({ entry, runRegistry: registry, db, now });

    expect((await runRow()).status).toBe("success");
    expect(mocks.cancelRunDetailed).not.toHaveBeenCalled();
  });
});
