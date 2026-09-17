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
    // And the third half, which is why this fixture asks about a repository the
    // catalog does not enable: the route out of here is the catalog, not a path.
    // Telling them to write `github:acme/web` would spend their next attempt on
    // a matcher that never sees it.
    expect(posted).toContain("somebody with access to the repositories screen has to enable them");
    expect(posted).not.toContain("write its full path in a comment here");
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
  async function told(answerText: string) {
    const row = await seedPending(
      [{ repositoryKey: "github:acme/api", askedBecause: "selection", named: true }],
      ["Which repository should this ticket modify?"],
    );
    const stored = await getHookClarification(db, row.id);
    if (!stored) throw new Error("clarification vanished");
    return recordRepositoryAnswer(persistence(), {
      row: stored,
      answer: answerText,
      answeredAt: new Date(),
      answerer: ACTOR,
      composedFromComments: false,
    });
  }

  it("says nothing named a repository when the words resolved to none of them", async () => {
    await expect(told("whichever one the team prefers")).resolves.toBe("no_repository_named");
  });

  it("says the deployment does not hold it when the person spelled a path out in full", async () => {
    await expect(told("github:acme/unknown-service")).resolves.toBe("no_such_repository");
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
    const ownPathTold = await recordRepositoryAnswer(capturing(ownPath), input);
    const throughIndexTold = await recordRepositoryAnswerThroughIndex(
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
    expect(throughIndexTold).toBe(ownPathTold);
  });
});
