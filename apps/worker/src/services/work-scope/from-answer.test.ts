import { asc, eq } from "drizzle-orm";
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
  workflowRuns,
  workScopeTrail,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { answerClarificationAndResume } from "../clarifications/answer-core.js";
import {
  recordRepositoryAnswer,
  type RepositoryAnswerPersistence,
} from "./from-answer.js";
import { recordRepositoryAnswer as recordRepositoryAnswerThroughIndex } from "./index.js";
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

    await answer(tracker, row.id, "whichever one the team prefers");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    // Read from the statement rather than assumed, because the whole defect was
    // a claim about this flag that the statement does not make.
    await expect(readWorkScopeSelectionAnswered(db, SUBJECT)).resolves.toBe(false);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository this work should use");
    expect(posted).toContain("It means the same question may be asked again on a later run.");
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

  it("keeps the remedy that works for an answer that spelled no path out, which is not the one for a name we do not hold", async () => {
    // The other half of the same fork, and the reason the fork exists. Nothing
    // here was written as a path, so nothing about it is a dead end: a change
    // that gave everybody the "we do not have that" sentence would be a lie
    // told to them. What they are sent to is the route that works whatever the
    // ticket says, because this surface cannot count the ticket's open
    // repositories and so never offers the comment (joint gate round 3, R8).
    const row = await seedPending(asked("github:acme/api", "selection"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "the billing service");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository this work should use");
    expect(posted).toContain("select it in this work's repository list");
    expect(posted).not.toContain("write its full path in a comment here");
    expect(posted).not.toContain("does not have");
  });

  it("sends an answer to a question raised mid run to the record, because nothing here proves a comment is read", async () => {
    // Joint gate F4. The same answer to a question the workflow's policy raised.
    // How many repositories the ticket names is not known on this surface, and a
    // path written into a ticket that already names three tips the next run into
    // asking instead of reading it, so the only route offered is one that works.
    const row = await seedPending(asked("github:acme/api", "outside_policy"));
    const tracker = makeTracker();

    await answer(tracker, row.id, "the billing service");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository this work should use");
    expect(posted).not.toContain("in a comment here");
    expect(posted).toContain(
      "select it in this work's repository list through the work scope API or the work_scope.edit tool",
    );
  });

  // A discovery question listing four candidates, and the same question one
  // candidate shorter. Before joint gate round 3 (R8) the four were told the
  // comment route was shut and the three were sent to it, by the count of the
  // question's own list; the ticket beside the question could name more open
  // repositories than either, and that count is the one the next run decides
  // on. Neither is sent to write a path now, and neither is told a reason for
  // the route being shut that nothing here can see.
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

    await answer(tracker, row.id, "the billing service");

    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("Nothing in that answer named a repository this work should use");
    expect(posted).not.toContain("write its full path in a comment here");
    expect(posted).not.toContain("more than three repositories");
    expect(posted).toContain("the work scope API or the work_scope.edit tool");
    expect(posted).toContain("the next time the question is asked");
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
    // And the third half, which is why this fixture asks about a repository the
    // catalog does not enable: the route out of here is the catalog, not a path.
    // Telling them to write `github:acme/web` would spend their next attempt on
    // a matcher that never sees it.
    expect(posted).toContain("somebody with access to the repositories screen has to enable them");
    expect(posted).not.toContain("write its full path in a comment here");
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

    await answer(tracker, row.id, "not acme/api, use github:acme/web");

    await expect(entriesOfSubject()).resolves.toEqual([]);
    const posted = tracker.postComment.mock.calls.map((call) => call[1]).join("\n");
    expect(posted).toContain("names a repository and also says no");
    expect(posted).toContain("name only the repositories to use");
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

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/web", origin: "ticket_text" }),
    ]);
    const posted = tracker.postComment.mock.calls.map(([, body]) => body).join("\n\n");
    expect(posted).toContain("names a repository the question listed as already part of this work");
    expect(posted).toContain("an exclusion in this work's repository list");
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
