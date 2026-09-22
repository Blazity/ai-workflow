import { asc, eq } from "drizzle-orm";
import { fakeAnswerReadingModel } from "./read-answer.fake.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettingsSnapshot,
  type WorkScopeAskedRepository,
  type WorkScopeWritePlan,
} from "@shared/contracts";
import type { Db } from "../../db/client.js";
import type {
  IssueTrackerAdapter,
  TicketComment,
  TicketContent,
} from "../../adapters/issue-tracker/types.js";
import {
  activeRuns,
  repositories,
  repositoryCatalogState,
  workflowRuns,
  workScopeTrail,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { answerClarificationAndResume } from "../clarifications/answer-core.js";
import { composedAnswerActorId } from "../clarifications/answer-authorship.js";
import {
  recordRepositoryAnswer,
  type RepositoryAnswerPersistence,
} from "./from-answer.js";
import { recordRepositoryAnswer as recordRepositoryAnswerThroughIndex } from "./index.js";
import type { AnswerReadingModel } from "./read-answer.js";
import { TEXT_AMBIGUITY_QUESTION_OPENING } from "../../engine/work-scope/context.js";
import { repositoryDiscoveryQuestion } from "../../engine/repository-discovery/protocol.js";
import { decideWorkScope } from "../../engine/work-scope/decide.js";
import {
  appendWorkScopeQuestionAsked,
  applyRunWorkScopePlan,
  readWorkScope,
  readWorkScopeAnsweredRepositories,
  readWorkScopeSelectionAnswered,
} from "../../db/repositories/work-scope.js";
import {
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
// An answer composed out of a ticket's comments, which is the only way an author
// line ever reaches this path: the actor id says so, and the reader takes the
// line off for that channel alone. A test that writes "Ada: ..." with the plain
// actor above is a shape production never delivers, and it used to pass only
// because the strip ran on every answer.
/** The one line that says an unreadable answer changed nothing and the question
 *  is still waiting, which is the fact every row below turns on. */
const UNREADABLE = "Nothing has been recorded, and this question is still open";

const VIA_JIRA = {
  actor: { id: composedAnswerActorId("human-1"), label: "Ada (via Jira)" },
  answerAuthorCount: 1,
};
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
  extra: {
    actor?: { id: string; label: string };
    answerAuthorCount?: number;
    /** The provider, when a test needs it to be something other than the
     *  stand-in: unreachable, for the fallback rows. */
    generate?: AnswerReadingModel;
    surface?: Parameters<typeof answerClarificationAndResume>[0]["surface"];
  } = {},
) {
  const row = await getHookClarification(db, id);
  if (!row) throw new Error("clarification vanished");
  return answerClarificationAndResume({
    db,
    row,
    rawAnswer: text,
    actor: extra.actor ?? ACTOR,
    surface: extra.surface ?? { kind: "dashboard" },
    ...(extra.answerAuthorCount === undefined
      ? {}
      : { answerAuthorCount: extra.answerAuthorCount }),
    issueTracker: tracker as unknown as Pick<
      IssueTrackerAdapter,
      "fetchTicket" | "moveTicket" | "postComment" | "getCurrentUserAccountId"
    >,
    // A STAND-IN FOR THE MODEL, so these rows prove what a person gets rather
    // than that no provider is reachable from a test. Nothing here is evidence
    // about the real reader; that is the golden set's job.
    answerReadingDeps: { generate: extra.generate ?? fakeAnswerReadingModel() },
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

  it("tells the person when a selection question got words nobody could read", async () => {
    // THE LOOP THIS FEATURE EXISTS TO END, and for a while it ran through here.
    // The flag that silences the selection question is raised by an answer kind
    // of `none` or `repositories` and by nothing else
    // (`db/repositories/work-scope.ts`), so words the reader cannot resolve
    // record nothing AND settle nothing, and the next run asks the same thing.
    // Treating any answer to a selection question as settling it suppressed the
    // one sentence that explains the repeat, which left the person watching
    // their answer vanish with no word about why.
    const row = await seedPending(asked("github:acme/api", "selection"));
    // The trail row a run writes when it asks. Without it the flag read below
    // has no question to find and would answer false for the wrong reason.
    await appendWorkScopeQuestionAsked(db, {
      subjectKey: SUBJECT,
      runId: RUN,
      clarificationId: row.id,
      asked: asked("github:acme/api", "selection"),
    });
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "whichever one the team prefers");

    // ROUND 5: THE QUESTION NO LONGER CLOSES BEHIND AN ANSWER NOBODY COULD
    // READ. It used to be answered, the run resumed, and the same question came
    // back a run later with a sentence explaining the repeat. Now the answer
    // settles nothing and NOTHING MOVES: the row stays pending, the run stays
    // parked on this question, and the next reply is read against it. The
    // sentence is no longer an apology for a repeat, it is a request.
    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    // Read from the statement rather than assumed, because the whole defect was
    // a claim about this flag that the statement does not make.
    await expect(readWorkScopeSelectionAnswered(db, SUBJECT)).resolves.toBe(false);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("I could not");
    expect(posted).toContain(UNREADABLE);
  });

  it('says nothing about "none" to a selection question, because that answer settles it', async () => {
    // The positive control, and the reason the fix reads the answer kind rather
    // than dropping the flag test altogether. This question really is over: the
    // statement raises the flag, no later run asks again, and a sentence saying
    // it may would name a fault that is not there.
    const row = await seedPending(asked("github:acme/api", "selection"));
    // The trail row a run writes when it asks. Without it the flag read below
    // has no question to find and would answer false for the wrong reason.
    await appendWorkScopeQuestionAsked(db, {
      subjectKey: SUBJECT,
      runId: RUN,
      clarificationId: row.id,
      asked: asked("github:acme/api", "selection"),
    });
    const tracker = makeTracker();

    await answer(tracker, row.id, "none");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(readWorkScopeSelectionAnswered(db, SUBJECT)).resolves.toBe(true);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).not.toContain("recorded no repository decision from it");
  });

  it("says nothing when a selection question was answered with a repository it can resolve", async () => {
    // The other half of the control. An answer that decided something is never
    // told that nothing was recorded, whatever the question it answered.
    const row = await seedPending(asked("github:acme/api", "selection"));
    // The trail row a run writes when it asks. Without it the flag read below
    // has no question to find and would answer false for the wrong reason.
    await appendWorkScopeQuestionAsked(db, {
      subjectKey: SUBJECT,
      runId: RUN,
      clarificationId: row.id,
      asked: asked("github:acme/api", "selection"),
    });
    const tracker = makeTracker();

    await answer(tracker, row.id, "github:acme/api");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
    ]);
    await expect(readWorkScopeSelectionAnswered(db, SUBJECT)).resolves.toBe(true);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).not.toContain("recorded no repository decision from it");
  });

  it("tells an answer several people wrote whose words it is, not that it named nothing", async () => {
    // Both sentences became reachable for one answer here. Several authors make
    // it `unattributed`, which the statement does not count either, so it now
    // falls through to the naming sentences as well, and that sentence would
    // tell this person their answer named no repository when the real reason is
    // that several people wrote it. `services/clarifications/answer-core.ts`
    // takes the authorship sentence first and the record's second, which is the
    // more specific of the two; this row pins that ordering so a later change to
    // either side cannot silently swap them.
    const row = await seedPending(asked("github:acme/api", "selection"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "Ada: github:acme/api\n\nBob: actually the other one", {
      answerAuthorCount: 2,
    });

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("More than one person wrote into this answer");
    expect(posted).not.toContain("Nothing in that answer named a repository");
    expect(posted).not.toContain("That answer named a repository this deployment does not have");
  });

  it("leaves no mark at all from an answer whose words nobody could read", async () => {
    // It used to write one trail row saying an answer arrived and decided
    // nothing. Now nothing is written, because nothing happened: the row is
    // still pending and this delivery may be repeated word for word by the next
    // poll tick, so a row per attempt would be a history of our retries rather
    // than of anybody's decisions. The cost is real and named here so nobody
    // finds it by surprise: the subject's history no longer shows that somebody
    // answered and we could not read them. Recovering that needs a trail event
    // of its own rather than the answered one, which is a contract change.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));

    const outcome = await answer(makeTracker(), row.id, "whichever one the team prefers");

    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([]);
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

    const outcome = await answer(tracker, row.id, "whichever one the team prefers");

    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
    // THE LIST ITSELF, offered back. The question is still open, so what a
    // person needs is the vocabulary that ends it here and now rather than a
    // note about what will work the next time they are asked.
    // The question offered ONE repository, so the reply that ends it is a yes
    // or a no about that repository, in its own words.
    expect(posted).toContain("github:acme/api");
    expect(posted).toContain('"yes"');
  });

  // M3. This comment told people that nothing written on this ticket can record
  // a refusal, while the same delivery posts a comment on the same ticket saying
  // an answer was read as declining what the question listed. One of the two was
  // false, and it was this one: a comment IS how a ticket answers a question
  // that is still open, and "none" written there declines every repository it
  // listed. The sentence also contradicted itself inside one line, telling a
  // person to answer "none" on the ticket it had just said records no refusal.
  it("does not tell a person a refusal cannot be recorded from this ticket", async () => {
    const row = await seedPending(asked("github:acme/api", "selection"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "Ada: no", VIA_JIRA);

    // ROUND 5 CHANGES NOTHING HERE, and that is worth a line. The reading says
    // this bare "no" declines the one repository it was asked about, and the
    // record still refuses to write it, because whether these words were
    // addressed to us is a question no reading can answer: nothing threads a
    // ticket comment to our question. What is true instead, both halves: the
    // keyword works when the question comes back, and a bare no in a comment is
    // the one that does not.
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).not.toContain("Nothing written on this ticket can record a refusal");
    expect(posted).toContain(
      'When the question comes back, answering "none" declines every repository it lists',
    );
    expect(posted).toContain('a bare "no" in a comment does not');
  });

  it("tells the person nothing was recorded when they named a repository this deployment does not hold", async () => {
    // The two halves of this row were proved on two different inputs: that an
    // unresolvable name records nothing (`engine/work-scope/answer.ts`, where
    // an identity that resolves against nothing makes the whole answer
    // unrecognised), and that a person is told, on an answer of pure prose.
    // This is the row's own input through both halves at once.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "github:acme/unknown-service");

    // ROUND 5. A key nobody offered is no longer sorted into its own diagnostic:
    // the reading is thrown away whole, which is the boundary that stops a model
    // writing a decision about a repository the question never showed anybody,
    // and the same boundary catches a person's typo. What they get is the
    // question again with the keys that are real, which is the one thing that
    // ends this exchange; the old sentence explained a dead end without offering
    // a way out of it.
    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
    expect(posted).toContain("github:acme/api");
    expect(posted).not.toContain("write its full path in a comment here");
  });

  it("keeps the remedy that works for an answer that spelled no path out, which is not the one for a name we do not hold", async () => {
    // The other half of the same fork, and the reason the fork exists. Nothing
    // here was written as a path, so nothing about it is a dead end: a change
    // that gave everybody the "we do not have that" sentence would be a lie
    // told to them. What they are sent to is the route that works whatever the
    // ticket says, because this surface cannot count the ticket's open
    // repositories and so never offers the comment (joint gate round 3, R8).
    const row = await seedPending(asked("github:acme/api", "selection"));
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "the billing service");

    // ROUND 5. One sentence now serves both halves of the old fork, and it is
    // the one neither half had: the question, put again, with the repositories
    // it offered. Nothing here sends anybody to a route that may be shut.
    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
    expect(posted).toContain("github:acme/api");
    expect(posted).not.toContain("write its full path in a comment here");
  });

  it("sends an answer to a question raised mid run to the record, because nothing here proves a comment is read", async () => {
    // Joint gate F4. The same answer to a question the workflow's policy raised.
    // How many repositories the ticket names is not known on this surface, and a
    // path written into a ticket that already names three tips the next run into
    // asking instead of reading it, so the only route offered is one that works.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "the billing service");

    // ROUND 5. Same as its neighbour: the question is still open, so the reply
    // that ends it is the one offered, and no route that this surface cannot
    // vouch for is named at all.
    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
    // No route that writes a repository's path into the ticket, in any of its
    // wordings. Replying to the still open question in a comment is a different
    // route and a vouched one: the comment path reads replies while the question
    // is pending (rule 6 in comment-format.test.ts), and this note names it when
    // the ticket was just moved back to the backlog to wait for that reply.
    expect(posted).not.toMatch(/paths? [^.]*in a comment/i);
  });

  // A discovery question listing four candidates, and the same question one
  // candidate shorter. Before joint gate round 3 (R8) the four were told the
  // comment route was shut and the three were sent to it, by the count of the
  // question's own list; the ticket beside the question could name more open
  // repositories than either, and that count is the one the next run decides
  // on. Neither is sent to write a path now, and neither is told a reason for
  // the route being shut that nothing here can see.
  /** A question that put TWO repositories in front of somebody, for the rows
   *  about what an answer naming several of them records. The keys a reading may
   *  return are the keys the question offered, so a row about naming two has to
   *  be asked about two. */
  const TWO_ASKED: WorkScopeAskedRepository[] = ["github:acme/api", "github:acme/web"].map(
    (repositoryKey) => ({ repositoryKey, askedBecause: "selection", named: true }),
  );

  const FOUR_ASKED: WorkScopeAskedRepository[] = [
    "github:acme/api",
    "github:acme/web",
    "github:acme/jobs",
    "github:acme/docs",
  ].map((repositoryKey) => ({ repositoryKey, askedBecause: "selection", named: true }));

  it.each([
    ["four", FOUR_ASKED],
    ["three", FOUR_ASKED.slice(0, 3)],
  ])("offers the question and the repository list, not a comment, for a question that listed %s", async (_, list) => {
    const row = await seedPending(list);
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "the billing service");

    // ROUND 5. Whatever the list's length, the person is offered the list, on
    // the question they are still being asked. Neither count is sent to write a
    // path, and neither is told a reason for a route being shut that nothing
    // here can see.
    expect(outcome.kind).toBe("answer_unclear");
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
    expect(posted).not.toContain("write its full path in a comment here");
    expect(posted).not.toContain("more than three repositories");
    for (const repository of list) expect(posted).toContain(repository.repositoryKey);
  });

  it("gives the fuller explanation when one answer carries both a bare name and a path we do not hold", async () => {
    // Both sentences are true for this person, and the longer one is the one
    // they cannot work out for themselves: that a name they spelled out in full
    // is not here at all. The shorter one would leave them writing that path
    // again and waiting for a run that reads it to nothing.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "billing, or github:acme/unknown-service");

    // ROUND 5. Neither half is sorted any more: an answer that settles nothing
    // gets the question back with the keys that exist, which is what a person
    // carrying either problem needs to type next.
    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
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

    // ROUND 5, AND THE THIRD HALF IS GONE. A thumbs up used to read as approval
    // to the run and as nothing to the record, so the run carried on WITHOUT the
    // repository somebody had just approved of. There is one reader now and it
    // settles nothing from an emoji, so the run does not carry on at all: it
    // waits on the question, and the person is asked for a word.
    expect(outcome.kind).toBe("answer_unclear");
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain(UNREADABLE);
    expect(posted).not.toContain("continuing without the repositories the question asked about");
  });

  it("selects nothing when the person quoted our question and said no under it", async () => {
    // Jira's quote button flattens to text with no marker on it, so without the
    // questions the row carries, our own repository key comes back looking like
    // the person's selection and is recorded against their name forever.
    //
    // Round 4: with our words out, what they wrote is "no", and this box
    // belongs to this question, so it is recorded as the decline it is. The
    // fact that must never change is the direction: their word never becomes a
    // selection of the repository our own question named.
    const question = "Does this ticket also touch github:acme/web? Reply with none if not.";
    const row = await seedPending(asked("github:acme/web", "not_enabled"), [question]);

    await answer(makeTracker(), row.id, `${question}\n\nno`);

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/web",
        state: "unavailable",
        origin: "person",
        decidedBy: PERSON,
      }),
    ]);
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "none" },
        answeredBy: PERSON,
      },
      expect.objectContaining({ kind: "entry_written", clarificationId: row.id }),
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

  // Round 4, and this test changed meaning. A redirect used to be recorded as
  // two decisions at once, the refusal and the choice beside it. It is a reply
  // that says no, so it records nothing, and the person is told what to write
  // instead: the round it costs is the price of never recording the opposite of
  // what somebody wrote.
  it("records nothing from a redirect and tells the person why", async () => {
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    const outcome = await answer(tracker, row.id, "not acme/api, use github:acme/web");

    // ROUND 5. The question offered ONE repository and the reply pushes exactly
    // that one away, so it is the decline it plainly is and it is recorded.
    // github:acme/web is NOT recorded, and that is the rule this reading is
    // built on rather than an oversight: a model may never widen what was
    // asked, and the question never put web in front of anybody. What a person
    // wanting web does instead is edit the record, which the sentence says.
    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "excluded" }),
    ]);
    // In the reply rather than on the ticket, because this answer came from the
    // dashboard: each person is told once, where they answered.
    expect(outcome).toMatchObject({
      kind: "answered",
      recordOutcome: expect.stringContaining("read as declining github:acme/api"),
    });
  });

  // Joint gate round 3, R1, as the person meets it: the question said acme/web
  // stays whatever they reply, they tried to drop it anyway, and they read on
  // the ticket why nothing happened and where that is done instead.
  it("tells the person on the ticket that a reply does not drop a repository the work already holds", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey: SUBJECT,
      runId: "run-0",
      plan: {
        upserts: [
          {
            entry: {
              repositoryKey: "github:acme/web",
              state: "selected",
              origin: "ticket_text",
              rationale: "The ticket text names this repository path.",
              decidedBy: { kind: "run", runId: "run-0", definitionId: 1, definitionVersion: 1 },
              decidedAt: "2026-09-16T09:00:00.000Z",
            },
            replacesExpired: false,
          },
        ],
        deletes: [],
        trail: [],
      },
    });
    const row = await seedPending(asked("github:acme/api", "selection"), [
      "More than 3 repositories match this ticket. Which repositories are essential for the initial research?" +
        " Reply with one or more of: github:acme/api. Already part of this work, and kept whatever you reply:" +
        " github:acme/web. Your reply does not remove them.",
    ]);
    const tracker = makeTracker();

    await answer(tracker, row.id, "github:acme/api, but not github:acme/web");

    // ROUND 5. The reply points AT api and pushes web away, so api is selected
    // and web is untouched: the question said web stays whatever the reply, and
    // a name under a negation is never a selection of that name either. What the
    // person tried to do to web still does not happen; what changed is that the
    // half of their reply that WAS a choice is no longer thrown away with it.
    await expect(entriesOfSubject()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repositoryKey: "github:acme/web", origin: "ticket_text" }),
        expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
      ]),
    );
  });

  it("reads a bare list of names sent as a Jira comment, author line and all", async () => {
    const row = await seedPending(TWO_ASKED);

    await answer(makeTracker(), row.id, "Ada: api, web", VIA_JIRA);

    await expect(entriesOfSubject()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
        expect.objectContaining({ repositoryKey: "github:acme/web", state: "selected" }),
      ]),
    );
  });

  it("records nothing about a bare name the question never offered, and says so", async () => {
    // A MODEL STILL NEVER WIDENS WHAT WAS ASKED. The question put one repository
    // in front of this person; they named it and one more. The reading's keys
    // stay a subset of what we handed it, and the other name is looked up by our
    // code instead (A19c): a full path this deployment holds is taken, and a
    // bare word like "web" is not resolved at all (A3), because it is a word
    // before it is a repository. So here only api is recorded.
    const row = await seedPending(asked("github:acme/api", "selection"));

    const outcome = await answer(makeTracker(), row.id, "api and web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "selected" }),
    ]);
    // AND THEY ARE TOLD, which is the whole of it. The decision they made
    // clearly is honoured and the run carries on; the half we could not act on
    // is named out loud, in the channel they answered in, with somewhere to go.
    // Dropping it in silence is the founding complaint of this delivery wearing
    // a different coat: they named two repositories because they believe both
    // are needed, the run does half the job and finishes green, and they find
    // out from a pull request that is missing the other half.
    expect(outcome).toMatchObject({
      kind: "answered",
      recordOutcome: expect.stringContaining("web"),
    });
    const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
    expect(said).toContain("could not be matched to a repository this deployment holds");
    // A bare word is never resolved, so what they need to hear is how a
    // repository is matched, not a list that would refuse the word as well.
    expect(said).toContain("A repository is matched by its full path");
    expect(said).not.toContain("work_scope.edit");
  });

  it("records every repository in a list of several as that one person's own decision", async () => {
    // The row is about ALL of them: each key the answer names is selected, each
    // carries the person who typed it, and the trail says so for each. Until
    // this test, origin and author for an answer naming more than one rested
    // entirely on the single-name test above, and a loop that wrote the second
    // key some other way would have kept both green.
    const row = await seedPending(TWO_ASKED);

    await answer(makeTracker(), row.id, "github:acme/api and github:acme/web");

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

    await answer(makeTracker(), row.id, "Filip Maszota: api, web", VIA_JIRA);

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

    await answer(makeTracker(), row.id, "Filip Maszota: api\n\nFilip Maszota: web", VIA_JIRA);

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

    await answer(makeTracker(), row.id, "Ada: Sure.\n\nacme/api: that is the backend", VIA_JIRA);

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

    await answer(makeTracker(), row.id, "Anna Kowalska / Blazity: api, web", VIA_JIRA);

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

    await answer(makeTracker(), row.id, "Filip Maszota: api\nweb: tools", VIA_JIRA);

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

  /**
   * THE SAME ANSWER, REACHED THROUGH THE QUESTION THAT REALLY ASKED IT.
   *
   * The row above proves the answer path keeps a path somebody typed into a
   * repository question that listed nothing. What broke on production was the
   * link in front of it: the question discovery raises in its OWN words carried
   * no ask at all, so the row reached the answer path as a clarification about
   * some other subject and was read as nobody's decision.
   *
   * AWP-263, 2026-09-20, definition 40. Discovery asked "Which repository
   * contains the pricing helper to tidy?", a person answered
   * github:blazity/ai-workflow-demo through runs.answer_clarification, and the
   * record ended with no entry, no trail row and no sentence. The next question
   * offered that repository as a fresh candidate.
   *
   * Driven from `repositoryDiscoveryQuestion` rather than from a hand-written
   * ask, because the ask is the thing that was wrong: a test that seeds one
   * itself proves the half that already worked.
   */
  it("keeps the repository a person names to a discovery question that offered no candidate", async () => {
    const question = "Which repository contains the pricing helper to tidy?";
    // The decision `validateRepositoryDiscoveryResult` returns when the model
    // asks a question of its own: its words, and no candidate.
    const { ask } = repositoryDiscoveryQuestion({
      decision: {
        kind: "clarification_needed",
        questions: [question],
        reason: "model_requested_clarification",
        about: [],
      },
      subjectKey: SUBJECT,
      recorded: [],
      catalog: [],
    });
    const row = await seedPending(ask?.askedRepositories, [question]);
    // The trail row the asking run writes beside the clarification
    // (`prepareClarificationHookStep`), which the seed above does not.
    if (ask) {
      await appendWorkScopeQuestionAsked(db, {
        subjectKey: SUBJECT,
        runId: RUN,
        clarificationId: row.id,
        asked: ask.askedRepositories,
      });
    }

    const outcome = await answer(makeTracker(), row.id, "github:acme/web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({
        repositoryKey: "github:acme/web",
        state: "selected",
        origin: "person",
        decidedBy: PERSON,
      }),
    ]);
    // AND A TRAIL ROW, so somebody can see what the answer did. It is the only
    // place the answer shows up at all when it decides nothing, and on
    // production it was missing for an answer that decided plenty.
    await expect(trailEvents()).resolves.toEqual([
      {
        kind: "question_asked",
        clarificationId: row.id,
        repositories: [],
      },
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "repositories", repositoryKeys: ["github:acme/web"] },
        answeredBy: PERSON,
      },
      expect.objectContaining({ kind: "entry_written", clarificationId: row.id }),
    ]);
    // No sentence, which is the contract of the field: absent means the answer
    // recorded exactly what it named. On production it was absent and nothing
    // had been recorded at all.
    expect(outcome).toMatchObject({ kind: "answered" });
    expect(outcome).not.toHaveProperty("recordOutcome");
  });

  /**
   * AND THE SAME QUESTION ANSWERED WITH SOMETHING THAT DECIDES NOTHING.
   *
   * The half that costs a person a repeated question rather than a lost
   * decision, and the one the absent `recordOutcome` used to lie about: on
   * production the tool returned no sentence, which by its own contract means
   * the answer recorded what it named, to somebody whose answer recorded
   * nothing.
   */
  it("tells a person their answer to a candidate-less question recorded nothing", async () => {
    const question = "Which repository contains the pricing helper to tidy?";
    const { ask } = repositoryDiscoveryQuestion({
      decision: {
        kind: "clarification_needed",
        questions: [question],
        reason: "model_requested_clarification",
        about: [],
      },
      subjectKey: SUBJECT,
      recorded: [],
      catalog: [],
    });
    const row = await seedPending(ask?.askedRepositories, [question]);
    if (ask) {
      await appendWorkScopeQuestionAsked(db, {
        subjectKey: SUBJECT,
        runId: RUN,
        clarificationId: row.id,
        asked: ask.askedRepositories,
      });
    }

    const outcome = await answer(makeTracker(), row.id, "the one with the pricing code in it");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    await expect(trailEvents()).resolves.toEqual([
      { kind: "question_asked", clarificationId: row.id, repositories: [] },
      {
        kind: "question_answered",
        clarificationId: row.id,
        answer: { kind: "unrecognised" },
        answeredBy: PERSON,
      },
    ]);
    expect(outcome).toMatchObject({
      kind: "answered",
      recordOutcome: expect.stringContaining("recorded no repository decision from it"),
    });
  });

  /**
   * WHAT A DECLINE ON THE WHICH-OF-THESE QUESTION IS TOLD, checked against what
   * the record actually holds rather than against a copy of the sentence.
   *
   * A7 is a held product decision: such a decline writes no entry, because
   * leaving a name out of an answer is a weaker thing than an entry, and the
   * question plus the answer on the Decision Trail bind it instead. The
   * sentence said "this work is recorded as leaving it out" anyway.
   *
   * AWP-263, 2026-09-20: the person read that sentence, opened the record, found
   * `entries: []` and a dashboard saying nobody had decided about the
   * repository, and reported a lost answer. Nothing was lost. The sentence
   * pointed at the one place the decision is not.
   */
  it("never tells a person a which-of-these decline is in a list the record leaves empty", async () => {
    const question =
      "Which repository or repositories should this ticket inspect or modify?" +
      " Proposed candidates: github:acme/api.";
    const row = await seedPending(asked("github:acme/api", "selection"), [question]);
    // The trail row the asking run writes beside the clarification: the
    // answered set is a join over the two, so without it a later run has no
    // question to find and the promise below could not be read at all.
    await appendWorkScopeQuestionAsked(db, {
      subjectKey: SUBJECT,
      runId: RUN,
      clarificationId: row.id,
      asked: asked("github:acme/api", "selection"),
    });

    const outcome = await answer(makeTracker(), row.id, "no");

    // What the record holds, which is what the sentence has to be true about.
    await expect(entriesOfSubject()).resolves.toEqual([]);
    const recordOutcome =
      outcome.kind === "answered" ? (outcome.recordOutcome ?? "") : "no answer";
    expect(recordOutcome).toContain("read as declining github:acme/api");
    expect(recordOutcome).not.toContain("recorded as leaving");
    expect(recordOutcome).toContain("Decision Trail");
    // AND THE DECISION IS SOMEWHERE, which is the other half of being honest
    // about it: the trail carries it and a later run reads it from there.
    await expect(readWorkScopeAnsweredRepositories(db, SUBJECT)).resolves.toEqual([
      "github:acme/api",
    ]);
  });

  /**
   * AND WHERE A DECLINE DOES WRITE AN ENTRY, the sentence still says so.
   *
   * A7b, the contrast A7 is defined against: a repository the deployment cannot
   * enable was never refused by the person, so the decline writes `unavailable`
   * and the record IS where they will find it. Collapsing both cases into the
   * trail wording would be the same defect with its sign flipped.
   */
  it("still names the record where a decline of an unavailable repository writes one", async () => {
    const row = await seedPending(asked("github:acme/api", "not_enabled"), [
      "Does this ticket also touch github:acme/api? Reply with none if not.",
    ]);

    const outcome = await answer(makeTracker(), row.id, "no");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api", state: "unavailable" }),
    ]);
    const recordOutcome =
      outcome.kind === "answered" ? (outcome.recordOutcome ?? "") : "no answer";
    expect(recordOutcome).toContain("this work is recorded as leaving it out");
    expect(recordOutcome).not.toContain("Decision Trail");
  });
});

