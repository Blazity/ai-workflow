import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import type {
  IssueTrackerAdapter,
  IssueTrackerMoveTarget,
} from "../adapters/issue-tracker/types.js";
import { activeRuns, ticketTransitionIntents } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { reconcileTicketCancellationAfterDrain } from "./ticket-cancellation-reconciliation.js";
import {
  beginTicketTransitionIntent,
  finishTicketTransitionIntent,
  recordTicketCancellationFence,
  recordTicketTransitionIntent,
} from "./ticket-transition-intent-store.js";
import { moveTicketWithIntent } from "./ticket-transition.js";

it("restores a human Jira move after the already-started workflow move and label add drain", async () => {
  const db = await createTestDb();
  const owner = {
    subjectKey: "ticket:jira:AIW-101",
    ownerToken: "owner-1",
    runId: "run-1",
  };
  await db.insert(activeRuns).values({
    ...owner,
    ticketKey: "AIW-101",
    state: "bound",
    runKind: "ticket",
  });

  let status = { name: "In Progress", id: "3" };
  let labels = ["customer-priority"];
  let releaseWorkflowMove!: () => void;
  const workflowMoveMayFinish = new Promise<void>((resolve) => {
    releaseWorkflowMove = resolve;
  });
  const moveTicket = vi.fn(
    async (_ticketKey: string, target: IssueTrackerMoveTarget) => {
      const normalized =
        typeof target === "string"
          ? { name: target, id: undefined }
          : { name: target.name, id: target.statusId };
      if (normalized.name === "AI Review") await workflowMoveMayFinish;
      status = { name: normalized.name, id: normalized.id ?? "" };
    },
  );
  const issueTracker = {
    fetchTicket: vi.fn(async () => ({
      trackerStatus: status.name,
      trackerStatusId: status.id,
      labels: [...labels],
    })),
    moveTicket,
    updateLabels: vi.fn(
      async (_ticketKey: string, changes: { remove?: string[] }) => {
        labels = labels.filter((label) => !changes.remove?.includes(label));
      },
    ),
    getCurrentUserAccountId: vi.fn().mockResolvedValue("jira-bot-account"),
  } as unknown as IssueTrackerAdapter;

  const inFlightWorkflowMove = moveTicketWithIntent({
    db,
    issueTracker,
    ticketKey: "AIW-101",
    target: { name: "AI Review", statusId: "10020" },
    owner,
  });
  await vi.waitFor(() => expect(moveTicket).toHaveBeenCalledOnce());

  // The human destination wins cancellation, but the provider call and label
  // add had already crossed their owner fences and land while the run closes.
  status = { name: "Backlog", id: "10001" };
  await recordTicketCancellationFence(db, {
    ticketKey: "AIW-101",
    ...owner,
    target: { name: "Backlog", statusId: "10001" },
    webhookIdentifier: "jira-human-move-1",
    occurredAt: new Date(),
  });
  await db
    .update(activeRuns)
    .set({ state: "cancelling" })
    .where(eq(activeRuns.subjectKey, owner.subjectKey));
  labels = [
    "customer-priority",
    "needs-clarification",
    "awaiting-approval",
  ];
  releaseWorkflowMove();
  await inFlightWorkflowMove;

  await reconcileTicketCancellationAfterDrain({
    db,
    issueTracker,
    ticketKey: "AIW-101",
    owner,
  });

  expect(status).toEqual({ name: "Backlog", id: "10001" });
  expect(labels).toEqual(["customer-priority"]);
  expect(moveTicket).toHaveBeenNthCalledWith(1, "AIW-101", {
    name: "AI Review",
    statusId: "10020",
  });
  expect(moveTicket).toHaveBeenNthCalledWith(2, "AIW-101", {
    name: "Backlog",
    statusId: "10001",
  });
});

