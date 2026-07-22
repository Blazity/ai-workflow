import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketComment,
  type TicketContent,
} from "../adapters/issue-tracker/types.js";
import { activeRuns, clarificationRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { CLARIFICATION_NUDGE_MARKER } from "./comment-format.js";
import {
  answerHookClarification,
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "./hook-store.js";
import { resumeClarificationFromComments } from "./resume-from-comments.js";

const mocks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
}));

vi.mock("../../env.js", () => ({
  env: { COLUMN_AI: "AI", DASHBOARD_ORIGIN: "https://dash.example" },
}));
vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));

const TICKET = "AWT-1";
const SUBJECT = "ticket:jira:AWT-1";
const RUN = "run-asked";
const BOT = "bot-account";
const ASKED_AT = new Date("2026-07-20T12:00:00.000Z");
const AFTER = "2026-07-20T13:00:00.000Z";
const AFTER_LATER = "2026-07-20T14:00:00.000Z";
const BEFORE = "2026-07-20T11:00:00.000Z";

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
  await db
    .update(clarificationRequests)
    .set({ askedAt: ASKED_AT })
    .where(eq(clarificationRequests.id, prepared.id));
  await db.insert(activeRuns).values({
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    ownerToken: "owner-1",
    runId: RUN,
    state: "bound",
    runKind: "ticket",
  });
  return published;
}

function ticketWith(comments: TicketComment[], trackerStatus = "AI"): TicketContent {
  return {
    id: "1",
    identifier: TICKET,
    projectKey: "AWT",
    title: "Title",
    description: "Description",
    acceptanceCriteria: "",
    comments,
    labels: [],
    trackerStatus,
    attachments: [],
  };
}

function makeTracker(opts: {
  comments?: TicketComment[];
  trackerStatus?: string;
  botId?: () => Promise<string>;
  fetchTicket?: () => Promise<TicketContent>;
} = {}) {
  const ticket = ticketWith(opts.comments ?? [], opts.trackerStatus ?? "AI");
  return {
    fetchTicket: vi.fn(opts.fetchTicket ?? (async () => ticket)),
    postComment: vi.fn(async (_id: string, _comment: string) => null as string | null),
    getCurrentUserAccountId: vi.fn(opts.botId ?? (async () => BOT)),
  };
}