describe("recordRepositoryAnswer names why a selection question is coming back", () => {
  // The harness rows above prove the person is told; these prove WHICH reason
  // they are told, which is the part a sentence match cannot pin. The condition
  // under test is the one in `db/repositories/work-scope.ts`: the flag counts a
  // recorded answer kind of `none` or `repositories`, so those two settle the
  // question and the other two do not.
  function persistence(): RepositoryAnswerPersistence {
    return {
      repositoryCatalog: () =>
        Promise.resolve({
          activated: true,
          keys: ["github:acme/api", "github:acme/web"],
          enabledKeys: ["github:acme/api", "github:acme/web"],
        }),
      readWorkScope: () => Promise.resolve(null),
      applyAnswerWorkScope: () => Promise.resolve({ outcome: "applied" as const, version: 1 }),
    };
  }

  /** One selection question, answered once, and what the person is told about
   *  it. The question names a repository so the ask is a real one; what makes
   *  it the selection question is the reason, which is the only thing the
   *  predicate under test looks at. */
  async function told(
    answerText: string,
    asked: WorkScopeAskedRepository[] = [
      { repositoryKey: "github:acme/api", askedBecause: "selection", named: true },
    ],
  ) {
    const row = await seedPending(asked, ["Which repository should this ticket modify?"]);
    const stored = await getHookClarification(db, row.id);
    if (!stored) throw new Error("clarification vanished");
    const outcome = await recordRepositoryAnswer(persistence(), {
      row: stored,
      answer: answerText,
      answeredAt: new Date(),
      answerer: ACTOR,
      composedFromComments: false,
    });
    return outcome.told;
  }

  it("says nothing named a repository when the words resolved to none of them", async () => {
    await expect(told("whichever one the team prefers")).resolves.toBe("no_repository_named");
  });

  it("says the deployment does not hold it when the person spelled a path out in full", async () => {
    await expect(told("github:acme/unknown-service")).resolves.toBe("no_such_repository");
  });

  // Round 5, A7. A path inside a quoted line is ours, or somebody else's, and
  // it is never this person spelling one out: judged as theirs it produced the
  // sentence saying this deployment has no repository by that name, about a
  // name they never typed.
  it("does not say the deployment lacks a repository a quoted line named", async () => {
    await expect(told("> see github:acme/unknown-service\nwhichever one the team prefers")).resolves.toBe(
      "no_repository_named",
    );
  });

  // Round 6, R5. "both" under a question that listed three names nothing and is
  // not ambiguous either: the word and the list contradict each other. The
  // person used to read that nothing in their answer named a repository, which
  // says nothing about the count, so the obvious second attempt is the same
  // word and the loop runs again.
  it("says the counting word disagreed with the list when it did", async () => {
    const three: WorkScopeAskedRepository[] = ["api", "web", "docs"].map((name) => ({
      repositoryKey: `github:acme/${name}`,
      askedBecause: "selection" as const,
      named: true,
    }));
    await expect(told("both", three)).resolves.toBe("counting_word_and_list_disagree");
  });

  // The control: the same word against the list it agrees with is a decision,
  // and nobody is told anything about it.
  it("tells nobody anything about a counting word the list agrees with", async () => {
    const two: WorkScopeAskedRepository[] = ["api", "web"].map((name) => ({
      repositoryKey: `github:acme/${name}`,
      askedBecause: "selection" as const,
      named: true,
    }));
    await expect(told("both", two)).resolves.toBeUndefined();
  });

  it('tells nobody anything about "none", which settles the question', async () => {
    await expect(told("none")).resolves.toBeUndefined();
  });

  it("tells nobody anything about an answer that named a repository", async () => {
    await expect(told("github:acme/api")).resolves.toBeUndefined();
  });
});

