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
import {
  appendWorkScopeQuestionAsked,
  readWorkScope,
  readWorkScopeAnsweredRepositories,
} from "../../db/repositories/work-scope.js";
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
  applyAnswerWorkScopePlan: vi.fn(),
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
// The real store everywhere except the one write these tests need to fail: a
// record write that throws is the only way to prove the answer path reports it
// instead of resuming on an answer it did not record.
vi.mock("../../db/repositories/work-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/repositories/work-scope.js")>();
  mocks.applyAnswerWorkScopePlan.mockImplementation(actual.applyAnswerWorkScopePlan);
  return {
    ...actual,
    applyAnswerWorkScopePlan: (...args: Parameters<typeof actual.applyAnswerWorkScopePlan>) =>
      mocks.applyAnswerWorkScopePlan(...args),
  };
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

describe("answerClarificationAndResume records the repository answer on arrival", () => {
  const PERSON = { kind: "person", actorId: "user_1", actorLabel: "Ada" };
  const NAMED = "Named in the answer to a repository question.";

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

  it("records a named repository as selected by the person, readable the moment it returns", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));

    const outcome = await answer(makeTracker(), row.id, "github:acme/web please");

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([
      {
        repositoryKey: "github:acme/web",
        state: "selected",
        origin: "person",
        rationale: NAMED,
        decidedBy: PERSON,
        decidedAt: expect.any(String),
      },
    ]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "repositories", repositoryKeys: ["github:acme/web"] },
        answeredBy: PERSON,
      },
      {
        kind: "entry_written",
        clarificationId: row.id,
        previousState: null,
        entry: {
          repositoryKey: "github:acme/web",
          state: "selected",
          origin: "person",
          rationale: NAMED,
          decidedBy: PERSON,
          decidedAt: expect.any(String),
        },
      },
    ]);
  });

  it('records "none" to a not_enabled question as unavailable, not as a refusal', async () => {
    const row = await seedPending(asked("github:acme/tools", "not_enabled"));

    await answer(makeTracker(), row.id, "none, continue without it");

    await expect(entriesOfSubject()).resolves.toEqual([
      {
        repositoryKey: "github:acme/tools",
        state: "unavailable",
        unavailableReason: "not_enabled",
        origin: "person",
        rationale: "Left out of the answer to a question asked because it was not enabled.",
        decidedBy: PERSON,
        decidedAt: expect.any(String),
      },
    ]);
  });

  it('records "none" to an unusable question as unavailable for that reason', async () => {
    const row = await seedPending(asked("github:acme/tools", "unusable"));

    await answer(makeTracker(), row.id, "none");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/tools",
        state: "unavailable",
        unavailableReason: "unusable",
        origin: "person",
      }),
    ]);
  });

  it('records "none" to an outside_policy question as the exclusion the person decided', async () => {
    const row = await seedPending(asked("github:acme/tools", "outside_policy"));

    await answer(makeTracker(), row.id, "none");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/tools",
        state: "excluded",
        origin: "person",
      }),
    ]);
  });

  it('records no entry for "none" to a selection question, only that it was answered', async () => {
    const row = await seedPending(asked("github:acme/api", "selection"));

    await answer(makeTracker(), row.id, "none");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "none" },
        answeredBy: PERSON,
      },
    ]);
  });

  it("records an answer whose words nobody could read as answered, and decides nothing", async () => {
    const row = await seedPending(asked("github:acme/api", "outside_policy"));

    await answer(makeTracker(), row.id, "whichever one the team prefers");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "unrecognised" },
        answeredBy: PERSON,
      },
    ]);
  });

  it("tells the person when words nobody could read left the question open, offering the list back", async () => {
    // The same hole in the neighbouring direction. An answer the reader cannot
    // make out records nothing AND suppresses nothing: the trail read that
    // silences a repository question counts only a `none` or a list of names
    // (`db/repositories/work-scope.ts`), so this question returns on the next
    // run. Here the question did list repositories, so the words offered back
    // are the ones the person was shown.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "whichever one the team prefers");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository");
    // The one keyword, the one the question itself teaches, and the truth about
    // where it works: the next asking, never a reply under this closed one.
    expect(posted).toContain('answer "none" the next time the question is asked');
  });

  it("tells the person nothing was recorded when they named a repository this deployment does not hold", async () => {
    // The two halves of this row were proved on two different inputs: that an
    // unresolvable name records nothing (`engine/work-scope/answer.ts`, where
    // an identity that resolves against nothing makes the whole answer
    // unrecognised), and that a person is told, on an answer of pure prose.
    // This is the row's own input through both halves at once.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "github:acme/unknown-service");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "unrecognised" },
        answeredBy: PERSON,
      },
    ]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("named a repository this deployment does not have");
    // The remedy that is true for a bare name is a dead end for this person:
    // they already wrote the path, and the next run would read the same words
    // and resolve them to the same nothing.
    expect(posted).not.toContain("write its full path in a comment here");
    expect(posted).not.toContain("Write the full path");
    expect(posted).toContain("somebody with access to the repositories screen can add or enable it");
  });

  it("keeps the remedy that works for an answer that spelled no path out, because writing one out does resolve", async () => {
    // The other half of the same fork, and the reason the fork exists. Nothing
    // here was written as a path, so nothing about it is a dead end: the words
    // this person needs are the ones we have always sent, and a change that
    // gave everybody the "we do not have that" sentence would be a lie told to
    // them.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "the billing service");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository this work should use");
    expect(posted).toContain("write its full path in a comment here");
    expect(posted).not.toContain("does not have");
  });

  it("gives the fuller explanation when one answer carries both a bare name and a path we do not hold", async () => {
    // Both sentences are true for this person, and the longer one is the one
    // they cannot work out for themselves: that a name they spelled out in full
    // is not here at all. The shorter one would leave them writing that path
    // again and waiting for a run that reads it to nothing.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "billing, or github:acme/unknown-service");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("named a repository this deployment does not have");
    expect(posted).not.toContain("write its full path in a comment here");
  });

  it("tells the person that a thumbs up dropped the repository the run asked about", async () => {
    // A thumbs up reads as approval and does the opposite of approving: the
    // run's own reader takes the wordless branch, ends its asking and carries
    // on WITHOUT the repository, while the record writes nothing because a
    // permanent refusal is not a thing to read out of an emoji. Both halves are
    // deliberate; the silence between them was not.
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "\u{1F44D}");

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("continuing without the repositories the question asked about");
    expect(posted).toContain("has no words in it");
    expect(posted).toContain("write its full path in a comment here");
  });

  it("decides nothing when the person quoted our question and said no under it", async () => {
    // Jira's quote button flattens to text with no marker on it, so without the
    // questions the row carries, our own repository key comes back looking like
    // the person's selection and is recorded against their name forever.
    const question = "Does this ticket also touch github:acme/web? Reply with none if not.";
    const row = await seedPending(asked("github:acme/web", "not_enabled"), [question]);

    await answer(makeTracker(), row.id, `${question}\n\nno`);

    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "unrecognised" },
        answeredBy: PERSON,
      },
    ]);
  });

  it("records a plain no typed into this question's own box, which is nobody else's comment", async () => {
    // The dashboard and the MCP client open a box belonging to this question,
    // so a no in it is an answer to it and is recorded exactly as it always
    // was. Only the ticket, where a comment is threaded to nothing, has to ask
    // more of a refusal than the word.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));

    const outcome = await answer(makeTracker(), row.id, "no");

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "excluded",
        origin: "person",
        decidedBy: PERSON,
      }),
    ]);
  });

  it("records the repository a person redirected to and excludes the one they declined", async () => {
    const row = await seedPending(asked("github:acme/api", "outside_policy"));

    await answer(makeTracker(), row.id, "not acme/api, use github:acme/web");

    const entries = await entriesOfSubject();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repositoryKey: "github:acme/web",
          state: "selected",
          origin: "person",
          rationale: NAMED,
          decidedBy: PERSON,
        }),
        expect.objectContaining({
          repositoryKey: "github:acme/api",
          state: "excluded",
          origin: "person",
          decidedBy: PERSON,
        }),
      ]),
    );
    expect(entries).toHaveLength(2);
  });

  it("reads a bare list of names sent as a Jira comment, author line and all", async () => {
    const row = await seedPending(asked("github:acme/api", "selection"));

    await answer(makeTracker(), row.id, "Ada: api, web");

    await expect(entriesOfSubject()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
        expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
      ]),
    );
  });

  it("records every repository in a list of several as that one person's own decision", async () => {
    // The row is about ALL of them: each key the answer names is selected, each
    // carries the person who typed it, and the trail says so for each. Until
    // this test, origin and author for an answer naming more than one rested
    // entirely on the single-name test above, and a loop that wrote the second
    // key some other way would have kept both green.
    const row = await seedPending(asked("github:acme/api", "selection"));

    await answer(makeTracker(), row.id, "Ada: github:acme/api and github:acme/web");

    const person = {
      state: "selected",
      origin: "person",
      rationale: NAMED,
      decidedBy: PERSON,
      decidedAt: expect.any(String),
    };
    await expect(entriesOfSubject()).resolves.toEqual([
      { repositoryKey: "github:acme/api", ...person },
      { repositoryKey: "github:acme/web", ...person },
    ]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: {
          kind: "repositories",
          repositoryKeys: ["github:acme/api", "github:acme/web"],
        },
        answeredBy: PERSON,
      },
      {
        kind: "entry_written",
        clarificationId: row.id,
        previousState: null,
        entry: { repositoryKey: "github:acme/api", ...person },
      },
      {
        kind: "entry_written",
        clarificationId: row.id,
        previousState: null,
        entry: { repositoryKey: "github:acme/web", ...person },
      },
    ]);
  });

  it("writes once when the same answer is delivered twice, and still resumes the run", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "github:acme/web");
    const retry = await answer(tracker, row.id, "github:acme/web");

    expect(retry.kind).toBe("answered");
    expect(mocks.resumeHook).toHaveBeenCalledTimes(2);
    await expect(trailEvents()).resolves.toHaveLength(2);
    await expect(entriesOfSubject()).resolves.toHaveLength(1);
  });

  it("keeps the first answer when a second, different one is refused by the status guard", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "github:acme/web");
    const second = await answer(tracker, row.id, "github:acme/api instead");

    expect(second.kind).toBe("conflict");
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("reads an answer that arrived through Jira, author prefix and all", async () => {
    const row = await seedPending([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);

    await answer(makeTracker(), row.id, "Filip Maszota: api, web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("reads the union of one person's two comments", async () => {
    // The only two comment answer that is ever read: an answer two people wrote
    // is declined below, so every comment reaching the reader carries the same
    // name in front of it.
    const row = await seedPending([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);

    await answer(makeTracker(), row.id, "Filip Maszota: api\n\nFilip Maszota: web", {
      answerAuthorCount: 1,
    });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api" }),
      expect.objectContaining({ repositoryKey: "github:acme/web" }),
    ]);
  });

  it("keeps a repository named at the start of a person's own second paragraph", async () => {
    // A blank line inside one Jira comment is a paragraph break, not the join
    // between two comments. Cut there, the author strip eats whatever opens the
    // paragraph, and here that is the only repository the person named: they
    // would be asked again about a repository they had just answered with.
    const row = await seedPending(asked("github:acme/api", "not_enabled"));

    await answer(makeTracker(), row.id, "Ada: Sure.\n\nacme/api: that is the backend", {
      answerAuthorCount: 1,
    });

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
      }),
    ]);
  });

  it("takes off an author whose name carries a slash, rather than losing the answer", async () => {
    const row = await seedPending([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);

    await answer(makeTracker(), row.id, "Anna Kowalska / Blazity: api, web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("keeps a repository named at the start of a line under the author, which a per line strip eats", async () => {
    // The author is written once, in front of the comment. A second line that
    // opens with a name and a colon is the person's own text, so the name has
    // to survive to the reader: taken off, this answer leaves out a repository
    // the person asked for and records it against them as unavailable.
    await db
      .insert(repositories)
      .values({ provider: "github", path: "acme/tools", source: "manual", enabled: true });
    const row = await seedPending([
      { repositoryKey: "github:acme/api", askedBecause: "not_enabled" },
      { repositoryKey: "github:acme/web", askedBecause: "not_enabled" },
      { repositoryKey: "github:acme/tools", askedBecause: "not_enabled" },
    ]);

    await answer(makeTracker(), row.id, "Filip Maszota: api\nweb: tools");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
      expect.objectContaining({ repositoryKey: "github:acme/tools", state: "selected" }),
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("does not read a repository key as an author, because a key has no space after its colon", async () => {
    // Two providers hold the same path, so a key read as "author: path" would
    // leave a path neither of them owns alone and an answer nobody can read.
    await db
      .insert(repositories)
      .values({ provider: "gitlab", path: "acme/web", source: "manual", enabled: true });
    const row = await seedPending(asked("github:acme/web", "not_enabled"));

    await answer(makeTracker(), row.id, "github:acme/web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
    ]);
  });

  it("leaves a dashboard answer, which carries no author, exactly as it reads", async () => {
    const row = await seedPending(asked("github:acme/api", "selection"));

    await answer(makeTracker(), row.id, "api");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
    ]);
  });

  it("reports a failed record write instead of resuming on an answer it did not record", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    mocks.applyAnswerWorkScopePlan.mockRejectedValueOnce(new Error("record write failed"));

    await expect(answer(makeTracker(), row.id, "github:acme/web")).rejects.toThrow(
      "record write failed",
    );

    // The run stays parked and the record stays empty, so the channel's retry of
    // the same answer is what records it and wakes the run.
    expect(mocks.resumeHook).not.toHaveBeenCalled();
    await expect(trailEvents()).resolves.toEqual([]);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
  });

  it("keeps a decision the person made when the run it was meant for dies, so a later run does not ask again", async () => {
    const row = await seedPending(asked("github:acme/web", "not_enabled"));
    // The question is on the trail, written where the run asked it
    // (`engine/steps/clarification.ts`), because what silences the next run's
    // asking is a join of the asking and the answer.
    await appendWorkScopeQuestionAsked(db, {
      subjectKey: SUBJECT,
      runId: RUN,
      clarificationId: row.id,
      asked: asked("github:acme/web", "not_enabled"),
    });
    // The run the answer was meant for never wakes: every delivery fails, the
    // budget is spent and the run is stopped. This is where the story used to
    // end, with the person's decision dying beside the run.
    mocks.resumeHook.mockRejectedValue(new Error("transport failed"));
    const tracker = makeTracker();

    const kinds = [
      (await answer(tracker, row.id, "github:acme/web")).kind,
      (await answer(tracker, row.id, "github:acme/web")).kind,
      (await answer(tracker, row.id, "github:acme/web")).kind,
    ];

    expect(kinds).toEqual([
      "resume_failed_retryable",
      "resume_failed_retryable",
      "resume_exhausted",
    ]);
    const [runRow] = await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN));
    expect(runRow?.status).toBe("failed");

    // What a NEW run on this subject reads at its start, before anything
    // decides what to ask: the decision, and the fact that this repository has
    // been answered about. Both are frozen onto the run context by
    // `engine/steps/run-start-settings.ts`.
    await expect(entriesOfSubject()).resolves.toMatchObject([
      { repositoryKey: "github:acme/web", state: "selected", origin: "person", decidedBy: PERSON },
    ]);
    await expect(readWorkScopeAnsweredRepositories(db, SUBJECT)).resolves.toEqual([
      "github:acme/web",
    ]);
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
    // and the comment path only ever reads a pending one. What it offers is the
    // route that works without a question, the ticket text the next run reads.
    expect(told[0]?.[1]).toContain("write its full path in a comment here");
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

  it("records nothing for a clarification that carried no repository question, whatever its answer names", async () => {
    // No asked list at all means the question was about something else, so the
    // repository key in this answer is a person pointing at an example, not a
    // decision. Reading it would write an entry nobody was asked for, and
    // nobody can undo.
    const row = await seedPending();

    const outcome = await answer(
      makeTracker(),
      row.id,
      "Use Next.js, the pattern is in github:acme/api",
    );

    expect(outcome.kind).toBe("answered");
    expect(outcome.kind === "answered" && outcome.row.answer).toBe(
      "Use Next.js, the pattern is in github:acme/api",
    );
    await expect(trailEvents()).resolves.toEqual([]);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
  });

  it("records the repository a person named to a question that listed none", async () => {
    // The bare "which repository should this ticket modify?" lists nothing, and
    // that empty list is what makes its answer readable at all. Without it the
    // question comes back on the next run with the answer already given, which
    // is the loop this closes.
    const row = await seedPending([], ["Which repository should this ticket modify?"]);

    const outcome = await answer(makeTracker(), row.id, "github:acme/api");

    expect(outcome.kind).toBe("answered");
    await expect(entriesOfSubject()).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        rationale: NAMED,
        decidedBy: PERSON,
        decidedAt: expect.any(String),
      },
    ]);
  });
});
