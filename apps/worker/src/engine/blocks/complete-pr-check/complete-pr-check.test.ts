import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";

const mocks = vi.hoisted(() => ({
  completeConnectedRunOwnedPrCheck: vi.fn(),
  prRunTarget: vi.fn(() => ({ kind: "target" })),
}));

vi.mock("../../runtime/pr-external-resources.js", () => ({
  completeConnectedRunOwnedPrCheck: mocks.completeConnectedRunOwnedPrCheck,
  prRunTarget: mocks.prRunTarget,
}));

import { execute } from "./execute.js";
import { makeCtx } from "../support/test-support.js";

describe("complete_pr_check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completeConnectedRunOwnedPrCheck.mockResolvedValue(undefined);
  });

  it("refreshes the pull request head when the workflow fixed and pushed it", async () => {
    const ctx = makeCtx({
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_updated",
        subjectKey: "pr:github:acme/app#7",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr: {
          provider: "github",
          repoPath: "acme/app",
          prNumber: 7,
          prUrl: "https://github.test/acme/app/pull/7",
          headRef: "feature",
          headSha: "old-head",
          baseRef: "main",
          title: "Fix contract",
          author: "workflow-bot",
          isDraft: false,
        },
      },
    });
    const check = {
      id: "check-1",
      headSha: "old-head",
      name: "AI Workflow / Review",
    };

    const result = await execute(
      {
        id: "complete",
        type: "complete_pr_check",
        x: 0,
        y: 0,
        params: {
          conclusion: "success",
          details: "Fixed.",
          refreshHead: true,
        },
        inputs: {},
      } as unknown as WorkflowDefinitionNode,
      {},
      ctx,
      { check },
    );

    expect(result.kind).toBe("next");
    expect(mocks.completeConnectedRunOwnedPrCheck).toHaveBeenCalledWith(
      expect.objectContaining({ refreshHead: true }),
    );
  });
});
