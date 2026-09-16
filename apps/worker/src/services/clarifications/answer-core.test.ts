import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettingsSnapshot, type WorkScopeAskedRepository } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import type { IssueTrackerAdapter, TicketContent } from "../../adapters/issue-tracker/types.js";
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

let db: Db;

async function seedPending(askedRepositories?: WorkScopeAskedRepository[]) {
  const prepared = await prepareHookClarification(db, {
    ticketKey: TICKET,
    subjectKey: SUBJECT,
    runId: RUN,
    blockId: "question",
    definitionId: 1,
    definitionVersion: 1,
    questions: ["What framework?"],
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

  function asked(
    repositoryKey: string,
    askedBecause: WorkScopeAskedRepository["askedBecause"],
  ): WorkScopeAskedRepository[] {
    return [{ repositoryKey, askedBecause }];
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

  it("records an unreadable answer as answered and decides nothing", async () => {
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

  it("reads the union of a two comment answer", async () => {
    const row = await seedPending([
      { repositoryKey: "github:acme/api", askedBecause: "selection" },
      { repositoryKey: "github:acme/web", askedBecause: "selection" },
    ]);

    await answer(makeTracker(), row.id, "Filip Maszota: api\n\nAda Lovelace: web");

    await expect(entriesOfSubject()).resolves.toEqual([
      expect.objectContaining({ repositoryKey: "github:acme/api" }),
      expect.objectContaining({ repositoryKey: "github:acme/web" }),
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

  it("records nothing at all for a question that asked about no repository", async () => {
    const row = await seedPending();

    const outcome = await answer(makeTracker(), row.id, "Use Next.js");

    expect(outcome.kind).toBe("answered");
    expect(outcome.kind === "answered" && outcome.row.answer).toBe("Use Next.js");
    await expect(trailEvents()).resolves.toEqual([]);
    await expect(readWorkScope(db, SUBJECT)).resolves.toBeNull();
  });
});