describe("recordRepositoryAnswer reached through the cluster's interface", () => {
  // What an answer decides about repositories is this cluster's business, and a
  // caller outside the cluster reaches it only through `index.ts`. So that
  // export IS the interface: take the line out and this file stops resolving,
  // and while it stands, an answer recorded through it has to leave exactly the
  // record its own path leaves.
  function capturing(plans: WorkScopeWritePlan[]): RepositoryAnswerPersistence {
    return {
      repositoryCatalog: () =>
        Promise.resolve({
          activated: true,
          keys: ["github:acme/web"],
          enabledKeys: ["github:acme/web"],
        }),
      readWorkScope: () => Promise.resolve(null),
      applyAnswerWorkScope: ({ plan }) => {
        plans.push(plan);
        return Promise.resolve({ outcome: "applied" as const, version: 1 });
      },
    };
  }

  it("records the same answer through index.ts as through its own path", async () => {
    const row = await seedPending([
      { repositoryKey: "github:acme/web", askedBecause: "not_enabled", named: true },
    ]);
    const stored = await getHookClarification(db, row.id);
    if (!stored) throw new Error("clarification vanished");
    // One input, so the only difference between the two calls is which path
    // reached the module.
    const input = {
      row: stored,
      answer: "github:acme/web please",
      answeredAt: new Date(),
      answerer: ACTOR,
      composedFromComments: false,
    };

    const ownPath: WorkScopeWritePlan[] = [];
    const throughIndex: WorkScopeWritePlan[] = [];
    const ownPathOutcome = await recordRepositoryAnswer(capturing(ownPath), input);
    const throughIndexOutcome = await recordRepositoryAnswerThroughIndex(
      capturing(throughIndex),
      input,
    );

    expect(ownPath[0]?.upserts).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({
          repositoryKey: "github:acme/web",
          state: "selected",
          origin: "person",
        }),
      }),
    ]);
    expect(throughIndex).toEqual(ownPath);
    expect(throughIndexOutcome).toEqual(ownPathOutcome);
  });
});

