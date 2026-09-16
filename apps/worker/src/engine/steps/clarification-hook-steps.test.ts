import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkScopeAskedRepository, WorkScopeTrailRow } from "@shared/contracts";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  appendQuestionAsked: vi.fn(),
  readScope: vi.fn(),
  readSelectionAnswered: vi.fn(),
  readAnsweredRepositories: vi.fn(),
  readAnsweredQuestion: vi.fn(),
  readNarrowingAnswered: vi.fn(),
}));

vi.mock("../../db/repositories/clarification-hooks.js", () => ({
  prepareConnectedHookClarification: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock("../../db/repositories/work-scope.js", () => ({
  appendConnectedWorkScopeQuestionAsked: (...args: unknown[]) =>
    mocks.appendQuestionAsked(...args),
  readConnectedWorkScope: (...args: unknown[]) => mocks.readScope(...args),
  readConnectedWorkScopeSelectionAnswered: (...args: unknown[]) =>
    mocks.readSelectionAnswered(...args),
  readConnectedWorkScopeAnsweredRepositories: (...args: unknown[]) =>
    mocks.readAnsweredRepositories(...args),
  readConnectedWorkScopeAnsweredQuestion: (...args: unknown[]) =>
    mocks.readAnsweredQuestion(...args),
  readConnectedWorkScopeNarrowingAnswered: (...args: unknown[]) =>
    mocks.readNarrowingAnswered(...args),
}));

const { prepareClarificationHookStep, readWorkScopeAfterAnswerStep } = await import(
  "./clarification-hook-steps.js"
);

const QUESTION = {
  ticketKey: "AWT-9",
  subjectKey: "ticket:jira:AWT-9",
  runId: "run-asked",
  blockId: "question",
  definitionId: 4,
  definitionVersion: 7,
  questions: ["Which repository holds the checkout flow?"],
  suggestedAnswers: null,
};

const ASKED: WorkScopeAskedRepository[] = [
  { repositoryKey: "github:acme/web", askedBecause: "not_enabled" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({
    id: "clarification-1",
    hookToken: "clarification:clarification-1",
    askedAt: new Date("2026-09-15T14:00:00.000Z"),
    expiresAt: null,
  });
  mocks.appendQuestionAsked.mockResolvedValue(true);
  mocks.readScope.mockResolvedValue(null);
  mocks.readSelectionAnswered.mockResolvedValue(false);
  mocks.readAnsweredRepositories.mockResolvedValue([]);
  mocks.readAnsweredQuestion.mockResolvedValue(null);
  mocks.readNarrowingAnswered.mockResolvedValue(false);
});

/** A `question_answered` trail row for the question below, carrying the answer
 *  kind whose verdict is the one thing the entries never record. */
function answeredRow(
  kind: "repositories" | "none" | "unrecognised" | "unattributed",
): WorkScopeTrailRow {
  const answer =
    kind === "repositories"
      ? { kind: "repositories" as const, repositoryKeys: ["github:acme/api"] }
      : { kind };
  return {
    id: 7,
    subjectKey: "ticket:jira:AWT-9",
    runId: "run-asked",
    at: "2026-09-15T14:05:00.000Z",
    event: {
      kind: "question_answered" as const,
      clarificationId: "clarification-1",
      answer,
      answeredBy: { kind: "person" as const, actorId: "jira:human-1", actorLabel: "Jane" },
    },
  } as WorkScopeTrailRow;
}

describe("prepareClarificationHookStep", () => {
  it("writes no asked repositories and no trail row for a question about anything else", async () => {
    await expect(prepareClarificationHookStep(QUESTION)).resolves.toEqual({
      id: "clarification-1",
      hookToken: "clarification:clarification-1",
      snapshotRequestedAt: "2026-09-15T14:00:00.000Z",
      expiresAt: null,
    });

    expect(mocks.prepare).toHaveBeenCalledWith(QUESTION);
    expect(mocks.appendQuestionAsked).not.toHaveBeenCalled();
  });

  it("records what a repository question asked, against the id the insert produced", async () => {
    await prepareClarificationHookStep({
      ...QUESTION,
      workScopeAsk: { subjectKey: "ticket:jira:AWT-9", askedRepositories: ASKED },
    });

    // The question above names no repository, so the ask says so on both
    // writes: the row the answer is read against and the trail row a later run
    // reads the answered repositories out of.
    const unnamed = [{ ...ASKED[0]!, named: false }];
    expect(mocks.prepare).toHaveBeenCalledWith({ ...QUESTION, askedRepositories: unnamed });
    expect(mocks.appendQuestionAsked).toHaveBeenCalledWith({
      subjectKey: "ticket:jira:AWT-9",
      runId: "run-asked",
      clarificationId: "clarification-1",
      asked: unnamed,
    });
  });

  it("still asks the question when the trail append fails, and says so in the log", async () => {
    mocks.appendQuestionAsked.mockRejectedValue(new Error("trail append failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      prepareClarificationHookStep({
        ...QUESTION,
        workScopeAsk: { subjectKey: "ticket:jira:AWT-9", askedRepositories: ASKED },
      }),
    ).resolves.toEqual({
      id: "clarification-1",
      hookToken: "clarification:clarification-1",
      snapshotRequestedAt: "2026-09-15T14:00:00.000Z",
      expiresAt: null,
    });

    expect(error).toHaveBeenCalledWith(
      "work_scope_question_asked_append_failed",
      "clarification-1",
      "run-asked",
      "trail append failed",
    );
    error.mockRestore();
  });

  it("records a repository as named only when the question's own words named it", async () => {
    // The fact the whole rule turns on, stamped at the one place the question's
    // text and the repositories it is recorded against are both in hand. A
    // person has decided about a repository only if they were shown it, so an
    // ask whose question named nothing must not later silence a question or
    // fail a run on a decision nobody made.
    await prepareClarificationHookStep({
      ...QUESTION,
      questions: [
        "Repository discovery asked for github:acme/web, which this run cannot use.",
        "Which repository or repositories should this ticket inspect or modify?",
      ],
      workScopeAsk: {
        subjectKey: "ticket:jira:AWT-9",
        askedRepositories: [
          { repositoryKey: "github:acme/web", askedBecause: "not_enabled" },
          { repositoryKey: "github:acme/api", askedBecause: "selection" },
        ],
      },
    });

    expect(mocks.appendQuestionAsked).toHaveBeenCalledWith(
      expect.objectContaining({
        asked: [
          { repositoryKey: "github:acme/web", askedBecause: "not_enabled", named: true },
          { repositoryKey: "github:acme/api", askedBecause: "selection", named: false },
        ],
      }),
    );
  });

  it("records why a question nobody could be shown a list was asked", async () => {
    // The narrowing question names no repository, because there are more of
    // them than an ask may carry, so its ask is empty and reads exactly like
    // the plain "which repository should this ticket modify?". Without the
    // purpose on the row, the next run cannot tell the two apart and asks the
    // person to narrow the same set again.
    await prepareClarificationHookStep({
      ...QUESTION,
      questions: [
        "More than 8 repositories are in scope. Which repositories are essential for this ticket?",
      ],
      workScopeAsk: {
        subjectKey: "ticket:jira:AWT-9",
        askedRepositories: [],
        purpose: "narrowing",
      },
    });

    expect(mocks.appendQuestionAsked).toHaveBeenCalledWith({
      subjectKey: "ticket:jira:AWT-9",
      runId: "run-asked",
      clarificationId: "clarification-1",
      asked: [],
      purpose: "narrowing",
    });
  });

  it("records no purpose for a question whose repositories already say what it was", async () => {
    await prepareClarificationHookStep({
      ...QUESTION,
      workScopeAsk: { subjectKey: "ticket:jira:AWT-9", askedRepositories: ASKED },
    });

    const [input] = mocks.appendQuestionAsked.mock.calls[0]!;
    expect("purpose" in (input as object)).toBe(false);
  });

  it("records the question against the subject the work scope is kept for", async () => {
    await prepareClarificationHookStep({
      ...QUESTION,
      subjectKey: "ticket:jira:AWT-9",
      workScopeAsk: { subjectKey: "pr:github:acme/web:12", askedRepositories: ASKED },
    });

    expect(mocks.appendQuestionAsked).toHaveBeenCalledWith(
      expect.objectContaining({ subjectKey: "pr:github:acme/web:12" }),
    );
  });
});

/**
 * The verdict the record keeps and the entries do not.
 *
 * An answer the record DECLINED to attribute and an answer it read and found
 * nothing actionable in leave the work scope entries identical, and they mean
 * opposite things: one is nobody's decision, the other is a person's words the
 * looser text scan downstream may still get a repository out of. The only
 * record of which happened is the `question_answered` trail row. What the
 * single reader (`blocks/prepare-workspace/execute.ts`) does with each value is
 * proved in `blocks/prepare-workspace/prepare-workspace.test.ts`; this proves
 * the value itself.
 */
describe("readWorkScopeAfterAnswerStep", () => {
  it("reports the one answer nobody can be credited with as unattributed", async () => {
    mocks.readAnsweredQuestion.mockResolvedValue(answeredRow("unattributed"));

    const resumed = await readWorkScopeAfterAnswerStep(
      "ticket:jira:AWT-9",
      "clarification-1",
    );

    expect(mocks.readAnsweredQuestion).toHaveBeenCalledWith("clarification-1");
    expect(resumed.answerAttributed).toBe(false);
  });

  it("reports an answer it read and could not act on as attributed", async () => {
    // The wide half. "Unrecognised" is the record saying it read one person's
    // words and could not make a repository out of them, which refuses nothing:
    // reported as a refusal, the run hides those words from the only other
    // reader that might understand them and asks the same question again.
    mocks.readAnsweredQuestion.mockResolvedValue(answeredRow("unrecognised"));

    const resumed = await readWorkScopeAfterAnswerStep(
      "ticket:jira:AWT-9",
      "clarification-1",
    );

    expect(resumed.answerAttributed).toBe(true);
  });

  it("reports an answer that named a repository as attributed", async () => {
    mocks.readAnsweredQuestion.mockResolvedValue(answeredRow("repositories"));

    const resumed = await readWorkScopeAfterAnswerStep(
      "ticket:jira:AWT-9",
      "clarification-1",
    );

    expect(resumed.answerAttributed).toBe(true);
  });

  it("carries the narrowing answer back to the run that asked for it", async () => {
    // The SAME run re-executes the block that asked, against a selection
    // discovery rebuilds unchanged. Without this fact on the way back, the block
    // counts the same twelve repositories and asks the identical question the
    // person has just answered, inside one run.
    mocks.readNarrowingAnswered.mockResolvedValue(true);

    const resumed = await readWorkScopeAfterAnswerStep(
      "ticket:jira:AWT-9",
      "clarification-1",
    );

    expect(mocks.readNarrowingAnswered).toHaveBeenCalledWith("ticket:jira:AWT-9");
    expect(resumed.narrowingAnswered).toBe(true);
  });

  it("omits the verdict when no row answers for this question", async () => {
    // Absent is not a value: a run suspended across the deploy that added the
    // field replays a result written without it, and the trail append is
    // best-effort by design, so the reader owes this case a rule of its own
    // rather than a default that reads as either verdict.
    const resumed = await readWorkScopeAfterAnswerStep(
      "ticket:jira:AWT-9",
      "clarification-1",
    );

    expect("answerAttributed" in resumed).toBe(false);
  });

  it("asks for no verdict when the run does not say which question it woke on", async () => {
    const resumed = await readWorkScopeAfterAnswerStep("ticket:jira:AWT-9");

    // Keyed on the clarification and never on the subject: the newest answered
    // question on a subject is only probably this run's own.
    expect(mocks.readAnsweredQuestion).not.toHaveBeenCalled();
    expect("answerAttributed" in resumed).toBe(false);
  });
});
