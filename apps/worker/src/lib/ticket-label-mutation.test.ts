import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter, TicketContent } from "../adapters/issue-tracker/types.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import type { Db } from "../db/client.js";
import { activeRuns, ticketLabelMutationIntents, workflowRuns } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  createClarificationRequest,
  getClarification,
  reconcileClarificationPickupState,
} from "../clarifications/store.js";
import { ActiveRunOwnerError } from "./run-control-errors.js";
import { updateTicketLabelsWithIntent } from "./ticket-label-mutation.js";

const subjectKey = "ticket:jira:AIW-101";
const owner = { subjectKey, ownerToken: "owner-1", runId: "run-1" };
let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  const registry = new PostgresRunRegistry(db);
  await registry.reserve({
    subjectKey,
    ticketKey: "AIW-101",
    ownerToken: owner.ownerToken,
    kind: "ticket",
  });
  await registry.bindRun(subjectKey, owner.ownerToken, owner.runId);
  await registry.beginCancellation(subjectKey, owner.ownerToken, owner.runId);
});

function ticket(labels: string[]): TicketContent {
  return {
    id: "AIW-101",
    identifier: "AIW-101",
    title: "Ticket",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels,
    trackerStatus: "Backlog",
    attachments: [],
  };
}

function tracker(labels: string[], update?: ReturnType<typeof vi.fn>) {
  let currentLabels = [...labels];
  const updateLabels = update ?? vi.fn(async (
    _ticketKey: string,
    changes: { add?: string[]; remove?: string[] },
  ) => {
    currentLabels = currentLabels.filter((label) => !changes.remove?.includes(label));
    for (const label of changes.add ?? []) {
      if (!currentLabels.includes(label)) currentLabels.push(label);
    }
  });
  return {
    adapter: {
      fetchTicket: vi.fn(async () => ticket(currentLabels)),
      moveTicket: vi.fn(),
      postComment: vi.fn(),
      searchTickets: vi.fn(),
      updateLabels,
    } as unknown as IssueTrackerAdapter,
    updateLabels,
  };
}

