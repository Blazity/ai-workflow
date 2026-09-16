import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkScopeAskedRepository } from "@shared/contracts";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  appendQuestionAsked: vi.fn(),
}));

vi.mock("../../db/repositories/clarification-hooks.js", () => ({
  prepareConnectedHookClarification: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock("../../db/repositories/work-scope.js", () => ({
  appendConnectedWorkScopeQuestionAsked: (...args: unknown[]) =>
    mocks.appendQuestionAsked(...args),
}));

const { prepareClarificationHookStep } = await import("./clarification-hook-steps.js");

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
});

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

    expect(mocks.prepare).toHaveBeenCalledWith({ ...QUESTION, askedRepositories: ASKED });
    expect(mocks.appendQuestionAsked).toHaveBeenCalledWith({
      subjectKey: "ticket:jira:AWT-9",
      runId: "run-asked",
      clarificationId: "clarification-1",
      asked: ASKED,
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
