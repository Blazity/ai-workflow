import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import type { IssueTrackerAdapter, TicketContent } from "../../adapters/issue-tracker/types.js";
import { activeRuns, clarificationRequests, workflowRuns } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { logger } from "../../infra/logger.js";
import { answerClarificationAndResume } from "./answer-core.js";
import {
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "../../clarifications/hook-store.js";

const mocks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
  cancelRunForOperator: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({
  env: { COLUMN_AI: "AI", DASHBOARD_ORIGIN: "https://dash.example" },
}));
vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
vi.mock("../run-lifecycle/cancel-run.js", () => ({
  cancelRunForOperator: (...args: unknown[]) => mocks.cancelRunForOperator(...args),
}));

const TICKET = "AWT-9";
const SUBJECT = "ticket:jira:AWT-9";
const RUN = "run-asked";
const ACTOR = { id: "user_1", label: "Ada" };

let db: Db;

async function seedPending() {
  const prepared = await prepareHookClarification(db, {
    ticketKey: TICKET,
    subjectKey: SUBJECT,
    runId: RUN,
    blockId: "question",
    definitionId: 1,
    definitionVersion: 1,
    questions: ["What framework?"],
  });
  const published = await publishHookClarification(db, prepared.id);
  await db.insert(activeRuns).values({
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    ownerToken: "owner-1",
    runId: RUN,
    state: "bound",
    runKind: "ticket",
  });
  await db.insert(workflowRuns).values({
    runId: RUN,
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    status: "awaiting",
  });
  return published;
}

function makeTracker() {
  const ticket: TicketContent = {
    id: "1",
    identifier: TICKET,
    projectKey: "AWT",
    title: "Title",
    description: "Description",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
  };
  return {
    fetchTicket: vi.fn(() => Promise.resolve(ticket)),
    moveTicket: vi.fn(() => Promise.resolve()),
    postComment: vi.fn((_id: string, _comment: string) => Promise.resolve(null as string | null)),
  };
}

/** One delivery attempt of `answer`, always against the row as it stands now. */
async function answer(tracker: ReturnType<typeof makeTracker>, id: string, text: string) {
  const row = await getHookClarification(db, id);
  if (!row) throw new Error("clarification vanished");
  return answerClarificationAndResume({
    db,
    row,
    rawAnswer: text,
    actor: ACTOR,
    issueTracker: tracker as unknown as Pick<
      IssueTrackerAdapter,
      "fetchTicket" | "moveTicket" | "postComment"
    >,
  });
}

function resumeFailureComments(tracker: ReturnType<typeof makeTracker>) {
  return tracker.postComment.mock.calls.filter(([, body]) =>
    body.includes("could not resume the paused run"),
  );
}

/** The three deliveries this bound allows, all of them failing. */
async function spendEveryAttempt(tracker: ReturnType<typeof makeTracker>, id: string) {
  const first = await answer(tracker, id, "Use Next.js");
  const second = await answer(tracker, id, "Use Next.js");
  const third = await answer(tracker, id, "Use Next.js");
  return [first.kind, second.kind, third.kind];
}

const EXHAUSTED_COMMENT = [
  "The answer to this clarification was received, but the AI workflow could not resume the paused run after 3 attempts, so the run was stopped.",
  "Last error: transport failed",
  "To retry, start a new run for this ticket.",
].join("\n\n");

beforeEach(async () => {
  vi.clearAllMocks();
  // A hook that still exists proves the resume never committed, which is the
  // retryable failure this bound applies to.
  mocks.getHookByToken.mockResolvedValue({ token: "hook" });
  mocks.resumeHook.mockRejectedValue(new Error("transport failed"));
  mocks.cancelRunForOperator.mockResolvedValue({
    outcome: "cancelled",
    scheduleOccurrenceSettled: null,
  });
  db = await createTestDb();
});

describe("answerClarificationAndResume resume attempts", () => {
  it("stops retrying an answered clarification after the third failed resume", async () => {
    const row = await seedPending();
    const tracker = makeTracker();

    expect(await spendEveryAttempt(tracker, row.id)).toEqual([
      "resume_failed_retryable",
      "resume_failed_retryable",
      "resume_exhausted",
    ]);
    expect(mocks.resumeHook).toHaveBeenCalledTimes(3);

    const [stored] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, row.id));
    expect(stored?.status).toBe("resume_failed");
    expect(stored?.resumeAttempts).toBe(3);
    expect(mocks.cancelRunForOperator).toHaveBeenCalledTimes(1);
  });

  it("surfaces the spent budget as a failed run and one ticket comment", async () => {
    const row = await seedPending();
    const tracker = makeTracker();

    await spendEveryAttempt(tracker, row.id);

    const [runRow] = await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN));
    expect(runRow?.status).toBe("failed");
    expect(runRow?.statusReason).toContain(row.id);
    expect(runRow?.statusReason).toContain("transport failed");

    const failures = resumeFailureComments(tracker);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[1]).toBe(EXHAUSTED_COMMENT);
  });

});

describe("answerClarificationAndResume terminal comment", () => {
  it("warns when the one terminal Jira comment attempt fails", async () => {
    const row = await seedPending();
    const tracker = makeTracker();
    tracker.postComment
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Jira comment denied"));
    const warn = vi.spyOn(logger, "warn");

    await spendEveryAttempt(tracker, row.id);

    expect(warn).toHaveBeenCalledWith(
      { ticketKey: TICKET, runId: RUN, error: "Jira comment denied" },
      "clarification_resume_exhausted_comment_failed",
    );
    expect(resumeFailureComments(tracker)).toHaveLength(1);
  });
});

describe("answerClarificationAndResume after a spent resume budget", () => {
  it("refuses another answer after the clarification becomes terminal", async () => {
    const row = await seedPending();
    const tracker = makeTracker();

    await spendEveryAttempt(tracker, row.id);

    mocks.resumeHook.mockClear();
    const retry = await answer(tracker, row.id, "Use Remix instead");

    expect(retry.kind).toBe("resume_terminal");
    expect(mocks.resumeHook).not.toHaveBeenCalled();

    const [stored] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, row.id));
    expect(stored?.status).toBe("resume_failed");
    expect(stored?.answer).toBe("Use Next.js");
    expect(stored?.resumeAttempts).toBe(3);
  });
});
