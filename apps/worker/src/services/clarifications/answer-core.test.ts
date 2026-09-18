import { eq } from "drizzle-orm";
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
  workflowRuns,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { logger } from "../../infra/logger.js";
import { answerClarificationAndResume } from "./answer-core.js";
import { composedAnswerActorId } from "./answer-authorship.js";
import {
  getHookClarification,
  prepareHookClarification,
  publishHookClarification,
} from "../../db/repositories/clarification-hooks.js";
import {
  appendWorkScopeQuestionAsked,
  applyAnswerWorkScopePlan,
} from "../../db/repositories/work-scope.js";

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

const TICKET = "AWT-9";
const SUBJECT = "ticket:jira:AWT-9";
const RUN = "run-asked";
const ACTOR = { id: "user_1", label: "Ada" };
const BOT = "bot-account";

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
    // A STAND-IN FOR THE MODEL. Every test in this file is about what a person
    // gets back, not about how their words were read, and without a reader here
    // they would all run against an unreachable provider and prove only that the
    // deterministic fallback exists. Nothing here is evidence about the real
    // reader; that is the golden set's job.
    answerReadingDeps: { generate: fakeAnswerReadingModel() },
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

describe("answerClarificationAndResume when the ticket is gone", () => {
  it("supersedes the question and settles the run blocked, not success", async () => {
    const row = await seedPending();
    const tracker = makeTracker();
    tracker.fetchTicket.mockRejectedValueOnce(new IssueTrackerNotFoundError("issue", TICKET));

    const result = await answer(tracker, row.id, "Use Next.js");

    expect(result.kind).toBe("ticket_gone");
    const [stored] = await db
      .select()
      .from(clarificationRequests)
      .where(eq(clarificationRequests.id, row.id));
    expect(stored?.status).toBe("superseded");
    const [runRow] = await db.select().from(workflowRuns).where(eq(workflowRuns.runId, RUN));
    expect(runRow?.status).toBe("blocked");
  });
});

/**
 * The way back the comment offers, and whether it opens.
 *
 * A path written in a ticket comment is only picked up while the next run still
 * takes repositories from that ticket's text, and that is a count of the open
 * repositories the ticket names, which this surface cannot see
 * (`commentPathAfterAnUnrecordedAnswer` in `engine/work-scope/context.ts`). So
 * the route is never offered here: the which-of-these question about the
 * ticket's text is told why it is shut, and every other question is sent only
 * to the routes that work whatever the ticket says. Joint gate round 3, R8: the
 * earlier rule counted a discovery question's list with the subject's answered
 * set and offered the comment within three, while the ticket could name four
 * more open repositories and take nothing from a written path.
 */