describe("updateTicketLabelsWithIntent", () => {
  it("records and finishes an exact bound-owner label addition", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const issueTracker = tracker([]);

    await updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "bound",
      changes: { add: ["needs-clarification"] },
    });

    expect(issueTracker.updateLabels).toHaveBeenCalledWith("AIW-101", {
      add: ["needs-clarification"],
    });
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([
      expect.objectContaining({
        addLabels: ["needs-clarification"],
        providerStartedAt: expect.any(Date),
        providerFinishedAt: expect.any(Date),
      }),
    ]);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      state: "bound",
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 1,
    });
  });

  it("confirms an already-satisfied label under the exact owner without opening a provider boundary", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const issueTracker = tracker(["needs-clarification"]);

    await updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "bound",
      changes: { add: ["needs-clarification"] },
    });

    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([]);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      state: "bound",
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 0,
    });
  });

  it("records and finishes an exact reserved-owner label removal", async () => {
    const reservedSubjectKey = "ticket:jira:AIW-102";
    const reservedOwner = {
      subjectKey: reservedSubjectKey,
      ownerToken: "owner-reserved",
      runId: null,
    };
    const registry = new PostgresRunRegistry(db);
    await registry.reserve({
      subjectKey: reservedSubjectKey,
      ticketKey: "AIW-102",
      ownerToken: reservedOwner.ownerToken,
      kind: "ticket",
    });
    const issueTracker = tracker(["awaiting-approval"]);

    await updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-102",
      owner: reservedOwner,
      requiredOwnerState: "reserved",
      changes: { remove: ["awaiting-approval"] },
    });

    expect(issueTracker.updateLabels).toHaveBeenCalledWith("AIW-102", {
      remove: ["awaiting-approval"],
    });
    expect(
      (await db.select().from(activeRuns).where(eq(activeRuns.subjectKey, reservedSubjectKey)))[0],
    ).toMatchObject({
      state: "reserved",
      runId: null,
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 1,
    });
  });

  it("throws typed owner loss when cancellation wins before a bound mutation starts", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const registry = new PostgresRunRegistry(db);
    const issueTracker = tracker([]);
    vi.mocked(issueTracker.adapter.fetchTicket).mockImplementationOnce(async () => {
      expect(
        await registry.beginCancellation(subjectKey, owner.ownerToken, owner.runId),
      ).toBe(true);
      return ticket([]);
    });

    await expect(
      updateTicketLabelsWithIntent({
        db,
        issueTracker: issueTracker.adapter,
        ticketKey: "AIW-101",
        owner,
        requiredOwnerState: "bound",
        changes: { add: ["needs-clarification"] },
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([]);
  });

  it("throws typed owner loss when cancellation wins during an already-satisfied bound label read", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const registry = new PostgresRunRegistry(db);
    const issueTracker = tracker(["needs-clarification"]);
    vi.mocked(issueTracker.adapter.fetchTicket).mockImplementationOnce(async () => {
      expect(
        await registry.beginCancellation(subjectKey, owner.ownerToken, owner.runId),
      ).toBe(true);
      return ticket(["needs-clarification"]);
    });

    await expect(
      updateTicketLabelsWithIntent({
        db,
        issueTracker: issueTracker.adapter,
        ticketKey: "AIW-101",
        owner,
        requiredOwnerState: "bound",
        changes: { add: ["needs-clarification"] },
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([]);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      state: "cancelling",
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 0,
    });
  });

  it("does not supersede clarification state or telemetry when cancellation wins after a no-op label proof", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const pending = await createClarificationRequest(db, {
      ticketKey: "AIW-101",
      runId: "run-awaiting",
      questions: ["Which approach?"],
    });
    await db.insert(workflowRuns).values({
      runId: "run-awaiting",
      subjectKey,
      ticketKey: "AIW-101",
      status: "awaiting",
    });
    const issueTracker = tracker([]);

    await updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "bound",
      changes: { remove: ["needs-clarification"] },
    });

    const registry = new PostgresRunRegistry(db);
    expect(
      await registry.beginCancellation(subjectKey, owner.ownerToken, owner.runId),
    ).toBe(true);
    await expect(
      reconcileClarificationPickupState(db, {
        ticketKey: "AIW-101",
        currentRunId: owner.runId,
        owner,
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    expect((await getClarification(db, pending.id))?.status).toBe(
      "pending",
    );
    expect(
      (
        await db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.runId, "run-awaiting"))
      )[0]?.status,
    ).toBe("awaiting");
  });

  it("atomically reconciles pending clarification state and predecessor telemetry for the exact owner", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const pending = await createClarificationRequest(db, {
      ticketKey: "AIW-101",
      runId: "run-awaiting",
      questions: ["Which approach?"],
    });
    await db.insert(workflowRuns).values({
      runId: "run-awaiting",
      subjectKey,
      ticketKey: "AIW-101",
      status: "awaiting",
    });

    await expect(
      reconcileClarificationPickupState(db, {
        ticketKey: "AIW-101",
        currentRunId: owner.runId,
        owner,
      }),
    ).resolves.toEqual({ superseded: 1, resolvedAwaiting: 1 });

    expect((await getClarification(db, pending.id))?.status).toBe("superseded");
    expect(
      (
        await db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.runId, "run-awaiting"))
      )[0]?.status,
    ).toBe("success");
  });

  it("throws typed owner loss when handoff wins before a reserved mutation starts", async () => {
    const reservedSubjectKey = "ticket:jira:AIW-103";
    const reservedOwner = {
      subjectKey: reservedSubjectKey,
      ownerToken: "owner-before-handoff",
      runId: null,
    };
    const registry = new PostgresRunRegistry(db);
    await registry.reserve({
      subjectKey: reservedSubjectKey,
      ticketKey: "AIW-103",
      ownerToken: reservedOwner.ownerToken,
      kind: "ticket",
    });
    const issueTracker = tracker(["awaiting-approval"]);
    vi.mocked(issueTracker.adapter.fetchTicket).mockImplementationOnce(async () => {
      expect(
        await registry.handoff(
          reservedSubjectKey,
          reservedOwner.ownerToken,
          "owner-after-handoff",
        ),
      ).toBe(true);
      return ticket(["awaiting-approval"]);
    });

    await expect(
      updateTicketLabelsWithIntent({
        db,
        issueTracker: issueTracker.adapter,
        ticketKey: "AIW-103",
        owner: reservedOwner,
        requiredOwnerState: "reserved",
        changes: { remove: ["awaiting-approval"] },
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([]);
  });

  it("throws typed owner loss when handoff wins during an already-satisfied reserved label read", async () => {
    const reservedSubjectKey = "ticket:jira:AIW-103-NOOP";
    const reservedOwner = {
      subjectKey: reservedSubjectKey,
      ownerToken: "owner-before-noop-handoff",
      runId: null,
    };
    const registry = new PostgresRunRegistry(db);
    await registry.reserve({
      subjectKey: reservedSubjectKey,
      ticketKey: "AIW-103-NOOP",
      ownerToken: reservedOwner.ownerToken,
      kind: "ticket",
    });
    const issueTracker = tracker([]);
    vi.mocked(issueTracker.adapter.fetchTicket).mockImplementationOnce(async () => {
      expect(
        await registry.handoff(
          reservedSubjectKey,
          reservedOwner.ownerToken,
          "owner-after-noop-handoff",
        ),
      ).toBe(true);
      return ticket([]);
    });

    await expect(
      updateTicketLabelsWithIntent({
        db,
        issueTracker: issueTracker.adapter,
        ticketKey: "AIW-103-NOOP",
        owner: reservedOwner,
        requiredOwnerState: "reserved",
        changes: { remove: ["awaiting-approval"] },
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([]);
    expect(
      (await db.select().from(activeRuns).where(eq(activeRuns.subjectKey, reservedSubjectKey)))[0],
    ).toMatchObject({
      ownerToken: "owner-after-noop-handoff",
      state: "reserved",
      runId: null,
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 0,
    });
  });

  it("keeps a reserved handoff closed after the label mutation wins the start race", async () => {
    const reservedSubjectKey = "ticket:jira:AIW-104";
    const reservedOwner = {
      subjectKey: reservedSubjectKey,
      ownerToken: "owner-label-winner",
      runId: null,
    };
    const registry = new PostgresRunRegistry(db);
    await registry.reserve({
      subjectKey: reservedSubjectKey,
      ticketKey: "AIW-104",
      ownerToken: reservedOwner.ownerToken,
      kind: "ticket",
    });
    const issueTracker = tracker(["awaiting-approval"]);
    let fetchCount = 0;
    let announceStarted!: () => void;
    let resumeAfterFence!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const afterFence = new Promise<void>((resolve) => {
      resumeAfterFence = resolve;
    });
    vi.mocked(issueTracker.adapter.fetchTicket).mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 2) {
        announceStarted();
        await afterFence;
      }
      return ticket(["awaiting-approval"]);
    });

    const mutation = updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-104",
      owner: reservedOwner,
      requiredOwnerState: "reserved",
      changes: { remove: ["awaiting-approval"] },
    });
    await started;

    await expect(
      registry.handoff(
        reservedSubjectKey,
        reservedOwner.ownerToken,
        "owner-after-handoff",
      ),
    ).resolves.toBe(false);

    resumeAfterFence();
    await mutation;
    await expect(
      registry.handoff(
        reservedSubjectKey,
        reservedOwner.ownerToken,
        "owner-after-handoff",
      ),
    ).resolves.toBe(true);
  });

  it("keeps cancellation closed around an ambiguous bound-owner label addition", async () => {
    await db
      .update(activeRuns)
      .set({ state: "bound", ticketCancellationReconciledVersion: null })
      .where(eq(activeRuns.subjectKey, subjectKey));
    const issueTracker = tracker(
      [],
      vi.fn().mockRejectedValue(new Error("provider timed out")),
    );

    await expect(
      updateTicketLabelsWithIntent({
        db,
        issueTracker: issueTracker.adapter,
        ticketKey: "AIW-101",
        owner,
        requiredOwnerState: "bound",
        changes: { add: ["awaiting-approval"] },
      }),
    ).rejects.toThrow("provider timed out");

    const registry = new PostgresRunRegistry(db);
    await expect(
      registry.beginCancellation(subjectKey, owner.ownerToken, owner.runId),
    ).resolves.toBe(true);
    await expect(
      registry.releaseCancellation(subjectKey, owner.ownerToken, owner.runId, {
        latestFenceId: null,
        mutationVersion: 1,
      }),
    ).resolves.toBe(false);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      state: "cancelling",
      ticketProviderCallsInFlight: 1,
      ticketMutationVersion: 1,
    });
  });

  it("supports an exact parked-owner label addition without allowing a handoff race", async () => {
    const parkedSubjectKey = "ticket:jira:AIW-102";
    await db.insert(activeRuns).values({
      subjectKey: parkedSubjectKey,
      ticketKey: "AIW-102",
      ownerToken: "owner-parked",
      runId: "run-parked",
      state: "parked",
      runKind: "ticket",
    });
    const issueTracker = tracker([]);

    await updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-102",
      owner: {
        subjectKey: parkedSubjectKey,
        ownerToken: "owner-parked",
        runId: "run-parked",
      },
      requiredOwnerState: "parked",
      changes: { add: ["needs-clarification"] },
    });

    expect(issueTracker.updateLabels).toHaveBeenCalledWith("AIW-102", {
      add: ["needs-clarification"],
    });
    expect(
      (await db.select().from(activeRuns).where(eq(activeRuns.subjectKey, parkedSubjectKey)))[0],
    ).toMatchObject({ ticketProviderCallsInFlight: 0, ticketMutationVersion: 1 });
  });

  it("throws typed owner loss when handoff wins during an already-satisfied parked label read", async () => {
    const parkedSubjectKey = "ticket:jira:AIW-102-NOOP";
    const parkedOwner = {
      subjectKey: parkedSubjectKey,
      ownerToken: "owner-parked-noop",
      runId: "run-parked-noop",
    };
    await db.insert(activeRuns).values({
      subjectKey: parkedSubjectKey,
      ticketKey: "AIW-102-NOOP",
      ownerToken: parkedOwner.ownerToken,
      runId: parkedOwner.runId,
      state: "parked",
      runKind: "ticket",
    });
    const registry = new PostgresRunRegistry(db);
    const issueTracker = tracker(["needs-clarification"]);
    vi.mocked(issueTracker.adapter.fetchTicket).mockImplementationOnce(async () => {
      expect(
        await registry.handoffBoundRun(
          parkedSubjectKey,
          parkedOwner.ownerToken,
          parkedOwner.runId,
          "owner-after-parked-noop-handoff",
        ),
      ).toBe(true);
      return ticket(["needs-clarification"]);
    });

    await expect(
      updateTicketLabelsWithIntent({
        db,
        issueTracker: issueTracker.adapter,
        ticketKey: "AIW-102-NOOP",
        owner: parkedOwner,
        requiredOwnerState: "parked",
        changes: { add: ["needs-clarification"] },
      }),
    ).rejects.toBeInstanceOf(ActiveRunOwnerError);

    expect(issueTracker.updateLabels).not.toHaveBeenCalled();
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([]);
    expect(
      (await db.select().from(activeRuns).where(eq(activeRuns.subjectKey, parkedSubjectKey)))[0],
    ).toMatchObject({
      ownerToken: "owner-after-parked-noop-handoff",
      state: "reserved",
      runId: null,
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 0,
    });
  });

  it("records and finishes an exact cancelling-owner label removal", async () => {
    const issueTracker = tracker(["needs-clarification", "customer-priority"]);

    await updateTicketLabelsWithIntent({
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "cancelling",
      changes: { remove: ["needs-clarification"] },
    });

    expect(issueTracker.updateLabels).toHaveBeenCalledWith("AIW-101", {
      remove: ["needs-clarification"],
    });
    expect(await db.select().from(ticketLabelMutationIntents)).toEqual([
      expect.objectContaining({
        removeLabels: ["needs-clarification"],
        providerStartedAt: expect.any(Date),
        providerFinishedAt: expect.any(Date),
      }),
    ]);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      ticketProviderCallsInFlight: 0,
      ticketMutationVersion: 1,
    });
  });

  it("retains an ambiguous provider failure without positive live-state proof", async () => {
    const updateLabels = vi.fn().mockRejectedValue(new Error("provider timed out"));
    const issueTracker = tracker(["needs-clarification"], updateLabels);
    const input = {
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "cancelling" as const,
      changes: { remove: ["needs-clarification"] },
    };

    await expect(updateTicketLabelsWithIntent(input)).rejects.toThrow("provider timed out");
    await expect(updateTicketLabelsWithIntent(input)).rejects.toThrow(
      /label mutation is still in flight/i,
    );

    expect(updateLabels).toHaveBeenCalledTimes(1);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      ticketProviderCallsInFlight: 1,
    });
  });

  it("keeps an expired ambiguity fenced without positive live-state proof", async () => {
    const updateLabels = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider timed out"))
      .mockResolvedValueOnce(undefined);
    const issueTracker = tracker(["needs-clarification"], updateLabels);
    const input = {
      db,
      issueTracker: issueTracker.adapter,
      ticketKey: "AIW-101",
      owner,
      requiredOwnerState: "cancelling" as const,
      changes: { remove: ["needs-clarification"] },
    };
    await expect(updateTicketLabelsWithIntent(input)).rejects.toThrow("provider timed out");
    await db
      .update(ticketLabelMutationIntents)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(ticketLabelMutationIntents.subjectKey, subjectKey));

    await expect(updateTicketLabelsWithIntent(input)).rejects.toThrow(
      /label mutation is still in flight/i,
    );

    expect(updateLabels).toHaveBeenCalledTimes(1);
    expect(
      (await db.select().from(ticketLabelMutationIntents)).every(
        (intent) => intent.providerFinishedAt === null,
      ),
    ).toBe(true);
    expect((await db.select().from(activeRuns))[0]).toMatchObject({
      ticketProviderCallsInFlight: 1,
      ticketMutationVersion: 1,
    });
    const registry = new PostgresRunRegistry(db);
    await expect(
      registry.releaseCancellation(subjectKey, owner.ownerToken, owner.runId, {
        latestFenceId: null,
        mutationVersion: 1,
      }),
    ).resolves.toBe(false);
  });
});
