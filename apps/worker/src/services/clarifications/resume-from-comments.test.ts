import { asc, eq } from "drizzle-orm";
import { fakeAnswerReadingModel } from "../work-scope/read-answer.fake.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettingsSnapshot, type WorkScopeAskedRepository } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketComment,
  type TicketContent,
} from "../../adapters/issue-tracker/types.js";
import {
  activeRuns,
  clarificationRequests,
  repositories,
  workflowRuns,
  workScopeTrail,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { readWorkScope } from "../../db/repositories/work-scope.js";
import { MAX_ANSWER_LENGTH } from "./answer-core.js";
import { CLARIFICATION_NUDGE_MARKER } from "./comment-format.js";
import {
  answerHookClarification,
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "../../db/repositories/clarification-hooks.js";
import { resumeClarificationFromComments } from "./resume-from-comments.js";

const mocks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
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
const LATER_STILL = "2026-07-20T15:00:00.000Z";
const BEFORE = "2026-07-20T11:00:00.000Z";

let db: Db;

async function seedPending(
  askedRepositories?: WorkScopeAskedRepository[],
  questions: string[] = ["What framework?"],
) {
  const prepared = await prepareHookClarification(db, {
    ticketKey: TICKET,
    subjectKey: SUBJECT,
    runId: RUN,
    blockId: "question",
    definitionId: 1,
    definitionVersion: 1,
    questions,
    ...(askedRepositories ? { askedRepositories } : {}),
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
  await db.insert(workflowRuns).values({
    runId: RUN,
    subjectKey: SUBJECT,
    ticketKey: TICKET,
    status: "awaiting",
  });
  return published;
}

function ticketWith(
  comments: TicketComment[],
  trackerStatus = "AI",
  description = "Description",
  commentsComplete = true,
  commentsCompleteFrom?: string,
): TicketContent {
  return {
    id: "1",
    identifier: TICKET,
    projectKey: "AWT",
    title: "Title",
    description,
    acceptanceCriteria: "",
    comments,
    // What the adapter reports on every real read of a ticket it paged to the
    // end. The tests that care about a read which could not prove that pass
    // false here, and say so in their names.
    commentsComplete,
    // The narrower fact a read of a very long ticket still establishes: from
    // this instant on, the list is whole. Absent on the ordinary ticket above,
    // which has no need of it.
    ...(commentsCompleteFrom === undefined ? {} : { commentsCompleteFrom }),
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
  moveTicket?: () => Promise<void>;
  commentsComplete?: boolean;
  commentsCompleteFrom?: string;
} = {}) {
  const ticket = ticketWith(
    opts.comments ?? [],
    opts.trackerStatus ?? "AI",
    "Description",
    opts.commentsComplete ?? true,
    opts.commentsCompleteFrom,
  );
  return {
    fetchTicket: vi.fn(opts.fetchTicket ?? (async () => ticket)),
    moveTicket: vi.fn(opts.moveTicket ?? (async () => undefined)),
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
    aiColumn: "AI",
    // A STAND-IN FOR THE MODEL, so these rows prove what the Jira channel does
    // with a reading rather than that no provider is reachable from a test.
    answerReadingDeps: { generate: fakeAnswerReadingModel() },
    cancelSettings: defaultSettingsSnapshot(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.resumeHook.mockResolvedValue({ runId: RUN });
  mocks.getHookByToken.mockResolvedValue(null);
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
    // Read WITH the window, which is what makes the comments this decides on
    // provable. Every other ticket read in the deployment asks for no window
    // and costs one request; paying for pages on all of them is a provider rate
    // limit waiting to take down every run.
    expect(tracker.fetchTicket).toHaveBeenCalledWith(TICKET, {
      commentsSince: ASKED_AT.toISOString(),
    });
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

  it("resumes an empty-description ticket once across comment and move deliveries", async () => {
    const row = await seedPending();
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN)))[0]?.status,
    ).toBe("awaiting");
    let trackerStatus = "Backlog";
    const comments = [
      { author: "Jane", accountId: "human-1", body: "Use Next.js", createdAt: AFTER },
    ];
    const tracker = makeTracker({
      fetchTicket: async () => ticketWith(comments, trackerStatus, ""),
    });

    // The comment arrives while the ticket is still parked; comments alone do
    // not commit the answer.
    expect(await run(tracker)).toEqual({ status: "not_in_ai_column" });
    trackerStatus = "AI";
    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });
    // Jira may deliver the comment and the move-to-AI as separate webhook
    // deliveries. The second delivery observes the answered row, but must not
    // resume the same Workflow a second time after the first hook was consumed.
    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    expect((await getHookClarification(db, row.id))?.status).toBe("answered");
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN)))[0]?.status,
    ).toBe("running");
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

  // One of the three guards that let a named repository outside the question's
  // list be taken (A19c): words our own account wrote never become an answer,
  // so neither a hand-over nor a repository name in them can reach the record.
  it("never reads a delegation or a repository name out of a comment our bot wrote", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      comments: [
        {
          author: "Bot",
          accountId: BOT,
          body: "whatever you think is best, and github:acme/billing as well",
          createdAt: AFTER,
        },
        { author: "Cara", accountId: "human-2", body: "github:acme/api", createdAt: AFTER_LATER },
      ],
    });

    await run(tracker);

    const stored = await getHookClarification(db, row.id);
    expect(stored?.answer).toBe("Cara: github:acme/api");
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

  it("treats an empty/whitespace-only comment body as no answer and nudges", async () => {
    await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "   ", createdAt: AFTER },
      ],
    });

    const result = await run(tracker, true);

    expect(result).toEqual({ status: "no_answer_comments", nudged: true });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(tracker.postComment).toHaveBeenCalledTimes(1);
    expect(tracker.postComment.mock.calls[0]?.[1]).toContain(CLARIFICATION_NUDGE_MARKER);
  });

  it("caps the answeredBy label at 200 characters for many commenters", async () => {
    const row = await seedPending();
    const comments = Array.from({ length: 60 }, (_, i) => ({
      author: `Person ${i}`,
      accountId: `acct-${i}`,
      body: `answer ${i}`,
      createdAt: AFTER,
    }));
    const tracker = makeTracker({ comments });

    const result = await run(tracker);

    expect(result).toEqual({ status: "resumed", runId: RUN });
    const stored = await getHookClarification(db, row.id);
    expect(stored?.answeredByLabel?.length).toBe(200);
    expect(stored?.answeredByLabel?.startsWith("Person 0, Person 1")).toBe(true);
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

  it("nudges with a different sentence when the comments could not all be read", async () => {
    await seedPending();
    // The person's answer may be on the page this read never reached, so the
    // ordinary nudge would tell somebody who has answered that they have not.
    // Saying nothing instead leaves a run waiting in front of them with no
    // explanation at all, which is worse: they learn the system ignores them.
    const tracker = makeTracker({ comments: [], commentsComplete: false });

    const result = await run(tracker, true);

    expect(result).toEqual({ status: "no_answer_comments", nudged: true });
    const posted = tracker.postComment.mock.calls[0]?.[1] ?? "";
    expect(posted).toContain("more comments than the AI workflow can read back through");
    expect(posted).toContain(CLARIFICATION_NUDGE_MARKER);
  });

  it("composes no answer from a ticket whose comments could not all be read", async () => {
    await seedPending();
    // One person's words, out of a conversation we only saw part of. Recorded
    // as that one person's decision it is a decision nobody made.
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
      ],
      commentsComplete: false,
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "no_answer_comments", nudged: false });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });

  it("composes from a ticket too long to read whole when every comment since the question was read", async () => {
    const row = await seedPending();
    // The bound is on one read, not on the ticket. This one is read from its
    // newest end and reaches back past the question, so no comment that could
    // answer it is missing, and refusing to compose would take the comment
    // channel away from exactly the tickets people talk on most.
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "Use Next.js", createdAt: AFTER },
      ],
      commentsComplete: false,
      commentsCompleteFrom: BEFORE,
    });

    const result = await run(tracker, true);

    expect(result).toEqual({ status: "resumed", runId: RUN });
    expect((await getHookClarification(db, row.id))?.answer).toBe("Jane: Use Next.js");
  });

  it("composes nothing when the read of a long ticket starts after the question was asked", async () => {
    await seedPending();
    // Here the read only covers what was written an hour after the question, so
    // the gap sits exactly where the first answer to it would be. One person's
    // words out of that is still one half of a conversation.
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER_LATER },
      ],
      commentsComplete: false,
      commentsCompleteFrom: AFTER,
    });

    const result = await run(tracker, true);

    expect(result).toEqual({ status: "no_answer_comments", nudged: true });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    // Nudged, and told why this ticket is hard for us to read, rather than left
    // in silence.
    expect(tracker.postComment.mock.calls[0]?.[1] ?? "").toContain(
      "more comments than the AI workflow can read back through",
    );
  });

  it("posts nothing when the clarification that won the race cannot be read back", async () => {
    const row = await seedPending();
    const tracker = makeTracker({
      fetchTicket: async () => {
        // The row is gone by the time the CAS runs, so the answer conflicts and
        // there is nobody to name as the winner.
        await db.delete(clarificationRequests).where(eq(clarificationRequests.id, row.id));
        return ticketWith([
          { author: "Jane", accountId: "human-1", body: "answer", createdAt: AFTER },
        ]);
      },
    });

    const result = await run(tracker);

    expect(result).toEqual({ status: "already_answered" });
    // "Already answered by someone" on the strength of nothing, in the one case
    // where the winner may well be this very answer arriving twice.
    expect(tracker.postComment).not.toHaveBeenCalled();
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

  it("never moves the ticket for a comment-composed answer", async () => {
    await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "Use Next.js", createdAt: AFTER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });
    // The human's own column move was the commit gesture here.
    expect(tracker.moveTicket).not.toHaveBeenCalled();
  });

  it("releases the claim when the answered retry cannot re-sync the column", async () => {
    const row = await seedPending();
    await answerHookClarification(db, row.id, "Stored answer", { id: "user_1", label: "Ada" });
    const tracker = makeTracker({
      trackerStatus: "AI Backlog",
      moveTicket: async () => {
        throw new Error("Jira 502");
      },
    });

    expect(await run(tracker)).toEqual({ status: "resume_retry_pending", runId: RUN });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN)))[0]?.status,
    ).toBe("awaiting");
  });

  it("allows only one concurrent delivery to invoke resumeHook", async () => {
    const row = await seedPending();
    await answerHookClarification(db, row.id, "Stored answer", { id: "user_1", label: "Ada" });
    const tracker = makeTracker();
    let releaseResume!: () => void;
    let resumeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    mocks.resumeHook.mockImplementationOnce(async () => {
      resumeStarted();
      await released;
      return { runId: RUN };
    });

    const first = run(tracker);
    await started;
    const second = await run(tracker);

    expect(second).toEqual({ status: "resume_retry_pending", runId: RUN });
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    releaseResume();
    expect(await first).toEqual({ status: "resumed", runId: RUN });
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN)))[0]?.status,
    ).toBe("running");
  });

  it("restores retry eligibility when the claimed resume fails", async () => {
    const row = await seedPending();
    await answerHookClarification(db, row.id, "Stored answer", { id: "user_1", label: "Ada" });
    const tracker = makeTracker();
    mocks.resumeHook.mockRejectedValueOnce(new Error("transport failed"));
    mocks.getHookByToken.mockResolvedValueOnce({ token: row.hookToken });

    expect(await run(tracker)).toEqual({ status: "resume_retry_pending", runId: RUN });
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN)))[0]?.status,
    ).toBe("awaiting");

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
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

  it("never retries a clarification whose resume attempts are exhausted", async () => {
    const row = await seedPending();
    await answerHookClarification(db, row.id, "Stored answer", { id: "user_1", label: "Ada" });
    await db
      .update(clarificationRequests)
      .set({ status: "resume_failed", resumeAttempts: 3 })
      .where(eq(clarificationRequests.id, row.id));
    const tracker = makeTracker();

    expect(await run(tracker)).toEqual({ status: "no_clarification" });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(tracker.fetchTicket).not.toHaveBeenCalled();
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
    expect(
      (await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN)))[0]?.status,
    ).toBe("blocked");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
  });
});