/**
 * The which-of-these question names the repositories this work already holds as
 * kept, and offers only the rest as choices (A11g). A reply that says no beside
 * one of those kept repositories is the one reply this reader cannot split: the
 * no may be about the kept repository, which an answer does not remove, and
 * reading it as a redirect records that very repository as the person's own
 * selection while the one actually asked about is silenced for good.
 */
describe("an answer that says no about a repository the question showed as kept", () => {
  const KEPT = ["github:acme/api", "github:acme/docs", "github:acme/web"];
  const QUESTION =
    "More than 3 repositories match this ticket. Which repositories are essential for the initial research?" +
    " Reply with one or more of: github:acme/infra. Already part of this work, and kept whatever you reply:" +
    " github:acme/web, github:acme/api, github:acme/docs. Your reply does not remove them.";
  const ASKED: WorkScopeAskedRepository[] = [
    { repositoryKey: "github:acme/infra", askedBecause: "selection", named: true },
  ];
  const JIRA_ACTOR = "jira-comments:AWT-9";

  function keptByTheText(keys: string[]) {
    return {
      subjectKey: SUBJECT,
      version: 3,
      entries: keys.map((repositoryKey) => ({
        repositoryKey,
        state: "selected" as const,
        origin: "ticket_text" as const,
        rationale: "The ticket text names this repository path.",
        decidedBy: { kind: "run" as const, runId: "run-0", definitionId: 1, definitionVersion: 1 },
        decidedAt: "2026-09-16T09:00:00.000Z",
      })),
    };
  }

  async function record(
    answerText: string,
    options: {
      asked?: WorkScopeAskedRepository[];
      questions?: string[];
      kept?: string[];
      composedFromComments?: boolean;
    } = {},
  ) {
    const row = await seedPending(options.asked ?? ASKED, options.questions ?? [QUESTION]);
    const stored = await getHookClarification(db, row.id);
    if (!stored) throw new Error("clarification vanished");
    const plans: WorkScopeWritePlan[] = [];
    const persistence: RepositoryAnswerPersistence = {
      repositoryCatalog: () =>
        Promise.resolve({
          activated: true,
          keys: [...KEPT, "github:acme/infra", "github:acme/billing"],
          enabledKeys: [...KEPT, "github:acme/infra", "github:acme/billing"],
        }),
      readWorkScope: () =>
        Promise.resolve(keptByTheText(options.kept ?? KEPT) as Awaited<
          ReturnType<RepositoryAnswerPersistence["readWorkScope"]>
        >),
      applyAnswerWorkScope: ({ plan }) => {
        plans.push(plan);
        return Promise.resolve({ outcome: "applied" as const, version: 4 });
      },
    };
    const outcome = await recordRepositoryAnswer(persistence, {
      row: stored,
      answer: answerText,
      answeredAt: new Date("2026-09-17T10:00:00.000Z"),
      answerer:
        options.composedFromComments === false ? ACTOR : { id: JIRA_ACTOR, label: "Ada" },
      composedFromComments: options.composedFromComments ?? true,
      authorCount: 1,
    });
    const answered = plans
      .flatMap((plan) => plan.trail)
      .flatMap((event) => (event.kind === "question_answered" ? [event.answer] : []));
    return {
      told: outcome.told,
      declined: outcome.declined,
      upserts: plans.flatMap((plan) => plan.upserts),
      deletes: plans.flatMap((plan) => plan.deletes),
      answered,
    };
  }

  // Joint gate round 3, R1: every phrasing the skeptic's probe used. Each one
  // recorded acme/web as the person's own selection and silenced acme/infra.
  const PHRASINGS = [
    "please drop github:acme/web, it is not part of this",
    "github:acme/infra, but not github:acme/web",
    "remove acme/web from this work",
    // The skeptic's scenario S1 and S2 spellings: a bare name, a link, Polish.
    "drop web",
    "https://github.com/acme/web is out of scope",
    "nie ruszajcie web",
    "github:acme/infra bez github:acme/web",
    "github:acme/infra, web is not needed",
    // S7: naming only kept repositories, positively.
    "keep github:acme/web and github:acme/api",
  ];
  it.each(
    PHRASINGS.flatMap((words) => [
      { words, channel: "a ticket comment", composedFromComments: true },
      { words, channel: "the dashboard", composedFromComments: false },
    ]),
  )("records nothing from $words sent through $channel, and tells the person why", async ({
    words,
    composedFromComments,
  }) => {
    const result = await record(composedFromComments ? `Ada: ${words}` : words, {
      composedFromComments,
    });

    expect(result.upserts).toEqual([]);
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    expect(result.told).toBe("names_kept_repository");
  });

  // A plain yes to a question that shows kept repositories beside one choice
  // could mean the choice or could mean "fine, keep those": the one-repository
  // agreement rule was written for a question about ONE repository.
  it("does not read a plain yes as the one choice when the question also showed kept repositories", async () => {
    const result = await record("Ada: yes");

    expect(result.upserts).toEqual([]);
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    expect(result.told).toBeDefined();
  });

  // S7: a kept repository named beside the choice is not turned into the
  // person's own selection; its entry keeps the reason it is held for.
  it("records the choice a person named, and nothing about a kept repository beside it", async () => {
    const both = await record("Ada: github:acme/web and github:acme/infra");

    expect(both.upserts.map((upsert) => upsert.entry.repositoryKey)).toEqual(["github:acme/infra"]);
    expect(both.told).toBeUndefined();
  });

  // R1 widened (S3): the same misreading for a repository the question never
  // showed. A no beside billing never selects billing, and the choice named
  // beside it is not taken on a reply that could not be split.
  it("records nothing from a no beside a repository nobody showed, and says why", async () => {
    const beside = await record("Ada: github:acme/infra, but please do not touch github:acme/billing");

    expect(beside.upserts).toEqual([]);
    expect(beside.answered).toEqual([{ kind: "unrecognised" }]);
    expect(beside.told).toBe("refusal_beside_named");
  });

  it("records nothing from a no about a repository nobody showed, and says why", async () => {
    const alone = await record("Ada: please do not touch github:acme/billing");

    expect(alone.upserts).toEqual([]);
    expect(alone.answered).toEqual([{ kind: "unrecognised" }]);
    // Round 4: it names a repository and says no about it, which is the
    // sentence that is true of it. "Nothing in that answer named a repository"
    // would read as nonsense to somebody who had just named one.
    expect(alone.told).toBe("refusal_beside_named");
  });

  // Round 4, m8. Repository discovery stamps `selection` on its asks as well,
  // and its question lists nothing as kept, so a reader keying on the ask
  // reason told this person their answer had been about repositories nobody
  // put in front of them, and recorded nothing from a reply that named one.
  // What the person was shown is a fact about the question, so it is read
  // there.
  it("treats nothing as kept on a question that listed no kept repositories", async () => {
    // The reply names a repository the RECORD holds for a reason of its own,
    // which is what the kept rule is about, and which this question never
    // showed as kept because it showed nothing as kept.
    const result = await record("Ada: github:acme/web", {
      asked: [{ repositoryKey: "github:acme/infra", askedBecause: "selection", named: true }],
      questions: [
        "Repository discovery was not confident enough to select automatically." +
          " Which repository or repositories should this ticket inspect or modify?" +
          " Proposed candidates: github:acme/infra (the ticket names the dashboard).",
      ],
    });

    expect(result.told).toBeUndefined();
    expect(result.upserts.map((upsert) => upsert.entry.repositoryKey)).toEqual([
      "github:acme/web",
    ]);
    expect(result.upserts[0]?.entry.origin).toBe("person");
  });

  it("still records the choice a person named, beside the kept repositories", async () => {
    const result = await record("Ada: github:acme/infra");

    expect(result.upserts).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({
          repositoryKey: "github:acme/infra",
          state: "selected",
          origin: "person",
        }),
      }),
    ]);
    expect(result.told).toBeUndefined();
  });

  // Round 4, and this test changed meaning with the rule. A question raised
  // mid run shows no kept repositories, which used to be what let a redirect
  // through here; the rule does not care where the question came from, because
  // the thing it refuses to guess at is the same in both places. The reply
  // records nothing and the person is told the one thing that works.
  it("records nothing from a redirect to a question raised mid run", async () => {
    const result = await record("not acme/infra, use github:acme/web instead", {
      asked: [{ repositoryKey: "github:acme/infra", askedBecause: "outside_policy", named: true }],
      questions: ["Should this work also use github:acme/infra?"],
    });

    expect(result.upserts).toEqual([]);
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    expect(result.told).toBe("refusal_beside_named");
  });

  // Joint gate round 3, R4. A bare no posted on the ticket is threaded to
  // nothing, and on a selection question it used to settle the asked
  // repositories for good in that person's name (A8).
  it("records nothing from a plain no posted on the ticket, and tells the person what to write", async () => {
    const result = await record("Ada: no");

    expect(result.upserts).toEqual([]);
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    expect(result.told).toBe("unaddressed_refusal");
  });

  // AWP-221 on production, 2026-09-18. The same person, one comment, "no" and
  // "none of these" in it. The bare no above is still nothing anybody can thread
  // to our question (A8); this reply names what it refuses in its second phrase,
  // which could not be about anything else, so it is that person's decision and
  // the record keeps it (A17b).
  it("records a decline from a ticket comment whose every phrase is a refusal", async () => {
    const result = await record("Ada: no\nnone of these");

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.declined).toEqual(["github:acme/infra"]);
    expect(result.told).toBeUndefined();
  });

  // The question production actually asked on AWP-221: four choices, none of
  // them kept. The record path is read against it for the owner's ruling below,
  // because how many repositories the question listed is what gates a refusal
  // about one of them.
  const FOUR_ASKED: WorkScopeAskedRepository[] = [
    "github:acme/infra",
    "github:acme/billing",
    "github:acme/api",
    "github:acme/docs",
  ].map((repositoryKey) => ({ repositoryKey, askedBecause: "selection" as const, named: true }));
  const FOUR_QUESTION =
    "More than 3 repositories match this ticket. Which repositories are essential for the initial" +
    " research? Reply with one or more of: github:acme/infra, github:acme/billing," +
    " github:acme/api, github:acme/docs.";
  const underFourChoices = { asked: FOUR_ASKED, questions: [FOUR_QUESTION], kept: [] };

  // The production case at its real width: four repositories listed, and the
  // answer refuses all of them in two phrases.
  it("declines all four when the comment refuses the whole list in two phrases", async () => {
    const result = await record("Ada: no\nnone of these", underFourChoices);

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.declined).toEqual([
      "github:acme/infra",
      "github:acme/billing",
      "github:acme/api",
      "github:acme/docs",
    ]);
    expect(result.told).toBeUndefined();
  });

  // The owner's ruling of 2026-09-18. "continue without it" refuses ONE
  // repository, so under four choices it is one person talking about one of
  // them, and four permanent exclusions in their name is a decision nobody made.
  it("records nothing from a refusal about one repository when the question listed four", async () => {
    const result = await record("Ada: no, continue without it", underFourChoices);

    expect(result.upserts).toEqual([]);
    expect(result.declined).toBeUndefined();
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    // The sentence that says what to write: nothing in the answer named a
    // repository, so name the ones to use or answer "none".
    expect(result.told).toBe("no_repository_named");
  });

  // The same four phrases on the ticket, where the question is: do they decide,
  // or do they fall to A8 and record nothing? They decide, because each of them
  // says what it refuses, which is the whole list in front of that person.
  // Before they were on the list, the answer was read as naming nothing and the
  // person was asked the identical question again (A17d).
  it.each(["neither", "neither of them", "neither of these", "none of the above"])(
    "declines every repository the question listed from %o posted on the ticket",
    async (words) => {
      const result = await record(`Ada: ${words}`, underFourChoices);

      expect(result.answered).toEqual([{ kind: "none" }]);
      expect(result.declined).toEqual([
        "github:acme/infra",
        "github:acme/billing",
        "github:acme/api",
        "github:acme/docs",
      ]);
      expect(result.told).toBeUndefined();
    },
  );

  // NOTHING COMPOSES AN AUTHOR LINE ON THE DASHBOARD OR THROUGH MCP, so a colon
  // in the reply is the person's own. Read as an author line, "api: none" became
  // a bare "none" and declined every repository the question listed: four
  // permanent exclusions in somebody's name, fabricated out of punctuation.
  it("does not read a colon in a dashboard answer as an author line", async () => {
    const result = await record("api: none", {
      ...underFourChoices,
      composedFromComments: false,
    });

    expect(result.declined).toBeUndefined();
    expect(result.upserts).toEqual([]);
  });

  // And the same strip in the other direction, which cost the person the only
  // repository they named.
  it("keeps the repository a dashboard answer names before a colon", async () => {
    const result = await record("github:acme/api: this is the one", {
      ...underFourChoices,
      composedFromComments: false,
    });

    expect(result.upserts.map((upsert) => upsert.entry.repositoryKey)).toEqual([
      "github:acme/api",
    ]);
    expect(result.told).toBeUndefined();
  });

  // A sentence about what some documents say is not a refusal of a repository,
  // and the reply it used to get told that person their answer named a
  // repository AND said no about it, neither of which they had done, and then
  // taught them a rule they had not broken.
  it("does not tell a person their prose named a repository and refused it", async () => {
    const result = await record("Ada: none of the docs mention it", underFourChoices);

    expect(result.upserts).toEqual([]);
    expect(result.told).toBe("no_repository_named");
  });

  // The keyword rule reads a reply opening with "none" as a refusal whole,
  // whatever follows it, so a person who wrote the keyword AND a repository was
  // told nothing in their answer had named one. Nothing they can do with that
  // sentence is right: it is false, and it never names the rule they fell foul
  // of, which is that a reply saying no about anything records nothing.
  it("tells a person who named a repository after the keyword why it was not read as a choice", async () => {
    const result = await record("Ada: none, use github:acme/api", underFourChoices);

    expect(result.upserts).toEqual([]);
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    expect(result.told).toBe("refusal_beside_named");
  });

  // And the other side of the ruling, which is what the phrase is for: a
  // question about ONE repository, where those words say exactly what they
  // refuse and the record keeps the decision.
  it("records a decline from the same words when the question asked about one repository", async () => {
    const result = await record("Ada: no, continue without it", {
      asked: [{ repositoryKey: "github:acme/infra", askedBecause: "not_enabled", named: true }],
      questions: ["github:acme/infra is not enabled here. Should this work use it?"],
      kept: [],
    });

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.declined).toEqual(["github:acme/infra"]);
    expect(result.told).toBeUndefined();
  });

  // The boundary between that row and A8: what lets a comment decide is a phrase
  // naming what it refuses, never the number of phrases in it. Two bare nos in
  // one comment are two bare nos, and the person is told what to write.
  it("records nothing from a ticket comment whose phrases all refuse without naming the subject", async () => {
    const result = await record("Ada: no\nnope");

    expect(result.upserts).toEqual([]);
    expect(result.answered).toEqual([{ kind: "unrecognised" }]);
    expect(result.told).toBe("unaddressed_refusal");
  });

  // A9: typed into the question's own box, the same word is an answer to it.
  it("still records a plain no typed on the dashboard as declining the choices", async () => {
    const result = await record("no", { composedFromComments: false });

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.told).toBeUndefined();
  });

  // What says what it refuses is its own evidence on the ticket as well.
  it("still records a none that names what it refuses when it comes from the ticket", async () => {
    const result = await record("Ada: none of these");

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.told).toBeUndefined();
  });

  // Round 5, A6. The quote button is how a person answers on a ticket, and the
  // phrase under it is the one our own question teaches. Read with the quote
  // still in it, the reply was judged a bare no addressed to nothing and the
  // person was told their words decided nothing, for using the exact words we
  // asked for.
  it("records a none of these written under a quote of our question", async () => {
    const result = await record("Ada: > Which repositories are essential?\nnone of these");

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.told).toBeUndefined();
  });

  // S5: "none" binds only what the question offered. The kept repositories keep
  // their entries, untouched.
  it("leaves every kept repository's entry alone on a none", async () => {
    const result = await record("Ada: none");

    expect(result.answered).toEqual([{ kind: "none" }]);
    expect(result.upserts).toEqual([]);
    expect(result.deletes).toEqual([]);
  });
});