describe("answerClarificationAndResume telling a person what to write next", () => {
  const ANSWERED_EARLIER = "clarification-earlier";
  const FIVE_KEYS = [
    "github:acme/api",
    "github:acme/docs",
    "github:acme/infra",
    "github:acme/ops",
    "github:acme/web",
  ];
  /** Two proposals, which is all a discovery question ever puts to a person. */
  const TWO_ASKED: WorkScopeAskedRepository[] = [
    { repositoryKey: "github:acme/api", askedBecause: "selection", named: true },
    { repositoryKey: "github:acme/ops", askedBecause: "selection", named: true },
  ];
  const COMMENT_PATH_WORKS = "write its full path in a comment here";
  // Round 5, S2. It read "does not settle it ... because the next run then asks
  // which of them to start from instead", and the clause after the comma is a
  // question this surface cannot promise: once something on this work has
  // answered it, a path in a comment is neither taken nor asked about. What the
  // person can count on is that the comment brings nothing in.
  const COMMENT_PATH_IS_A_DEAD_END =
    "brings nothing into this work while this ticket names more than three repositories";
  const ONLY_THE_RECORD =
    "select it in this work's repository list through the work scope API or the work_scope.edit tool";

  /** An earlier which-of-these question on the same subject, answered. */
  async function earlierSelectionAnswered() {
    await appendWorkScopeQuestionAsked(db, {
      subjectKey: SUBJECT,
      runId: "run-earlier",
      clarificationId: ANSWERED_EARLIER,
      asked: FIVE_KEYS.map((repositoryKey) => ({
        repositoryKey,
        askedBecause: "selection" as const,
        named: true,
      })),
    });
    await applyAnswerWorkScopePlan(db, {
      subjectKey: SUBJECT,
      runId: "run-earlier",
      clarificationId: ANSWERED_EARLIER,
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_answered",
            clarificationId: ANSWERED_EARLIER,
            answer: { kind: "none" },
            answeredBy: { kind: "person", actorId: "u-1", actorLabel: "Ada" },
          },
        ],
      },
    });
  }

  /** The comment posted because the answer left no repository decision behind
   *  it, which is the only one this scenario adds to the ticket. */
  function notRecordedComment(tracker: ReturnType<typeof makeTracker>): string {
    const posted = tracker.postComment.mock.calls
      .map(([, body]) => body)
      .filter((body) => body.includes("It means the same question may be asked again"));
    expect(posted).toHaveLength(1);
    return posted[0] ?? "";
  }

  beforeEach(() => {
    // The resume itself is not what this is about, and a failing one would spend
    // the delivery budget and post a second comment.
    mocks.resumeHook.mockResolvedValue(undefined);
  });

  it("does not offer the comment path when an earlier, larger question silenced the ticket's text", async () => {
    await earlierSelectionAnswered();
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    await answer(tracker, row.id, "acme/api and acme/ops", { answerAuthorCount: 2 });

    const comment = notRecordedComment(tracker);
    expect(comment).not.toContain(COMMENT_PATH_WORKS);
    // This question is not the one about the ticket's text, so it cannot say
    // the route is shut for that reason either; it names the routes that work.
    expect(comment).toContain(ONLY_THE_RECORD);
  });

  // R8. Before, an unsilenced subject and a two-repository discovery question
  // counted two and offered the comment; nothing here can tell whether the
  // ticket names three open repositories besides.
  it("does not offer it for a discovery question even when nothing on this work silenced that text", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    await answer(tracker, row.id, "acme/api and acme/ops", { answerAuthorCount: 2 });

    const comment = notRecordedComment(tracker);
    expect(comment).not.toContain(COMMENT_PATH_WORKS);
    expect(comment).not.toContain(COMMENT_PATH_IS_A_DEAD_END);
    expect(comment).toContain(ONLY_THE_RECORD);
  });

  // Joint gate F4. The same two repositories, asked about mid run because the
  // workflow's policy keeps them out. Nothing on this surface can tell how many
  // repositories the ticket names, and a path written into a ticket that already
  // names three would tip the next run into asking instead, so the comment route
  // is not offered even though this work has silenced nothing.
  it("offers only the record for a question raised mid run, silenced text or not", async () => {
    const row = await seedPending(
      TWO_ASKED.map((asked) => ({ ...asked, askedBecause: "outside_policy" as const })),
      ["Does this ticket also touch github:acme/api or github:acme/ops?"],
    );
    const tracker = makeTracker();

    await answer(tracker, row.id, "acme/api and acme/ops", { answerAuthorCount: 2 });

    const comment = notRecordedComment(tracker);
    expect(comment).not.toContain(COMMENT_PATH_WORKS);
    expect(comment).not.toContain(COMMENT_PATH_IS_A_DEAD_END);
    expect(comment).toContain(ONLY_THE_RECORD);
  });

  // And the which-of-these question about the ticket's text, however few it
  // offered: it is raised only while more than three open repositories stand,
  // and with the ones the work already holds left out of its choices it may list
  // two. The count of its own list proves nothing there.
  it("never offers it for the which-of-these question about the ticket's text", async () => {
    const row = await seedPending(TWO_ASKED, [
      "More than 3 repositories match this ticket. Which repositories are essential for the initial research?" +
        " Reply with one or more of: github:acme/api, github:acme/ops.",
    ]);
    const tracker = makeTracker();

    await answer(tracker, row.id, "acme/api and acme/ops", { answerAuthorCount: 2 });

    const comment = notRecordedComment(tracker);
    expect(comment).not.toContain(COMMENT_PATH_WORKS);
    expect(comment).toContain(COMMENT_PATH_IS_A_DEAD_END);
  });
});

