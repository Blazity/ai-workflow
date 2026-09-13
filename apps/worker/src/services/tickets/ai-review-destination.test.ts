import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";

vi.mock("../../infra/vcs-config.js", () => ({
  env: { JIRA_AI_REVIEW_TRANSITION_ID: undefined },
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  isAiReviewDestination,
  resetAiReviewDestinationCache,
} from "./ai-review-destination.js";

describe("AI Review destination cache", () => {
  beforeEach(() => resetAiReviewDestinationCache());

  it("resolves again when the configured destination changes", async () => {
    const resolveMoveTargetStatus = vi
      .fn()
      .mockResolvedValueOnce({ id: "status-review", name: "Review" })
      .mockResolvedValueOnce({ id: "status-qa", name: "Quality assurance" });
    const issueTracker = { resolveMoveTargetStatus } as unknown as IssueTrackerAdapter;

    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        statusName: "Localized review",
        statusId: "status-review",
        aiReviewColumn: "Review",
      }),
    ).resolves.toBe(true);
    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        statusName: "Quality assurance",
        statusId: "status-qa",
        aiReviewColumn: "QA",
      }),
    ).resolves.toBe(true);

    expect(resolveMoveTargetStatus).toHaveBeenNthCalledWith(1, "PROJ-1", "Review");
    expect(resolveMoveTargetStatus).toHaveBeenNthCalledWith(2, "PROJ-1", "QA");
  });
});