it("does not release a bound owner while a concurrent compensating Jira move is unresolved", async () => {
  const db = await createTestDb();
  const owner = {
    subjectKey: "ticket:jira:AIW-102",
    ownerToken: "owner-2",
    runId: "run-2",
  };
  await db.insert(activeRuns).values({
    ...owner,
    ticketKey: "AIW-102",
    state: "bound",
    runKind: "ticket",
  });
  const workflowIntent = await recordTicketTransitionIntent(db, {
    ticketKey: "AIW-102",
    ...owner,
    actorAccountId: "jira-bot-account",
    target: { name: "AI Review", statusId: "10020" },
  });
  await beginTicketTransitionIntent(db, workflowIntent, owner);
  await recordTicketCancellationFence(db, {
    ticketKey: "AIW-102",
    ...owner,
    target: { name: "Backlog", statusId: "10001" },
    webhookIdentifier: "jira-human-move-2",
    occurredAt: new Date(),
  });
  await db
    .update(activeRuns)
    .set({ state: "cancelling" })
    .where(eq(activeRuns.subjectKey, owner.subjectKey));
  await finishTicketTransitionIntent(db, workflowIntent);

  let status = { name: "AI Review", id: "10020" };
  let releaseCompensation!: () => void;
  const compensationMayFinish = new Promise<void>((resolve) => {
    releaseCompensation = resolve;
  });
  const moveTicket = vi.fn(async () => {
    await compensationMayFinish;
    status = { name: "Backlog", id: "10001" };
  });
  const issueTracker = {
    fetchTicket: vi.fn(async () => ({
      trackerStatus: status.name,
      trackerStatusId: status.id,
      labels: [],
    })),
    moveTicket,
    updateLabels: vi.fn(),
    getCurrentUserAccountId: vi.fn().mockResolvedValue("jira-bot-account"),
  } as unknown as IssueTrackerAdapter;

  const firstReconciliation = reconcileTicketCancellationAfterDrain({
    db,
    issueTracker,
    ticketKey: "AIW-102",
    owner,
  });
  await vi.waitFor(() => expect(moveTicket).toHaveBeenCalledOnce());

  await expect(
    reconcileTicketCancellationAfterDrain({
      db,
      issueTracker,
      ticketKey: "AIW-102",
      owner,
    }),
  ).rejects.toThrow(/provider transition is still in flight/i);

  releaseCompensation();
  await firstReconciliation;
  expect(status).toEqual({ name: "Backlog", id: "10001" });
});

it("keeps an expired ambiguity quarantined, then restores after a positively observed late landing", async () => {
  const db = await createTestDb();
  const owner = {
    subjectKey: "ticket:jira:AIW-103",
    ownerToken: "owner-3",
    runId: "run-3",
  };
  await db.insert(activeRuns).values({
    ...owner,
    ticketKey: "AIW-103",
    state: "bound",
    runKind: "ticket",
  });
  const workflowIntent = await recordTicketTransitionIntent(db, {
    ticketKey: "AIW-103",
    ...owner,
    actorAccountId: "jira-bot-account",
    target: { name: "AI Review", statusId: "10020" },
  });
  await beginTicketTransitionIntent(db, workflowIntent, owner);
  await db
    .update(ticketTransitionIntents)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(ticketTransitionIntents.id, workflowIntent));
  await recordTicketCancellationFence(db, {
    ticketKey: "AIW-103",
    ...owner,
    target: { name: "Backlog", statusId: "10001" },
    webhookIdentifier: "jira-human-move-3",
    occurredAt: new Date(),
  });

  const backlog = {
    trackerStatus: "Backlog",
    trackerStatusId: "10001",
    labels: [],
  };
  const lateWorkflowDestination = {
    trackerStatus: "AI Review",
    trackerStatusId: "10020",
    labels: [],
  };
  let liveTicket = backlog;
  const fetchTicket = vi.fn(async () => liveTicket);
  const moveTicket = vi.fn(async () => {
    liveTicket = backlog;
  });
  const issueTracker = {
    fetchTicket,
    moveTicket,
    updateLabels: vi.fn(),
    getCurrentUserAccountId: vi.fn().mockResolvedValue("jira-bot-account"),
  } as unknown as IssueTrackerAdapter;

  await expect(
    reconcileTicketCancellationAfterDrain({
      db,
      issueTracker,
      ticketKey: "AIW-103",
      owner,
      now: new Date(),
    }),
  ).rejects.toThrow(/provider transition is still in flight/i);
  expect(moveTicket).not.toHaveBeenCalled();

  // The provider deadline was only a retention hint. Once Jira positively
  // shows the delayed workflow target, reconciliation may finish that evidence
  // and restore the human destination without ever releasing ambiguity early.
  liveTicket = lateWorkflowDestination;
  await reconcileTicketCancellationAfterDrain({
    db,
    issueTracker,
    ticketKey: "AIW-103",
    owner,
    now: new Date(),
  });

  expect(moveTicket).toHaveBeenCalledWith("AIW-103", {
    name: "Backlog",
    statusId: "10001",
  });
  expect(liveTicket).toEqual(backlog);
});
