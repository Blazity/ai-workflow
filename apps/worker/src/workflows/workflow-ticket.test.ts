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

  it("synthesizes a git-ref-safe identifier for webhook deliveries", async () => {
    const { branchForTicket } = await import("../lib/workflow-naming.js");
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const ticket = await resolveWorkflowTicketStep(
      {
        kind: "webhook_trigger",
        endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "webhook-support",
        deliveryId: "delivery-1",
        // Deliberately colon-laden: reusing it as the identifier would produce
        // an illegal branch name.
        subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
        ownerToken: "owner-a",
        entry: {
          subject: "Printer is on fire",
          description: "It started smoking after the firmware update.",
          requester: "customer@acme.test",
          priority: "urgent",
          payload: { ticket: { id: 77 } },
        },
      },
      "AI",
    );

    expect(fetchTicket).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({
      title: "Printer is on fire",
      description: "It started smoking after the firmware update.",
      attachments: [],
    });
    // Endpoint ids are "wh_" + 24 hex, so the last 6 characters are hex too.
    expect(ticket!.identifier).toMatch(/^webhook-d0e1f2-[0-9a-f]{8}$/);

    const branch = branchForTicket(ticket!.identifier);
    expect(branch).toBe(`ai-workflow/${ticket!.identifier}`);
    // git check-ref-format rules this branch must satisfy.
    expect(branch).not.toContain(":");
    expect(branch).not.toContain("..");
    expect(branch).toMatch(/^[A-Za-z0-9._\/-]+$/);
  });

  it("derives the webhook identifier from the delivery, not the subject", async () => {
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const base = {
      kind: "webhook_trigger" as const,
      endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
      definitionId: 9,
      definitionVersion: 3,
      nodeId: "webhook-support",
      subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
      ownerToken: "owner-a",
      entry: {
        subject: "Printer is on fire",
        description: "Smoke",
        requester: "customer@acme.test",
        priority: "urgent",
        payload: {},
      },
    };
    const first = await resolveWorkflowTicketStep({ ...base, deliveryId: "delivery-1" }, "AI");
    const second = await resolveWorkflowTicketStep({ ...base, deliveryId: "delivery-2" }, "AI");

    expect(first!.identifier).not.toBe(second!.identifier);
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