/**
 * TWO CHANGES TO HOW AN ANSWER IS ACTED ON, both from the owner reading the
 * production evidence, asserted as what a person gets back.
 *
 * A. A person who hands the decision back is answering (AWP-236).
 * B. A repository the person names that the question did not list is taken
 *    when this deployment can use it (AWP-221).
 */
describe("an answer that hands the decision back, or names more than it was offered", () => {
  const API = "github:acme/api";
  const WEB = "github:acme/web";
  const DOCS = "github:acme/docs";
  const OPS = "github:acme/ops";
  const BILLING = "github:acme/billing";
  const LEGACY = "github:acme/legacy";
  const ADA = { kind: "person", actorId: "user_1", actorLabel: "Ada" };

  beforeEach(async () => {
    mocks.resumeHook.mockResolvedValue(undefined);
    await db.insert(repositories).values([
      { provider: "github", path: "acme/api", source: "manual", enabled: true },
      { provider: "github", path: "acme/web", source: "manual", enabled: true },
      { provider: "github", path: "acme/docs", source: "manual", enabled: true },
      { provider: "github", path: "acme/ops", source: "manual", enabled: true },
      { provider: "github", path: "acme/billing", source: "manual", enabled: true },
      { provider: "github", path: "acme/legacy", source: "manual", enabled: false },
    ]);
  });

  const selection = (keys: string[]): WorkScopeAskedRepository[] =>
    keys.map((repositoryKey) => ({ repositoryKey, askedBecause: "selection", named: true }));

  /** The which-of-these question as the run builds it: the opening that makes
   *  it the ticket-text question, then the repositories in order. */
  const whichOfThese = (keys: string[]) => [
    `${TEXT_AMBIGUITY_QUESTION_OPENING} Which repositories are essential for the initial research? ${keys.join(", ")}`,
  ];

  async function entries() {
    return (await readWorkScope(db, SUBJECT))?.entries ?? [];
  }

  /** What the resumed run attaches from the record, through the same decision
   *  its selection step raises first (`run_started`), against the catalog as
   *  this test seeded it. */
  async function whatTheResumedRunAttaches() {
    const scope = await readWorkScope(db, SUBJECT);
    return decideWorkScope(
      {
        scope,
        carriesRecord: true,
        catalog: {
          activated: true,
          enabledKeys: [API, WEB, DOCS, OPS, BILLING],
          unusableKeys: [],
        },
        pinnedProviders: null,
        pinnedKeys: null,
        policy: { candidates: { kind: "enabled_catalog" }, expansion: "attach" },
        eventRelatedKeys: [],
        attachedKeys: [],
        selectionAnswered: await readWorkScopeSelectionAnswered(db, SUBJECT),
        answeredRepositoryKeys: await readWorkScopeAnsweredRepositories(db, SUBJECT),
        postAnswerMentionedKeys: [],
        actor: { kind: "run", runId: RUN, definitionId: 1, definitionVersion: 1 },
        now: "2026-09-18T09:00:00.000Z",
      },
      { kind: "run_started" },
    );
  }

  describe("A. whatever you think is best", () => {
    it("takes the first three of four in the question's order, as the workflow's choice, and says so", async () => {
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));
      const tracker = makeTracker();

      const outcome = await answer(tracker, row.id, "whatever you think is best");

      expect(outcome.kind).toBe("answered");
      const written = await entries();
      expect(written.map((entry) => entry.repositoryKey).sort()).toEqual([API, DOCS, WEB].sort());
      for (const entry of written) {
        expect(entry).toMatchObject({
          state: "selected",
          origin: "delegated",
          rationale: "Chosen by the workflow because Ada asked it to decide.",
          decidedBy: ADA,
        });
      }
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain(`chose ${DOCS}, ${API}, ${WEB}`);
      expect(said).toContain(`It left ${OPS} open: nothing is recorded about it`);
      // The question was the ticket-text one, so the ticket route is shut and
      // the sentence says so rather than sending them to it.
      expect(said).toContain("Writing its path in a comment here does not bring it in");
      // Everything here is enabled, so nothing sends them to enable anything.
      expect(said).not.toContain("enable");
      // And the run resumes, carrying the reading that says what happened.
      expect(mocks.resumeHook).toHaveBeenCalledWith(
        "hook-token" in row ? expect.anything() : expect.anything(),
        expect.objectContaining({
          answerReading: expect.objectContaining({ outcome: { kind: "delegated" } }),
        }),
      );
    });

    it("binds only what it took: the one it left is outside the answered set and nothing silences the question on it", async () => {
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));

      await answer(makeTracker(), row.id, "you decide");

      await expect(readWorkScopeAnsweredRepositories(db, SUBJECT)).resolves.toEqual([]);
      await expect(readWorkScopeSelectionAnswered(db, SUBJECT)).resolves.toBe(false);
      // What the trail keeps, so the dashboard and MCP can explain the run later.
      const answered = (await db.select().from(workScopeTrail))
        .map((trail) => trail.event)
        .find((event) => event.kind === "question_answered");
      expect(answered).toMatchObject({
        answer: { kind: "delegated", repositoryKeys: [DOCS, API, WEB] },
        answeredBy: ADA,
      });
    });

    // Ada ruled docs out on the work's repository list while the question sat
    // on the ticket, then replied "you decide". Handing the choice back hands
    // over what is still open, not her exclusion, and the reply may claim only
    // the choice the record actually took.
    it("leaves a repository the person had already decided on, takes the next one, and says only what it chose", async () => {
      await applyRunWorkScopePlan(db, {
        subjectKey: SUBJECT,
        runId: "run-0",
        plan: {
          upserts: [
            {
              entry: {
                repositoryKey: DOCS,
                state: "excluded",
                origin: "person",
                rationale: "Not docs.",
                decidedBy: { kind: "person", actorId: "user_1", actorLabel: "Ada" },
                decidedAt: "2026-09-18T08:00:00.000Z",
              },
              replacesExpired: false,
            },
          ],
          deletes: [],
          trail: [],
        },
      });
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));

      const outcome = await answer(makeTracker(), row.id, "whatever you think is best");

      const byKey = Object.fromEntries((await entries()).map((entry) => [entry.repositoryKey, entry]));
      expect(byKey[DOCS]).toMatchObject({ state: "excluded", origin: "person", rationale: "Not docs." });
      for (const key of [API, WEB, OPS]) {
        expect(byKey[key]).toMatchObject({ state: "selected", origin: "delegated" });
      }
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain(`chose ${API}, ${WEB}, ${OPS}`);
      expect(said).not.toContain(DOCS);
    });

    it("attaches the one repository a one-repository question offered, and the resumed run gets it", async () => {
      const row = await seedPending(selection([WEB]), [`Should this ticket also use ${WEB}?`]);

      const outcome = await answer(makeTracker(), row.id, "up to you");

      expect(outcome.kind).toBe("answered");
      await expect(entries()).resolves.toEqual([
        expect.objectContaining({ repositoryKey: WEB, origin: "delegated" }),
      ]);
      expect((await whatTheResumedRunAttaches()).attach).toEqual([WEB]);
    });

    // The question exists because the run cannot use the repository. The
    // workflow's only choice is to continue without it, which is what a decline
    // of that one does to the run; unlike a decline it writes nothing permanent
    // in that person's name, because a delegation is not a refusal.
    it("continues without a repository the question was raised about because the run cannot use it", async () => {
      // Activated, as on production: on the bridge every repository reads as
      // enabled and there is nothing to tell anybody about enabling.
      await db.insert(repositoryCatalogState).values({ id: 1, activated: true });
      const row = await seedPending(
        [{ repositoryKey: LEGACY, askedBecause: "not_enabled", named: true }],
        [`Repository expansion: ${LEGACY} is not enabled here. Reply "none" to continue without it.`],
      );

      const outcome = await answer(makeTracker(), row.id, "rób jak uważasz");

      expect(outcome.kind).toBe("answered");
      await expect(entries()).resolves.toEqual([]);
      expect(mocks.resumeHook).toHaveBeenCalledTimes(1);
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain(`continues without ${LEGACY}`);
      // The one case where the page that enables a repository is worth naming,
      // in the words the run itself uses for it.
      expect(said).toContain(`${LEGACY} is not enabled on the Repositories page`);
    });

    it("keeps a reply that says what to avoid unclear, records nothing and does not resume", async () => {
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));

      const outcome = await answer(makeTracker(), row.id, "not the api one");

      expect(outcome.kind).toBe("answer_unclear");
      await expect(entries()).resolves.toEqual([]);
      expect(mocks.resumeHook).not.toHaveBeenCalled();
    });

    it("keeps a delegation that carries a refusal unclear", async () => {
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));

      const outcome = await answer(makeTracker(), row.id, "you decide, but not the api one");

      expect(outcome.kind).toBe("answer_unclear");
      await expect(entries()).resolves.toEqual([]);
    });

    // A delegation needs the model. The fallback reads a path and "none" only,
    // so the run parks and the note never claims we chose.
    it("parks the run when the provider is down, and never says it chose", async () => {
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));

      const outcome = await answer(makeTracker(), row.id, "whatever you think is best", {
        generate: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      });

      expect(outcome.kind).toBe("answer_unclear");
      expect((outcome as { confirm: string }).confirm).not.toMatch(/chose/);
      await expect(entries()).resolves.toEqual([]);
    });

    // The ticket path recomposes the same comment on every poll tick. One
    // delegation is one choice, one trail line and one comment.
    it("makes one choice, writes one trail line and posts one note when the same words arrive again", async () => {
      const four = [DOCS, API, WEB, OPS];
      const row = await seedPending(selection(four), whichOfThese(four));
      const tracker = makeTracker();

      await answer(tracker, row.id, "Ada: whatever you think is best", VIA_JIRA);
      await answer(tracker, row.id, "Ada: whatever you think is best", VIA_JIRA);

      const trail = (await db.select().from(workScopeTrail)).map((line) => line.event);
      expect(trail.filter((event) => event.kind === "question_answered")).toHaveLength(1);
      expect(trail.filter((event) => event.kind === "entry_written")).toHaveLength(3);
      const notes = tracker.postComment.mock.calls
        .map(([, body]) => body)
        .filter((body) => body.includes("asked the workflow to decide"));
      expect(notes).toHaveLength(1);
    });
  });

  describe("B. a repository the question did not list", () => {
    it("takes one the catalog holds and enables, as that person's own choice, and the resumed run gets it", async () => {
      const row = await seedPending(selection([API]), [`Should this ticket also use ${API}?`]);

      const outcome = await answer(makeTracker(), row.id, `yes, and ${BILLING} as well`);

      expect(outcome.kind).toBe("answered");
      const byKey = Object.fromEntries((await entries()).map((entry) => [entry.repositoryKey, entry]));
      expect(byKey[BILLING]).toMatchObject({
        state: "selected",
        origin: "person",
        rationale: "Named in the answer to a repository question.",
        decidedBy: ADA,
      });
      expect(byKey[API]).toMatchObject({ state: "selected", origin: "person" });
      expect((await whatTheResumedRunAttaches()).attach).toEqual(expect.arrayContaining([API, BILLING]));
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain(`also named ${BILLING}`);
      expect(said).toContain("as your choice");
    });

    // A5: the catalog holds it and does not enable it. Their decision stands and
    // is theirs; the run refuses it at start, saying why; and once somebody
    // enables it the next run uses it without asking again. The offered one
    // they also named is recorded all the same.
    it("records one the catalog holds but does not enable as their choice, and tells them which page enables it", async () => {
      const row = await seedPending(selection([API]), [`Should this ticket also use ${API}?`]);

      const outcome = await answer(makeTracker(), row.id, `yes, and ${LEGACY} as well`);

      const byKey = Object.fromEntries((await entries()).map((entry) => [entry.repositoryKey, entry]));
      expect(byKey[API]).toMatchObject({ state: "selected", origin: "person" });
      expect(byKey[LEGACY]).toMatchObject({ state: "selected", origin: "person" });
      const runStart = await whatTheResumedRunAttaches();
      expect(runStart.attach).toEqual([API]);
      expect(runStart.refused).toEqual([{ repositoryKey: LEGACY, reason: "outside_catalog" }]);
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain(`${LEGACY} is not enabled on the Repositories page`);
    });

    it("records nothing for a key nobody holds, and says so", async () => {
      const row = await seedPending(selection([API]), [`Should this ticket also use ${API}?`]);

      const outcome = await answer(makeTracker(), row.id, "yes, and github:evil/other as well");

      await expect(entries()).resolves.toEqual([
        expect.objectContaining({ repositoryKey: API, state: "selected" }),
      ]);
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain("github:evil/other");
      expect(said).toContain("nothing about it was recorded");
    });

    // AWP-255 on production, replayed on the ticket channel. The question was
    // about one repository the run cannot use; the reply turned it down and
    // named an enabled one the question never listed. Both halves are decisions
    // and both are recorded: the one asked about as a decline of its kind (an
    // `unavailable` entry, since it was asked because it is not enabled), the
    // named one as this person's choice. A bare no on a ticket records nothing
    // (A8), and this is not one: nobody types a repository path by accident.
    it("declines the one asked about and takes the enabled one named beside the refusal, on the ticket too", async () => {
      const row = await seedPending(
        [{ repositoryKey: LEGACY, askedBecause: "not_enabled", named: true }],
        [`Repository expansion: Research requested ${LEGACY}, which this run cannot use. Reply "none" to continue without it.`],
      );
      const tracker = makeTracker();

      const outcome = await answer(tracker, row.id, `Ada: no, but take ${WEB} as well`, VIA_JIRA);

      expect(outcome.kind).toBe("answered");
      const byKey = Object.fromEntries((await entries()).map((entry) => [entry.repositoryKey, entry]));
      expect(byKey[WEB]).toMatchObject({
        state: "selected",
        origin: "person",
        rationale: "Named in the answer to a repository question.",
        decidedBy: { kind: "person", actorLabel: "Ada (via Jira)" },
      });
      expect(byKey[LEGACY]).toMatchObject({
        state: "unavailable",
        unavailableReason: "not_enabled",
        origin: "person",
      });
      expect((await whatTheResumedRunAttaches()).attach).toEqual([WEB]);
      const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
      expect(posted).toContain(`declining ${LEGACY}`);
      expect(posted).toContain(`also named ${WEB}, which the question did not list`);
      expect(posted).not.toContain("plain no");
    });

    it("reads a refusal of the whole list beside a name the question did not list as both decisions", async () => {
      const two = [API, DOCS];
      const row = await seedPending(selection(two), whichOfThese(two));
      // The trail line the asking run writes beside its question, which is what
      // the answered set joins the answer to.
      await appendWorkScopeQuestionAsked(db, {
        subjectKey: SUBJECT,
        runId: RUN,
        clarificationId: row.id,
        asked: selection(two),
      });

      const outcome = await answer(makeTracker(), row.id, `none of these, take ${BILLING}`);

      expect(outcome.kind).toBe("answered");
      await expect(entries()).resolves.toEqual([
        expect.objectContaining({ repositoryKey: BILLING, state: "selected", origin: "person" }),
      ]);
      // The two it listed are declined the way a selection question declines:
      // no entry, bound through the answered set, so no later run takes them.
      await expect(readWorkScopeAnsweredRepositories(db, SUBJECT)).resolves.toEqual(
        expect.arrayContaining([API, DOCS]),
      );
      expect((await whatTheResumedRunAttaches()).attach).toEqual([BILLING]);
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain(`declining ${API}, ${DOCS}`);
      expect(said).toContain(`also named ${BILLING}`);
    });

    // The same refusal on the ticket beside a name nothing here holds. Nothing
    // was taken, so the refusal is the bare no A8 is about and records nothing;
    // the name is still looked up and they hear it matched nothing, rather than
    // being sent to select a repository the list would refuse.
    it("still records nothing for a bare no on the ticket when the name beside it matches nothing, and says the name matched nothing", async () => {
      const row = await seedPending(
        [{ repositoryKey: LEGACY, askedBecause: "not_enabled", named: true }],
        [`Repository expansion: Research requested ${LEGACY}, which this run cannot use. Reply "none" to continue without it.`],
      );
      const tracker = makeTracker();

      const outcome = await answer(tracker, row.id, "Ada: no, but take github:evil/other as well", VIA_JIRA);

      expect(outcome.kind).toBe("answered");
      await expect(entries()).resolves.toEqual([]);
      const said = (outcome as { recordOutcome?: string }).recordOutcome ?? "";
      expect(said).toContain("plain no");
      expect(said).toContain("github:evil/other, which could not be matched to a repository this deployment holds");
    });

    // The three guards that make "what this deployment holds" an acceptable
    // bound where "what the question offered" used to be.
    it("takes nothing from an answer several people wrote, even a name the catalog holds", async () => {
      const row = await seedPending(selection([API]), [`Should this ticket also use ${API}?`]);

      await answer(makeTracker(), row.id, `Ada: yes, and ${BILLING} as well`, {
        ...VIA_JIRA,
        answerAuthorCount: 2,
      });

      await expect(entries()).resolves.toEqual([]);
    });

    it("never reads a delegation or a name out of the ticket's own text", async () => {
      const row = await seedPending(selection([API]), [`Should this ticket also use ${API}?`]);
      const tracker = makeTracker();
      (await tracker.fetchTicket()).description =
        `You decide which repositories to use, and take ${BILLING} as well.`;

      await answer(tracker, row.id, "yes");

      await expect(entries()).resolves.toEqual([
        expect.objectContaining({ repositoryKey: API, origin: "person" }),
      ]);
    });
  });
});
