import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTicket = vi.fn();
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ issueTracker: { fetchTicket } }),
}));

const pr = {
  provider: "github" as const,
  repoPath: "acme/api",
  prNumber: 42,
  prUrl: "https://github.com/acme/api/pull/42",
  headRef: "feature/x",
  headSha: "abc",
  baseRef: "main",
  title: "Review this",
  author: "alice",
  isDraft: false,
};

describe("resolveWorkflowTicketStep", () => {
  beforeEach(() => fetchTicket.mockReset());

  it("builds PR-only context for a synthetic subject without touching Jira", async () => {
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const ticket = await resolveWorkflowTicketStep(
      {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "pr:github:acme/api#42",
        ownerToken: "owner-a",
        definitionId: 7,
        definitionVersion: 11,
        scope: "any",
        pr,
      },
      "AI",
    );
    expect(fetchTicket).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({
      id: "pr:github:acme/api#42",
      identifier: "pr:github:acme/api#42",
      title: "Review this",
      attachments: [],
    });
  });

  it("fetches the real correlated ticket for workflow_owned PR subjects", async () => {
    fetchTicket.mockResolvedValue({ identifier: "AIW-1", trackerStatus: "Review" });
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const entry = {
      kind: "pr_trigger" as const,
      triggerType: "trigger_pr_review" as const,
      subjectKey: "ticket:jira:AIW-1",
      ticketKey: "AIW-1",
      ownerToken: "owner-a",
      definitionId: 7,
      definitionVersion: 11,
      scope: "workflow_owned" as const,
      pr,
    };
    expect(await resolveWorkflowTicketStep(entry, "AI")).toMatchObject({ identifier: "AIW-1" });
    expect(fetchTicket).toHaveBeenCalledWith("AIW-1");
  });
});