describe("resumeClarificationFromComments writing a repository answer to the record", () => {
  const QUESTION = "Which repositories does this ticket touch?";
  const JANE = { kind: "person", actorId: "jira:human-1", actorLabel: "Jane (via Jira)" };

  // Every question in these tests spells the repository out in its own words, so
  // every ask carries `named`. Without it the record refuses to write anything a
  // person did not name (`engine/work-scope/decide.ts`, ABSENT MEANS NO), which
  // is a different rule being tested elsewhere.
  function asked(
    repositoryKey: string,
    askedBecause: WorkScopeAskedRepository["askedBecause"],
  ): WorkScopeAskedRepository[] {
    return [{ repositoryKey, askedBecause, named: true }];
  }

  async function seedCatalog() {
    await db.insert(repositories).values([
      { provider: "github", path: "acme/api", source: "manual", enabled: true },
      { provider: "github", path: "acme/docs", source: "manual", enabled: true },
    ]);
  }

  async function entriesOfSubject() {
    return (await readWorkScope(db, SUBJECT))?.entries ?? [];
  }

  async function trailEvents() {
    const rows = await db.select().from(workScopeTrail).orderBy(asc(workScopeTrail.id));
    return rows.map((row) => row.event);
  }

  /** The single row a declined answer leaves behind: an answer arrived, from
   *  these people, and no entry was written from it. Somebody reading this run
   *  later is looking at a question asked twice and this row is the reason.
   *  "unattributed" is that reason exactly: not that the words could not be
   *  read, but that they are more than one person's and so nobody's decision. */
  function declinedTrailRow(clarificationId: string, actorId: string, actorLabel: string) {
    return {
      kind: "question_answered",
      clarificationId,
      answer: { kind: "unattributed" },
      answeredBy: { kind: "person", actorId, actorLabel },
    };
  }

  beforeEach(seedCatalog);

  it("decides nothing when two people commented and the second one named a repository", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "moving this back to AI", createdAt: AFTER },
        {
          author: "Bob",
          accountId: "human-2",
          body: "heads up, github:acme/docs will need a follow-up",
          createdAt: AFTER_LATER,
        },
      ],
    });

    const result = await run(tracker);

    // ROUND 5. Neither comment answers the question: one is a note about moving
    // the ticket and the other is a heads up about a repository nobody asked
    // about. That used to wake the run, which then asked the same question over
    // again; now the words settle nothing, so NOTHING is decided or woken and
    // the question this person is still being asked stays open in front of
    // them, with the ticket back in the backlog it waited in.
    //
    // The authorship rule is untouched and still decides what may be recorded;
    // what changed is that an answer nobody could read no longer spends a run
    // cycle before saying so.
    expect(result).toEqual({ status: "answer_unclear", runId: RUN });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    expect(await getHookClarification(db, row.id)).toMatchObject({ status: "pending" });
    // And the people who commented are still told, on the ticket, that this
    // settled nothing. THE SENTENCE THEY GET IS THE WEAKER ONE, and that is the
    // cost of reading before counting: the words are read where they arrive,
    // before anybody knows how many people wrote them, so a reply that is BOTH
    // unreadable and written by two people is told it could not be read rather
    // than that it had two authors. The more specific sentence is still the one
    // a readable two-author answer gets, which is the case it was written for.
    const posted = tracker.postComment.mock.calls[0]?.[1] ?? "";
    expect(posted).toContain("Nothing has been recorded, and this question is still open");
    // The one move is back to the backlog, and the note says so: moving the
    // ticket into AI committed a reply that settled nothing, so the board must
    // not go on saying the agent is working while the run waits for them.
    const { COLUMN_BACKLOG } = defaultSettingsSnapshot();
    expect(tracker.moveTicket.mock.calls).toEqual([[TICKET, COLUMN_BACKLOG]]);
    expect(posted).toContain(`This ticket is back in the "${COLUMN_BACKLOG}" column while the question waits.`);
    // Neither the repository Bob happened to name nor the one nobody answered.
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    // AND NO TRAIL ROW EITHER, which is a change and a loss worth naming. The
    // row used to say an answer arrived and was not applied. Now nothing is
    // written, because nothing happened: the question is still pending and the
    // next poll tick may deliver these same comments again, so a row per
    // attempt would be a history of our retries rather than of anybody's
    // decisions. The symptom it was there to explain is also gone, because the
    // question is no longer asked twice; it is simply still open.
    await expect(trailEvents()).resolves.toEqual([]);
  });

  it("decides nothing when the second of two people wrote a clean answer, because nobody can tell which words were the answer", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        {
          author: "Jane",
          accountId: "human-1",
          body: "heads up, github:acme/docs will need a follow-up",
          createdAt: AFTER,
        },
        { author: "Bob", accountId: "human-2", body: "github:acme/api", createdAt: AFTER_LATER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([
      declinedTrailRow(row.id, "jira:human-2", "Jane, Bob (via Jira)"),
    ]);
  });

  it("counts the people whose words are in the answer, not the ones the cap cut off it", async () => {
    // Jane answers at length and Bob says something after her. The stored answer
    // only has room for Jane, so Bob's words never reach the run and never reach
    // the record's reader either. Counting him declines Jane's answer for words
    // it does not contain, and pins it on whoever's text the cap happened to cut.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const filler = "and the reason is that ".repeat(500);
    const tracker = makeTracker({
      comments: [
        {
          author: "Jane",
          accountId: "human-1",
          body: `github:acme/api ${filler}`.slice(0, MAX_ANSWER_LENGTH - 10),
          createdAt: AFTER,
        },
        { author: "Bob", accountId: "human-2", body: "thanks Jane", createdAt: AFTER_LATER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    const stored = await getHookClarification(db, row.id);
    // A whole comment or none of it, so the text and the count agree.
    expect(stored?.answer?.includes("thanks Jane")).toBe(false);
    expect(stored?.answeredByLabel).toBe("Jane (via Jira)");
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        decidedBy: JANE,
      }),
    ]);
  });

  it("records one person's answer when an automation commented under it, because an app is not a person", async () => {
    // The common shape of this bug: a Jira rule fires on the move into the AI
    // column and comments as an app. Counted as an author it declines every
    // answer on every ticket, and the only symptom anybody sees is the question
    // asked twice. Dropped in one place, so it leaves the composed answer and
    // the count together: the run also wakes on Jane's words alone.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
        {
          author: "Automation for Jira",
          accountId: "app-1",
          accountType: "app",
          body: "Status changed to AI by rule Move back",
          createdAt: AFTER_LATER,
        },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    expect(mocks.resumeHook).toHaveBeenCalledWith(
      row.hookToken,
      expect.objectContaining({
        answer: "Jane: github:acme/api",
        answeredById: "jira:human-1",
      }),
    );
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        decidedBy: JANE,
      }),
    ]);
  });

  it("decides nothing when the second author is a person on a service desk portal", async () => {
    // "customer" is somebody writing from a portal and "atlassian" is somebody
    // writing from Jira; both are people, and an account type nobody reports is
    // a person too. Only an app is not. Reading any of these three as an app
    // would silently drop real people's answers, which is the failure direction
    // that must not happen.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        {
          author: "Jane",
          accountId: "human-1",
          accountType: "atlassian",
          body: "let me check",
          createdAt: AFTER,
        },
        {
          author: "Customer",
          accountId: "human-2",
          accountType: "customer",
          body: "github:acme/api",
          createdAt: AFTER_LATER,
        },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([
      declinedTrailRow(row.id, "jira:human-2", "Jane, Customer (via Jira)"),
    ]);
  });

  it("records the repository one person named, as their own decision", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        rationale: "Named in the answer to a repository question.",
        decidedBy: JANE,
        decidedAt: expect.any(String),
      },
    ]);
    await expect(trailEvents()).resolves.toEqual([
      expect.objectContaining({ kind: "question_answered", clarificationId: row.id }),
      expect.objectContaining({ kind: "entry_written" }),
    ]);
  });

  it("records one person's refusal that says what it refuses", async () => {
    await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "none", createdAt: AFTER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "unavailable",
        unavailableReason: "not_enabled",
        origin: "person",
        decidedBy: JANE,
      }),
    ]);
  });

  it("records nothing from a comment that is a plain no, and says on the ticket what to write instead", async () => {
    // Nothing threads a ticket comment to our question. "no" is what somebody
    // writes to the comment above ours, and what a Jira rule posting as a named
    // user writes to nobody, and neither of them decided that this work leaves
    // out a repository for good. So the heaviest write in the feature does not
    // rest on it: the run resumes on the same words, the record keeps nothing,
    // and the ticket says what a person can write to have it kept.
    await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [{ author: "Jane", accountId: "human-1", body: "no", createdAt: AFTER }],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("reads as a plain no");
    // The keyword the question itself teaches, and the honest place to use it,
    // which is the next asking: this clarification is answered, and answering
    // it again under this comment reaches nothing.
    // The sentence this offers moved when the old one turned out to be false:
    // a comment IS how a ticket answers an open question, so what has no route
    // is a refusal written under one already answered (M3).
    expect(posted).toContain(
      'When the question comes back, answering "none" declines every repository it lists',
    );
    // And NOT the path route, because this question was raised about a
    // repository the catalog does not enable: the next run matches written
    // paths against the repositories it froze at its start, so a person sent to
    // write this one out would spend a second attempt on silence.
    expect(posted).not.toContain("write its full path in a comment here");
    expect(posted).toContain("the repositories screen");
  });

  it("tells the person when a bare question's answer left nothing behind, in the words that question used", async () => {
    // The loop this closes: "which repository should this ticket modify?" lists
    // nothing, so a no to it refuses nothing and records nothing, the run
    // resumes, finds nothing selected, and asks the identical question again.
    // Silently, until the delivery attempts are gone. Nobody is asked something
    // they have already answered without being told why.
    //
    // And told in the words they were given. "none of these" is meaningless
    // against a question that listed none of them, so this one asks for the
    // thing the question asked for, a repository path.
    await seedPending([], ["Which repository should this ticket modify?"]);
    const tracker = makeTracker({
      comments: [{ author: "Jane", accountId: "human-1", body: "no", createdAt: AFTER }],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository");
    expect(posted).toContain("Write the full path of the repository this work should use");
    // Not "none", which this question never offered and which would record
    // nothing against a question that listed no repository. A person told to
    // write a word that does nothing is worse off than one told nothing.
    expect(posted).not.toContain('"none"');
  });

  it("does not tell a ticket thumbs up that the run dropped anything, because it did not", async () => {
    // The same emoji, the other channel, and a different truth. A comment is
    // composed as "<author>: <body>", so what the run reads HAS words in it,
    // the wordless branch is not taken and nothing is dropped: the run asks its
    // follow-up instead. The sentence about carrying on without the repository
    // would be a lie here, so this one gets the ordinary explanation.
    await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "\u{1F44D}", createdAt: AFTER },
      ],
    });

    // ROUND 5. The emoji still drops nothing, and now it does not wake the run
    // either: one reader settles nothing from it, so the question stays open
    // and the person is asked for a word rather than watching a run go by.
    expect(await run(tracker)).toEqual({ status: "answer_unclear", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing has been recorded, and this question is still open");
    expect(posted).not.toContain("continuing without");
  });

  it("stays quiet about a which of these question a refusal that says what it refuses settled", async () => {
    // The one question that records nothing by design and still never comes
    // back: answering a `selection` ask at all raises this subject's
    // selection-answered flag permanently, which silences both this question
    // and the pre-sandbox one (`readWorkScopeSelectionAnswered` in
    // `db/repositories/work-scope.ts`). Nobody is going to be asked again, so
    // there is nothing to warn them about, and a sentence saying their answer
    // recorded nothing would read as a fault that is not there.
    await seedPending(asked("github:acme/api", "selection"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "none of these", createdAt: AFTER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([]);
    // Recorded as the refusal it is, which is what settles the question.
    await expect(trailEvents()).resolves.toEqual([
      expect.objectContaining({ kind: "question_answered", answer: { kind: "none" } }),
    ]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    // The opening line every not-recorded comment shares, whatever its reason.
    expect(posted).not.toContain("Your answer reached the run");
  });

  // Joint gate round 3, R4. The same question and a bare "no" posted as a
  // comment, which is threaded to nothing: it used to settle acme/api for good
  // in Jane's name, silently. Now it settles nothing and Jane is told what to
  // write instead (A8), exactly as on a question about a disabled repository.
  it("settles nothing from a bare no posted on a which of these question, and says what to write", async () => {
    await seedPending(asked("github:acme/api", "selection"), [QUESTION]);
    const tracker = makeTracker({
      comments: [{ author: "Jane", accountId: "human-1", body: "no", createdAt: AFTER }],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([]);
    // An answer that settles nothing: the selection flag reads only `none` and
    // `repositories`, so the question comes back.
    await expect(trailEvents()).resolves.toEqual([
      expect.objectContaining({ kind: "question_answered", answer: { kind: "unrecognised" } }),
    ]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("reads as a plain no");
    // The sentence this offers moved when the old one turned out to be false:
    // a comment IS how a ticket answers an open question, so what has no route
    // is a refusal written under one already answered (M3).
    expect(posted).toContain(
      'When the question comes back, answering "none" declines every repository it lists',
    );
  });

  it("records an answer the same person sent as two comments, the case the guard must not catch", async () => {
    await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "let me check", createdAt: AFTER },
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER_LATER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        decidedBy: JANE,
      }),
    ]);
  });

  it("records one person's answer whose own second line opens with a word and a colon", async () => {
    // The guard counts the people the channel composed, never the colons in
    // what they wrote. Counted from the text, this one answer reads as two
    // authors and stops being recorded for good.
    await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        {
          author: "Jane",
          accountId: "human-1",
          body: "github:acme/api\nreason: it holds the endpoint",
          createdAt: AFTER,
        },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        decidedBy: JANE,
      }),
    ]);
  });

  it("records an answer from one person whose display name changed between their two comments", async () => {
    // One account under two names, which is one person: a name is a label on
    // an account and goes missing or generic on a deactivated, anonymised or
    // app-proxied author. Counted by name this answer would stop being
    // recorded, and the person would never learn why.
    await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jane Doe", accountId: "human-1", body: "let me check", createdAt: AFTER },
        {
          author: "Jane Smith",
          accountId: "human-1",
          body: "github:acme/api",
          createdAt: AFTER_LATER,
        },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        decidedBy: {
          kind: "person",
          actorId: "jira:human-1",
          actorLabel: "Jane Doe, Jane Smith (via Jira)",
        },
      }),
    ]);
  });

  it("decides nothing when two people share one display name", async () => {
    // Two accounts, one display name. The name count says one person and would
    // record a decision for whichever of them did not make it.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    const tracker = makeTracker({
      comments: [
        { author: "Jan Kowalski", accountId: "human-1", body: "let me check", createdAt: AFTER },
        {
          author: "Jan Kowalski",
          accountId: "human-2",
          body: "github:acme/api",
          createdAt: AFTER_LATER,
        },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    // Readable on purpose, as above: counted by name alone this records
    // github:acme/api for whichever Jan Kowalski did not ask for it.
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([
      declinedTrailRow(row.id, "jira:human-2", "Jan Kowalski (via Jira)"),
    ]);
  });

  it("decides nothing when a stored two person answer is delivered again after a lost resume", async () => {
    // The row keeps the text and the last commenter, never how many people
    // wrote it, so the retry counts them again from the comments it was
    // composed from.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(
      db,
      row.id,
      "Jane: moving this back to AI\n\nBob: github:acme/docs will need a follow-up",
      { id: "jira:human-2", label: "Jane, Bob (via Jira)" },
    );
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "moving this back to AI", createdAt: AFTER },
        {
          author: "Bob",
          accountId: "human-2",
          body: "github:acme/docs will need a follow-up",
          createdAt: AFTER_LATER,
        },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([
      declinedTrailRow(row.id, "jira:human-2", "Jane, Bob (via Jira)"),
    ]);
  });

  it("records a stored one person answer when the retry can still count its author", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(db, row.id, "Jane: github:acme/api", {
      id: "jira:human-1",
      label: "Jane (via Jira)",
    });
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        decidedBy: JANE,
      }),
    ]);
  });

  it("records a stored dashboard answer on retry, whatever else people were saying on the ticket", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(db, row.id, "github:acme/api", { id: "user_1", label: "Ada" });
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "any update?", createdAt: AFTER },
        { author: "Bob", accountId: "human-2", body: "not yet", createdAt: AFTER_LATER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    // Ada answered in the dashboard: nobody composed her words with anybody
    // else's, so the chatter on the ticket decides nothing about her answer.
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        decidedBy: { kind: "person", actorId: "user_1", actorLabel: "Ada" },
      }),
    ]);
  });

  it("delivers nothing and keeps the one shot write when the retry cannot tell our own comments from a person's", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(db, row.id, "Jane: github:acme/api", {
      id: "jira:human-1",
      label: "Jane (via Jira)",
    });
    const comments = [
      { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
    ];
    const mute = makeTracker({ botId: async () => "", comments });

    // Not being able to count is not a decision, and it is not a delivery
    // either: resuming here would spend the hook, take the row out of the
    // resumable set with it, and leave nothing that could ever record Jane's
    // answer. The failure is the retryable one instead.
    expect(await run(mute)).toEqual({ status: "resume_retry_pending", runId: RUN });
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([]);

    // One moment of Jira not saying who we are has not cost Jane her answer.
    expect(await run(makeTracker({ comments }))).toEqual({ status: "resumed", runId: RUN });
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        decidedBy: JANE,
      }),
    ]);
  });

  it("keeps the one shot write for later when a rate limited ticket read cannot be made at all", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(db, row.id, "Jane: github:acme/api", {
      id: "jira:human-1",
      label: "Jane (via Jira)",
    });
    const comments = [
      { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
    ];
    const flaky = makeTracker({
      fetchTicket: async () => {
        throw new Error("Jira 429");
      },
    });

    // The read the count comes from is the read the delivery makes anyway, so a
    // rate limit stops the delivery where it has committed nothing at all.
    await expect(run(flaky)).rejects.toThrow("Jira 429");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([]);

    // One second of Jira being slow has not cost Jane her answer.
    expect(await run(makeTracker({ comments }))).toEqual({ status: "resumed", runId: RUN });
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        decidedBy: JANE,
      }),
    ]);
  });

  it("decides nothing and still resumes when the comments a stored answer was composed from are gone", async () => {
    // The ticket READ fine and the comments the answer was composed from are
    // not on it: they were deleted, and no later delivery brings them back. So
    // this is the opposite of a read that failed. Holding the answer back would
    // spend three deliveries on evidence that no longer exists and end in a
    // cancelled run and a sentence nobody can act on. Nothing is recorded, the
    // person's run wakes on the words they already saw, and the next run asks
    // the question again.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(db, row.id, "Jane: github:acme/api", {
      id: "jira:human-1",
      label: "Jane (via Jira)",
    });
    const tracker = makeTracker({ comments: [] });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([]);
  });

  it("counts only the people who wrote before the answer was stored", async () => {
    // A retry can be days behind the answer. What was said in between is a
    // conversation about the answer, not part of it, and counting it declines a
    // perfectly good single person's answer that was already delivered once.
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [QUESTION]);
    await answerHookClarification(db, row.id, "Jane: github:acme/api", {
      id: "jira:human-1",
      label: "Jane (via Jira)",
    });
    await db
      .update(clarificationRequests)
      .set({ answeredAt: new Date(AFTER_LATER) })
      .where(eq(clarificationRequests.id, row.id));
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "github:acme/api", createdAt: AFTER },
        { author: "Bob", accountId: "human-2", body: "thanks Jane", createdAt: LATER_STILL },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        decidedBy: JANE,
      }),
    ]);
  });

  it("leaves a two person conversation on a question about no repository exactly as it was", async () => {
    await seedPending();
    const tracker = makeTracker({
      comments: [
        { author: "Jane", accountId: "human-1", body: "Prefer A", createdAt: AFTER },
        { author: "Bob", accountId: "human-2", body: "Actually B", createdAt: AFTER_LATER },
      ],
    });

    expect(await run(tracker)).toEqual({ status: "resumed", runId: RUN });

    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([]);
  });
});
