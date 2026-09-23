import { describe, expect, it, vi } from "vitest";

/**
 * The wire between the run and the ticket, driven for real.
 *
 * `postClarificationQuestionsCommentStep` is the only consumer of the recovery
 * notes that reaches a person, and the only thing between the field the run
 * fills in and the words Jira receives. The formatter beside it is proved pure
 * in `services/clarifications/comment-format.test.ts` and the absence of the
 * same sentence from the prompts and the memory file in
 * `blocks/prepare-workspace/prepare-workspace.test.ts`; this proves the step
 * actually carries it, rather than accepting a field and dropping it.
 */
// Typed to the adapter method it stands in for, because the assertions below
// read the SECOND argument: a zero-parameter mock records an empty tuple, and
// the only way to index it would be a cast that throws the claim away.
const mocks = vi.hoisted(() => ({
  postComment: vi.fn(async (_ticketKey: string, _body: string) => "https://tracker/comment/1"),
  assertConnectedActiveRunOwner: vi.fn(async () => {}),
}));

vi.mock("../support/adapters.js", () => ({
  createAdapters: () => ({ issueTrackerResolution: { ok: true, adapter: { postComment: mocks.postComment }  }}),
}));

vi.mock("../../db/repositories/active-runs.js", () => ({
  assertConnectedActiveRunOwner: mocks.assertConnectedActiveRunOwner,
}));

import type { ActiveRunOwner } from "../internal/ports.js";
import { postClarificationQuestionsCommentStep } from "../steps/clarification.js";

const OWNER: ActiveRunOwner = {
  subjectKey: "ticket:jira:AWT-402",
  ownerToken: "token-1",
  runId: "run-1",
};

const REFUSAL =
  "github:acme/api was excluded on this work, so the run started without it.";
const REVERSAL =
  "Excluding a repository is not final: this work's repository list can be changed" +
  " through the work scope API or the work_scope.edit tool," +
  " and the next run starts from the changed list.";

describe("postClarificationQuestionsCommentStep", () => {
  it("posts what a person can do about a repository the run left out", async () => {
    mocks.postComment.mockClear();

    await postClarificationQuestionsCommentStep(
      "AWT-402",
      {
        questions: [`${REFUSAL} Which repository should this ticket modify?`],
        suggestedAnswers: null,
        dashboardUrl: "https://app/ticket/AWT-402?run=wrun_1",
        expiresAtIso: null,
        aiColumnName: "AI",
        repositoryRecoveryNotes: [REVERSAL],
      },
      OWNER,
    );

    expect(mocks.postComment).toHaveBeenCalledTimes(1);
    const body = mocks.postComment.mock.calls[0]![1];
    // The positive control sits beside the assertion it protects: a body that
    // lost the question entirely would satisfy neither.
    expect(body).toContain(REFUSAL);
    expect(body).toContain(REVERSAL);
  });

  it("posts the comment it always posted when the run left nothing out", async () => {
    mocks.postComment.mockClear();

    await postClarificationQuestionsCommentStep(
      "AWT-402",
      {
        questions: ["Which repository should this ticket modify?"],
        suggestedAnswers: null,
        dashboardUrl: "https://app/ticket/AWT-402?run=wrun_1",
        expiresAtIso: null,
        aiColumnName: "AI",
      },
      OWNER,
    );

    const body = mocks.postComment.mock.calls[0]![1];
    expect(body).toContain("Which repository should this ticket modify?");
    expect(body).not.toContain("not final");
  });
});
