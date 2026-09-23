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

/** One tracker instance, as the board and the reconciler both spell it. */
const JIRA_ACME = "jira\u0000https://acme.atlassian.net";
const JIRA_OTHER = "jira\u0000https://other.atlassian.net";

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
        trackerIdentity: JIRA_ACME,
        statusName: "Localized review",
        statusId: "status-review",
        aiReviewColumn: "Review",
      }),
    ).resolves.toBe(true);
    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        trackerIdentity: JIRA_ACME,
        statusName: "Quality assurance",
        statusId: "status-qa",
        aiReviewColumn: "QA",
      }),
    ).resolves.toBe(true);

    expect(resolveMoveTargetStatus).toHaveBeenNthCalledWith(1, "PROJ-1", "Review");
    expect(resolveMoveTargetStatus).toHaveBeenNthCalledWith(2, "PROJ-1", "QA");
  });

  // Since S12 the transition id comes from the tracker's CONNECTION, which is
  // a database read that can fail for one tick. A key on the column name alone
  // then cached the answer resolved without the id and kept serving it for the
  // life of the process, so a run finishing normally kept reading as a ticket
  // pulled out of the AI column long after the read had recovered.
  it("resolves again once the transition id the read could not give it arrives", async () => {
    const resolveMoveTargetStatus = vi
      .fn()
      .mockResolvedValueOnce({ id: "status-by-name", name: "Review" })
      .mockResolvedValueOnce({ id: "status-by-transition", name: "Weryfikacja" });
    const issueTracker = { resolveMoveTargetStatus } as unknown as IssueTrackerAdapter;

    // The degraded tick: the wiring read failed, so no transition id.
    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        trackerIdentity: JIRA_ACME,
        statusName: "Localized review",
        statusId: "status-by-name",
        aiReviewColumn: "Review",
      }),
    ).resolves.toBe(true);

    // The next tick, read recovered. The same column, a different resolution.
    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        trackerIdentity: JIRA_ACME,
        statusName: "Localized review",
        statusId: "status-by-transition",
        aiReviewColumn: "Review",
        aiReviewTransitionId: "31",
      }),
    ).resolves.toBe(true);

    expect(resolveMoveTargetStatus).toHaveBeenNthCalledWith(1, "PROJ-1", "Review");
    expect(resolveMoveTargetStatus).toHaveBeenNthCalledWith(2, "PROJ-1", {
      name: "Review",
      transitionId: "31",
    });
  });

  // The operation this whole branch exists to make possible: an admin
  // repointing the connection, on a worker that is already warm. Every status
  // id cached here belongs to the instance it was read from, and after a
  // repoint it can never match again. Serving it makes the reconciler read a
  // ticket sitting in AI Review as a ticket that left the AI column, and it
  // cancels a healthy run in front of whoever is watching it.
  it("resolves again when the same column belongs to a different tracker", async () => {
    const resolveMoveTargetStatus = vi
      .fn()
      .mockResolvedValueOnce({ id: "acme-review", name: "Review" })
      .mockResolvedValueOnce({ id: "other-review", name: "Review" });
    const issueTracker = { resolveMoveTargetStatus } as unknown as IssueTrackerAdapter;

    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        trackerIdentity: JIRA_ACME,
        statusName: "Localized review",
        statusId: "acme-review",
        aiReviewColumn: "Review",
      }),
    ).resolves.toBe(true);

    // Same column name, same absent transition id, different instance.
    await expect(
      isAiReviewDestination({
        issueTracker,
        ticketKey: "PROJ-1",
        trackerIdentity: JIRA_OTHER,
        statusName: "Localized review",
        statusId: "other-review",
        aiReviewColumn: "Review",
      }),
    ).resolves.toBe(true);

    expect(resolveMoveTargetStatus).toHaveBeenCalledTimes(2);
  });
});