// Round 5, A4. A person types "no" into the dashboard box, or sends it through
// `runs.answer_clarification`, and every repository that question listed is
// left out of this work from then on. Both channels used to answer "answered"
// and nothing else, so the most consequential thing a one word answer can do
// was the only thing the person who typed it never saw.
describe("answerClarificationAndResume telling a person what their decline recorded", () => {
  const TWO_ASKED: WorkScopeAskedRepository[] = [
    { repositoryKey: "github:acme/api", askedBecause: "selection", named: true },
    { repositoryKey: "github:acme/ops", askedBecause: "selection", named: true },
  ];

  beforeEach(() => {
    mocks.resumeHook.mockResolvedValue(undefined);
  });

  it("names the declined repositories and the way back in the answer's own reply", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "no");

    expect(outcome.kind).toBe("answered");
    const said = outcome.kind === "answered" ? (outcome.recordOutcome ?? "") : "";
    expect(said).toContain("github:acme/api, github:acme/ops");
    expect(said).toContain("declining");
    expect(said).toContain("work_scope.edit");
  });

  // The other half of the same promise: a person who asked for nothing to
  // happen is not sent to a route that will refuse them. A which-of-these
  // question lists repositories the catalog enables and ones it does not, and
  // selecting one of the latter is written nowhere.
  it("says the catalog has to enable a repository before selecting it works", async () => {
    const row = await seedPending(
      [{ repositoryKey: "github:acme/api", askedBecause: "not_enabled", named: true }],
      ["github:acme/api is not enabled here. Should this work use it?"],
    );
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "no");

    const said = outcome.kind === "answered" ? (outcome.recordOutcome ?? "") : "";
    expect(said).toContain("github:acme/api");
    expect(said).toContain("enabled on the repositories screen first");
  });

  // It is the channel that took the answer that owes this sentence. An answer
  // typed on the dashboard or sent over MCP gets it in the reply that comes
  // back, and the ticket has the run itself, which names every repository it
  // started without and why, so posting it there too would tell one story twice
  // in one thread.
  it("does not post the decline to the ticket when the answer came from a screen", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    await answer(tracker, row.id, "no");

    const posted = tracker.postComment.mock.calls.map(([, body]) => body);
    expect(posted.filter((body) => body.includes("was read as declining"))).toHaveLength(0);
  });

  // Round 6, R4, and it is the same rule read from the other channel. "none of
  // these" written as a ticket COMMENT leaves both repositories out of this work
  // for good, one permanent entry each in that person's name. The sentence
  // existed and went back as the answer call's reply, which on this path nobody
  // ever sees: the answer was a comment, and there is no screen behind it. So
  // the ticket heard nothing at all about the most consequential thing three
  // words can do here.
  it("posts the decline to the ticket when the answer arrived as a comment", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "none of these", {
      actor: { id: composedAnswerActorId("human-1"), label: "Ada (via Jira)" },
      answerAuthorCount: 1,
    });

    expect(outcome.kind).toBe("answered");
    const declined = tracker.postComment.mock.calls
      .map(([, body]) => body)
      .filter((body) => body.includes("was read as declining"));
    expect(declined).toHaveLength(1);
    // The same words the other channels carry, so a person reading the ticket
    // and a person reading the screen meet one story.
    expect(declined[0]).toContain("github:acme/api, github:acme/ops");
    expect(declined[0]).toContain("work_scope.edit");
  });

  // AWP-221 on production, 2026-09-18. The same three words, with "no" in front
  // of them on its own line, and the ticket heard nothing: the reply was read as
  // prose nobody could place, and the comment back told that person to answer
  // "none" the next time the question was asked, which is what they had just
  // written. Every phrase in it refuses and one of them names the subject, so it
  // decides, and this channel says what it decided.
  it("posts the decline for a comment that refuses in every phrase it is written in", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "no\nnone of these", {
      actor: { id: composedAnswerActorId("human-1"), label: "Ada (via Jira)" },
      answerAuthorCount: 1,
    });

    expect(outcome.kind).toBe("answered");
    const declined = tracker.postComment.mock.calls
      .map(([, body]) => body)
      .filter((body) => body.includes("was read as declining"));
    expect(declined).toHaveLength(1);
    expect(declined[0]).toContain("github:acme/api, github:acme/ops");
  });

  // And exactly once. A lost resume redelivers the identical answer, which is
  // the same decision arriving again rather than a second one.
  it("does not post the decline again when the same answer is redelivered", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();
    const asJira = {
      actor: { id: composedAnswerActorId("human-1"), label: "Ada (via Jira)" },
      answerAuthorCount: 1,
    };

    await answer(tracker, row.id, "none of these", asJira);
    await answer(tracker, row.id, "none of these", asJira);

    const declined = tracker.postComment.mock.calls
      .map(([, body]) => body)
      .filter((body) => body.includes("was read as declining"));
    expect(declined).toHaveLength(1);
  });

  // M4. An answer that NAMED a repository binds the rest exactly as a decline
  // does: the question listed two, the person named one, and the other is left
  // out of this work with no later run taking it (C11). The bare "no" beside it
  // got the full sentence above and this person got silence, which taught the
  // more careful answer less. It is not called a decline, because they did not
  // make one; it says what was left out and how to bring it back.
  it("names what an answer left out in the reply that answer gets back", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "github:acme/api");

    expect(outcome.kind).toBe("answered");
    const said = outcome.kind === "answered" ? (outcome.recordOutcome ?? "") : "";
    expect(said).toContain("github:acme/ops");
    expect(said).toContain("left out of this work");
    expect(said).toContain("work_scope.edit");
    expect(said).not.toContain("declining");
    // And it stays in the channel that took the answer: on the ticket the run
    // itself lists what it started without, keyed and with the way back, so
    // posting this as well would tell one story twice in one thread.
    const posted = tracker.postComment.mock.calls.map(([, body]) => body);
    expect(posted.filter((body) => body.includes("left out of this work"))).toHaveLength(0);
  });

  // And an answer that named everything the question listed is told nothing,
  // because nothing was left out.
  it("says nothing about a record when the answer named every repository listed", async () => {
    const row = await seedPending(TWO_ASKED, ["Which of these two should this work use?"]);
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "github:acme/api and github:acme/ops");

    expect(outcome.kind === "answered" ? outcome.recordOutcome : "missing").toBeUndefined();
  });
});
