import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettingsSnapshot, type WorkScopeAskedRepository } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import type {
  IssueTrackerAdapter,
  TicketComment,
  TicketContent,
} from "../../adapters/issue-tracker/types.js";
import {
  activeRuns,
  clarificationRequests,
  repositories,
  workflowRuns,
  workScopeTrail,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { logger } from "../../infra/logger.js";
import { answerClarificationAndResume } from "./answer-core.js";
import { readWorkScope } from "../../db/repositories/work-scope.js";
import {
  answerHookClarification,
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "../../db/repositories/clarification-hooks.js";

const mocks = vi.hoisted(() => ({
  resumeHook: vi.fn(),
  getHookByToken: vi.fn(),
  cancelRunForOperator: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: { COLUMN_AI: "AI", DASHBOARD_ORIGIN: "https://dash.example" },
}));
vi.mock("workflow/api", () => ({
  resumeHook: (...args: unknown[]) => mocks.resumeHook(...args),
  getHookByToken: (...args: unknown[]) => mocks.getHookByToken(...args),
}));
vi.mock("../run-lifecycle/cancel-run.js", () => ({
  cancelRunForOperator: (...args: unknown[]) => mocks.cancelRunForOperator(...args),
}));

// This deployment has an issue tracker connected. Which one, and what it is
// wired to, is an integration connection since S12 and is resolved from the
// database; this suite is about what happens to a RUN, so it says the one
// thing it means and leaves the resolution to its own tests.
vi.mock("../../engine/support/issue-tracker-runtime.js", async () => {
  const support = await import("../../test-support/issue-tracker.js");
  return support.connectedIssueTracker({});
});

const TICKET = "AWT-9";
const SUBJECT = "ticket:jira:AWT-9";
const RUN = "run-asked";
const ACTOR = { id: "user_1", label: "Ada" };
const BOT = "bot-account";
// The two moments a recount of a stored answer is bounded by, and two comments
// inside that window. Relative to now rather than pinned to a date, because a
// delivery that cannot count the authors is held for a window measured from the
// moment the answer was stored: a fixture answered in some fixed past would be
// outside every such window before the test began.
const ANSWERED_AT = new Date(Date.now() - 60_000);
const ASKED_AT = new Date(ANSWERED_AT.getTime() - 2 * 60 * 60 * 1000);
const DURING = new Date(ANSWERED_AT.getTime() - 60 * 60 * 1000).toISOString();
const DURING_LATER = new Date(ANSWERED_AT.getTime() - 30 * 60 * 1000).toISOString();

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

function makeTracker(
  opts: {
    comments?: TicketComment[];
    botId?: string;
    commentsComplete?: boolean;
    commentsCompleteFrom?: string;
  } = {},
) {
  const ticket: TicketContent = {
    id: "1",
    identifier: TICKET,
    projectKey: "AWT",
    title: "Title",
    description: "Description",
    acceptanceCriteria: "",
    comments: opts.comments ?? [],
    // What a real read reports once it has paged to the end of the ticket. A
    // test that asks what happens when it could not passes false.
    commentsComplete: opts.commentsComplete ?? true,
    // The narrower fact a read of a very long ticket still establishes: from
    // this instant on, the list is whole. Absent on the ordinary ticket above,
    // which has no need of it.
    ...(opts.commentsCompleteFrom === undefined
      ? {}
      : { commentsCompleteFrom: opts.commentsCompleteFrom }),
    labels: [],
    trackerStatus: "AI",
    attachments: [],
  };
  return {
    fetchTicket: vi.fn(() => Promise.resolve(ticket)),
    moveTicket: vi.fn(() => Promise.resolve()),
    postComment: vi.fn((_id: string, _comment: string) => Promise.resolve(null as string | null)),
    // An empty id is how a provider that will not say who we are reads here,
    // and it is the one thing that makes a ticket's comments uncountable
    // without making the ticket itself unreadable.
    getCurrentUserAccountId: vi.fn(() => Promise.resolve(opts.botId ?? BOT)),
  };
}

/** One delivery attempt of `answer`, always against the row as it stands now.
 *  `extra` is how a channel differs from the dashboard: who is answering, and
 *  how many people the channel composed the words from. */
async function answer(
  tracker: ReturnType<typeof makeTracker>,
  id: string,
  text: string,
  extra: { actor?: { id: string; label: string }; answerAuthorCount?: number } = {},
) {
  const row = await getHookClarification(db, id);
  if (!row) throw new Error("clarification vanished");
  return answerClarificationAndResume({
    db,
    row,
    rawAnswer: text,
    actor: extra.actor ?? ACTOR,
    ...(extra.answerAuthorCount === undefined
      ? {}
      : { answerAuthorCount: extra.answerAuthorCount }),
    issueTracker: tracker as unknown as Pick<
      IssueTrackerAdapter,
      "fetchTicket" | "moveTicket" | "postComment" | "getCurrentUserAccountId"
    >,
    cancelSettings: defaultSettingsSnapshot(),
  });
}

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

describe("answerClarificationAndResume counts who wrote the answer", () => {
  const PERSON = { kind: "person", actorId: "user_1", actorLabel: "Ada" };

  async function seedCatalog() {
    await db.insert(repositories).values([
      { provider: "github", path: "acme/api", source: "manual", enabled: true },
      { provider: "github", path: "acme/web", source: "manual", enabled: true },
    ]);
  }

  async function entriesOfSubject() {
    return (await readWorkScope(db, SUBJECT))?.entries ?? [];
  }

  async function trailEvents() {
    const rows = await db.select().from(workScopeTrail).orderBy(asc(workScopeTrail.id));
    return rows.map((row) => row.event);
  }

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

  function comment(
    accountId: string,
    author: string,
    body: string,
    createdAt: string,
  ): TicketComment {
    return { author, accountId, body, createdAt };
  }

  /** An answer the ticket composed, already on the row, with the two moments a
   *  recount is bounded by pinned: this is what any channel redelivering a
   *  stored answer finds, however long after the answer it arrives. */
  async function storedTicketAnswer(
    id: string,
    text: string,
    actorId: string,
    label: string,
    answeredAt: Date = ANSWERED_AT,
  ) {
    await answerHookClarification(db, id, text, { id: actorId, label });
    await db
      .update(clarificationRequests)
      .set({ askedAt: ASKED_AT, answeredAt })
      .where(eq(clarificationRequests.id, id));
  }

  beforeEach(async () => {
    // These tests are about what the answer records, so the resume succeeds.
    mocks.resumeHook.mockResolvedValue(undefined);
    await seedCatalog();
  });

  it("writes no entry when the channel says two people wrote the answer, and still resumes the run", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));

    const outcome = await answer(makeTracker(), row.id, "github:acme/web", {
      answerAuthorCount: 2,
    });

    // The run wakes on the same words; only the entries are declined.
    expect(outcome.kind).toBe("answered");
    expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    // The answer is perfectly readable and is still nobody's decision, and the
    // trail says which of the two happened: "unattributed", not the kind that
    // means we could not read the words.
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "unattributed" },
        answeredBy: PERSON,
      },
    ]);
  });

  it("warns when it declines to attribute an answer, because the only other symptom is a repeated question", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const warn = vi.spyOn(logger, "warn");

    await answer(makeTracker(), row.id, "github:acme/web", { answerAuthorCount: 2 });

    // One Jira automation rule commenting on the move into the AI column is a
    // second author on every ticket, and nothing else would say so.
    expect(warn).toHaveBeenCalledWith(
      { runId: RUN, clarificationId: row.id, authorCount: 2 },
      "work_scope_answer_not_attributed_multiple_authors",
    );
  });

  it("counts the people behind a stored ticket answer from the ticket, whichever channel hands it back", async () => {
    // A byte-exact resubmission of the stored text through MCP or the dashboard
    // takes the resume retry path and composed nothing, so it carries no count.
    // What the answer was made of is still on the ticket, so it is counted from
    // there and judged on the same evidence as the first delivery: one person,
    // one recorded decision. Deciding by which channel delivered instead loses
    // this answer for good, because the resume spends the hook and the row
    // leaves the resumable set with it.
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    await storedTicketAnswer(row.id, "Jane: github:acme/web", "jira:human-1", "Jane (via Jira)");
    const tracker = makeTracker({
      comments: [comment("human-1", "Jane", "github:acme/web", DURING)],
    });

    const outcome = await answer(tracker, row.id, "Jane: github:acme/web", {
      actor: { id: "user_9", label: "MCP claude-code" },
    });

    expect(outcome.kind).toBe("answered");
    // The recount reads the ticket WITH the window it is counting over, so the
    // pages are paid for here and on no other ticket read in the deployment.
    expect(tracker.fetchTicket).toHaveBeenCalledWith(TICKET, {
      commentsSince: ASKED_AT.toISOString(),
    });
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/web",
        state: "selected",
        origin: "person",
        decidedBy: { kind: "person", actorId: "jira:human-1", actorLabel: "Jane (via Jira)" },
      }),
    ]);
  });

  it("writes no entry when the ticket says two people wrote the stored answer handed back", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const composed = "Jane: github:acme/web\n\nBob: sounds right";
    await storedTicketAnswer(row.id, composed, "jira:human-2", "Jane, Bob (via Jira)");
    const tracker = makeTracker({
      comments: [
        comment("human-1", "Jane", "github:acme/web", DURING),
        comment("human-2", "Bob", "sounds right", DURING_LATER),
      ],
    });

    const outcome = await answer(tracker, row.id, composed, {
      actor: { id: "user_9", label: "MCP claude-code" },
    });

    expect(outcome.kind).toBe("answered");
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "unattributed" },
        answeredBy: {
          kind: "person",
          actorId: "jira:human-2",
          actorLabel: "Jane, Bob (via Jira)",
        },
      },
    ]);
  });

  it("fails the delivery, and spends nothing, when the people behind a stored answer cannot be counted", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    await storedTicketAnswer(row.id, "Jane: github:acme/web", "jira:human-1", "Jane (via Jira)");
    const mute = makeTracker({
      botId: "",
      comments: [comment("human-1", "Jane", "github:acme/web", DURING)],
    });

    const outcome = await answer(mute, row.id, "Jane: github:acme/web", {
      actor: { id: "user_9", label: "MCP claude-code" },
    });

    // Retryable, and before the hook: the answer is intact, the row is still
    // resumable, and the write nobody spent is still there for the next
    // delivery. Resuming on an answer nothing can attribute would end both.
    expect(outcome.kind).toBe("resume_failed_retryable");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    await expect(trailEvents()).resolves.toEqual([]);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
  });

  it("holds a stored answer rather than calling its evidence gone when the ticket could not be read to the end", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    await storedTicketAnswer(row.id, "Jane: github:acme/web", "jira:human-1", "Jane (via Jira)");
    // The answer is on page two, and this read never got there. Absence here is
    // ignorance, and ignorance must not read as "those words were deleted".
    const truncated = makeTracker({ comments: [], commentsComplete: false });

    const outcome = await answer(truncated, row.id, "Jane: github:acme/web", {
      actor: { id: "user_9", label: "MCP claude-code" },
    });

    expect(outcome.kind).toBe("resume_failed_retryable");
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    await expect(trailEvents()).resolves.toEqual([]);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
  });

  it("counts from a ticket too long to read whole when the read covers the question's window", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    await storedTicketAnswer(row.id, "Jane: github:acme/web", "jira:human-1", "Jane (via Jira)");
    // Longer than one read may page through, so the list is not the whole list.
    // It is read from the newest end though, and it reaches back past the
    // question, so every comment the count is taken over is here. Holding this
    // delivery would be an outage of our own making, on the tickets people
    // argue on most.
    const long = makeTracker({
      comments: [comment("human-1", "Jane", "github:acme/web", DURING)],
      commentsComplete: false,
      commentsCompleteFrom: new Date(ASKED_AT.getTime() - 60 * 60 * 1000).toISOString(),
    });

    const outcome = await answer(long, row.id, "Jane: github:acme/web", {
      actor: { id: "user_9", label: "MCP claude-code" },
    });

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/web",
        state: "selected",
        origin: "person",
      }),
    ]);
  });

  it("spends none of the delivery attempts on deliveries our own counting held back", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const composed = "Jane: github:acme/web";
    await storedTicketAnswer(row.id, composed, "jira:human-1", "Jane (via Jira)");
    const mute = makeTracker({
      botId: "",
      comments: [comment("human-1", "Jane", "github:acme/web", DURING)],
    });

    const held = [
      await answer(mute, row.id, composed),
      await answer(mute, row.id, composed),
      await answer(mute, row.id, composed),
    ];

    expect(held.map((outcome) => outcome.kind)).toEqual([
      "resume_failed_retryable",
      "resume_failed_retryable",
      "resume_failed_retryable",
    ]);

    // The three attempts are the person's budget for getting their answer
    // delivered, and none of the three above was an attempt to deliver it: they
    // were us, unable to count. A delivery that can count still finds a full
    // budget, and this answer is still recorded.
    const counted = makeTracker({
      comments: [comment("human-1", "Jane", "github:acme/web", DURING)],
    });
    const outcome = await answer(counted, row.id, composed);

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("gives up counting after its own window, says on the ticket that the failure was ours, and lets the answer through", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const composed = "Jane: github:acme/web";
    // Stored an hour ago: whatever is stopping us counting is not a moment of
    // Jira being unhelpful any more, and the run is still parked on it.
    await storedTicketAnswer(
      row.id,
      composed,
      "jira:human-1",
      "Jane (via Jira)",
      new Date(Date.now() - 60 * 60 * 1000),
    );
    const mute = makeTracker({
      botId: "",
      comments: [comment("human-1", "Jane", "github:acme/web", DURING)],
    });

    const outcome = await answer(mute, row.id, composed);

    expect(outcome.kind).toBe("answered");
    await expect(trailEvents()).resolves.toEqual([]);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    // The person answered correctly and something they cannot see decided not
    // to keep it, so the ticket says what failed and whose fault it was.
    const told = mute.postComment.mock.calls.filter(([, body]) =>
      body.includes("could not establish from this ticket how many people wrote"),
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.[1]).toContain("a limitation on our side");
  });

  it("says on the ticket that the words an answer was composed from are gone", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const composed = "Jane: github:acme/web";
    await storedTicketAnswer(row.id, composed, "jira:human-1", "Jane (via Jira)");
    // The ticket reads clean and Jane's comment is not on it: deleted, or
    // edited past recognition. No later delivery counts it, so the answer goes
    // through and decides nothing.
    const wiped = makeTracker({ comments: [] });

    const outcome = await answer(wiped, row.id, composed);

    expect(outcome.kind).toBe("answered");
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
    // Told, because the next run asks Jane the same question and she is owed
    // the reason. Silence here is how a person learns the system ignores them.
    const told = wiped.postComment.mock.calls.filter(([, body]) =>
      body.includes("no longer on the ticket"),
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.[1]).toContain("Your answer reached the run, which is continuing.");
    expect(told[0]?.[1]).toContain("one person in a single comment is the one that gets recorded");
    // And never an instruction to answer this question again: it is answered,
    // and the comment path only ever reads a pending one. What it offers is a
    // route that exists for THIS question, and this question was raised because
    // the catalog does not enable github:acme/web, so the ticket text the next
    // run reads is not one: that run matches paths against the repositories it
    // froze at its start, and this is not among them. The catalog is.
    expect(told[0]?.[1]).toContain("the repositories screen");
    expect(told[0]?.[1]).not.toContain("write its full path in a comment here");
    expect(told[0]?.[1]).not.toContain("reply");
  });

  it("counts the people the answer was composed from, not whoever commented while it was being stored", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    // Jane's words are the whole answer: the delivery read the ticket, composed
    // them, and Bob's comment landed in the moment between that read and the
    // answer being stored. Counting him makes the same answer two people's
    // through a channel that hands it back and one person's through the channel
    // that composed it.
    const composed = "Jane: github:acme/web";
    await storedTicketAnswer(row.id, composed, "jira:human-1", "Jane (via Jira)");
    const tracker = makeTracker({
      comments: [
        comment("human-1", "Jane", "github:acme/web", DURING),
        comment("human-2", "Bob", "what is this about?", DURING_LATER),
      ],
    });

    const outcome = await answer(tracker, row.id, composed, {
      actor: { id: "user_9", label: "MCP claude-code" },
    });

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("records an answer the channel says one person wrote", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));

    await answer(makeTracker(), row.id, "github:acme/web", { answerAuthorCount: 1 });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("records a dashboard answer, which is one person's own words and counts no authors", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));

    await answer(makeTracker(), row.id, "github:acme/web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/web",
        state: "selected",
        decidedBy: PERSON,
      }),
    ]);
  });

  it("records an MCP answer, which is one client's words and counts no authors", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));

    await answer(makeTracker(), row.id, "github:acme/web", {
      actor: { id: "user_1", label: "MCP claude-code" },
    });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/web",
        state: "selected",
        decidedBy: { kind: "person", actorId: "user_1", actorLabel: "MCP claude-code" },
      }),
    ]);
  });
});