function run(tracker: ReturnType<typeof makeTracker>, allowNudge = false) {
  return resumeClarificationFromComments({
    db,
    issueTracker: tracker as unknown as IssueTrackerAdapter,
    ticketKey: TICKET,
    allowNudge,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.resumeHook.mockResolvedValue({ runId: RUN });
  mocks.getHookByToken.mockRejectedValue(new Error("hook consumed"));
  db = await createTestDb();
});

describe("resumeClarificationFromComments", () => {
  it("returns no_clarification when nothing is resumable", async () => {
    const tracker = makeTracker();
    const result = await run(tracker);
    expect(result).toEqual({ status: "no_clarification" });
    expect(tracker.fetchTicket).not.toHaveBeenCalled();
  });

  it("resumes a pending run with the composed comment answer", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "  Use Next.js  ", createdAt: AFTER },
      ],
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "resumed", runId: RUN });
    expect(mocks.resumeHook).toHaveBeenCalledWith(
      row.hookToken,
      expect.objectContaining({ answer: "Jane: Use Next.js", answeredById: "jira:human-1" }),
    );
    const stored = await getHookClarification(db, row.id);
    expect(stored).toMatchObject({
      status: "answered",
      answer: "Jane: Use Next.js",
      answeredById: "jira:human-1",
      answeredByLabel: "Jane (via Jira)",
    });
  });

  it("joins multiple commenters and attributes the last one", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "Prefer A", createdAt: AFTER },
        { author: "Bob", accountId: "human-2", body: "Actually B", createdAt: AFTER_LATER },
      ],
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "resumed", runId: RUN });
    const stored = await getHookClarification(db, row.id);
    expect(stored).toMatchObject({
      answer: "Jane: Prefer A\n\nBob: Actually B",
      answeredById: "jira:human-2",
      answeredByLabel: "Jane, Bob (via Jira)",
    });
  });

  it("ignores bot comments and comments posted before the question", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Bot", accountId: BOT, body: "the question", createdAt: AFTER },
        { author: "Early", accountId: "human-1", body: "unrelated", createdAt: BEFORE },
        { author: "Cara", accountId: "human-2", body: "the answer", createdAt: AFTER_LATER },
      ],
    });

    await run(tracker);

    const stored = await getHookClarification(db, row.id);
    expect(stored).toMatchObject({
      answer: "Cara: the answer",
      answeredById: "jira:human-2",
      answeredByLabel: "Cara (via Jira)",
    });
  });

  it("ignores comments without an account id", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Anon", body: "no account", createdAt: AFTER },
        { author: "Human", accountId: "human-1", body: "real answer", createdAt: AFTER_LATER },
      ],
    });

    await run(tracker);

    const stored = await getHookClarification(db, row.id);
    expect(stored).toMatchObject({
      answer: "Human: real answer",
      answeredByLabel: "Human (via Jira)",
    });
  });

  it("fails closed and skips the nudge when bot identity is unavailable", async () => {
    await seedPending();
    const tracker = makeTracker({
      botId: async () => "",
      comments: [
        { author: "Jane", accountId: "human-1", body: "answer", createdAt: AFTER },
      ],
    });

    const result = await run(tracker, true);

    expect(result).toEqual({ status: "no_answer_comments", nudged: false });
    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });

  it("nudges once when allowed and no answers are present", async () => {
    await seedPending();
    const tracker = makeTracker({ comments: [] });

    const first = await run(tracker, true);
    expect(first).toEqual({ status: "no_answer_comments", nudged: true });
    expect(tracker.postComment).toHaveBeenCalledTimes(1);
    expect(tracker.postComment.mock.calls[0]?.[1]).toContain(CLARIFICATION_NUDGE_MARKER);

    // Second pass: the nudge is now present, so it must not repost.
    const withNudge = makeTracker({
      comments: [
        { author: "Bot", accountId: BOT, body: `... ${CLARIFICATION_NUDGE_MARKER} ...`, createdAt: AFTER },
      ],
    });
    const second = await run(withNudge, true);
    expect(second).toEqual({ status: "no_answer_comments", nudged: false });
    expect(withNudge.postComment).not.toHaveBeenCalled();
  });

  it("never nudges when nudging is disallowed", async () => {
    await seedPending();
    const tracker = makeTracker({ comments: [] });

    const result = await run(tracker, false);

    expect(result).toEqual({ status: "no_answer_comments", nudged: false });
    expect(tracker.postComment).not.toHaveBeenCalled();
  });

  it("does not commit when the live ticket is outside the AI column", async () => {
    await seedPending();
    const tracker = makeTracker({
      trackerStatus: "Backlog",
      comments: [
        { author: "Jane", accountId: "human-1", body: "answer", createdAt: AFTER },
      ],
    });

    const result = await run(tracker, true);

    expect(result).toEqual({ status: "not_in_ai_column" });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(tracker.getCurrentUserAccountId).not.toHaveBeenCalled();
  });

  it("retries a stored answer whose resume was lost", async () => {
    const row = await seedPending();
    await answerHookClarification(db, row.id, "Stored answer", { id: "user_1", label: "Ada" });
    const tracker = makeTracker();

    const result = await run(tracker);

    expect(result).toEqual({ status: "resumed", runId: RUN });
    expect(mocks.resumeHook).toHaveBeenCalledWith(
      row.hookToken,
      expect.objectContaining({ answer: "Stored answer", answeredById: "user_1" }),
    );
  });

  it("treats a consumed hook on an answered row as won", async () => {
    const row = await seedPending();
    await answerHookClarification(db, row.id, "Stored answer", { id: "user_1", label: "Ada" });
    mocks.resumeHook.mockRejectedValueOnce(new Error("already consumed"));
    const tracker = makeTracker();

    const result = await run(tracker);

    expect(result).toEqual({ status: "resumed", runId: RUN });
  });

  it("acknowledges a dashboard winner when it loses the CAS race", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      fetchTicket: async () => {
        // Simulate a dashboard answer landing between our read and our CAS.
        await answerHookClarification(db, row.id, "dashboard answer", {
          id: "user_9",
          label: "Dana Dashboard",
        });
        return ticketWith([
          { author: "Jane", accountId: "human-1", body: "answer", createdAt: AFTER },
        ]);
      },
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "already_answered" });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(tracker.postComment).toHaveBeenCalledTimes(1);
    expect(tracker.postComment.mock.calls[0]?.[1]).toContain("Dana Dashboard");
  });

  it("stays silent when the CAS winner is another Jira comment answer", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      fetchTicket: async () => {
        await answerHookClarification(db, row.id, "other jira answer", {
          id: "jira:other-human",
          label: "Bob (via Jira)",
        });
        return ticketWith([
          { author: "Jane", accountId: "human-1", body: "answer", createdAt: AFTER },
        ]);
      },
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "already_answered" });
    expect(tracker.postComment).not.toHaveBeenCalled();
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });

  it("retires the clarification when the ticket is gone", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      fetchTicket: async () => {
        throw new IssueTrackerNotFoundError("issue", TICKET);
      },
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "ticket_gone" });
    expect((await getHookClarification(db, row.id))?.status).toBe("superseded");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });
});
