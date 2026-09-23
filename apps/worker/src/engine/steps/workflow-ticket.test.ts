import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTicket = vi.fn();
// Present only when the test says so: an issue tracker that exposes no "current
// user" concept is the shape every other case here runs under, and the one the
// step has to survive.
let getCurrentUserAccountId: (() => Promise<string>) | undefined;
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({
    issueTrackerResolution: { ok: true, adapter: {
      fetchTicket,
      ...(getCurrentUserAccountId ? { getCurrentUserAccountId } : {}),
    } },
  }),
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
  beforeEach(() => {
    fetchTicket.mockReset();
    getCurrentUserAccountId = undefined;
  });

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

  it("marks a pull request snapshot as text core composed, not text a person wrote", async () => {
    // Everything in that snapshot is ours: the URL and the head ref. The pull
    // request's body and its review comments, which are the untrusted text on
    // this trigger, are not in it. A screen reading it by default would find
    // nothing every time and report a verdict its author would believe.
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

    expect(ticket!.subjectTextIsPlaceholder).toBe(true);
  });

  it("leaves a fetched ticket unmarked, because a person wrote it", async () => {
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    fetchTicket.mockResolvedValue({
      id: "AWT-42",
      identifier: "AWT-42",
      title: "Checkout breaks",
      description: "It charges twice.",
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "AI",
      attachments: [],
    });

    const ticket = await resolveWorkflowTicketStep(
      {
        kind: "ticket",
        ticketKey: "AWT-42",
        subjectKey: "ticket:jira:AWT-42",
        ownerToken: "owner-a",
        definitionId: 7,
        definitionVersion: 11,
        scope: "any",
      } as never,
      "AI",
    );

    expect(ticket!.subjectTextIsPlaceholder).toBeUndefined();
  });

  it("synthesizes a git-ref-safe identifier for webhook deliveries", async () => {
    const { branchForTicket } = await import("../../engine/support/workflow-naming.js");
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
    // Authored: both lines are the payload the sender sent, which is exactly
    // the text a screen exists to look at.
    expect(ticket!.subjectTextIsPlaceholder).toBeUndefined();
    // Endpoint ids are "wh_" + 24 hex, so the last 6 characters are hex too.
    expect(ticket!.identifier).toMatch(/^webhook-d0e1f2-[0-9a-f]{8}$/);

    const branch = branchForTicket(ticket!.identifier);
    expect(branch).toBe(`ai-workflow/${ticket!.identifier}`);
    // git check-ref-format rules this branch must satisfy.
    expect(branch).not.toContain(":");
    expect(branch).not.toContain("..");
    expect(branch).toMatch(/^[A-Za-z0-9._/-]+$/);
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

  it("synthesizes a git-ref-safe identifier for a schedule occurrence", async () => {
    const { branchForTicket } = await import("../../engine/support/workflow-naming.js");
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const ticket = await resolveWorkflowTicketStep(
      {
        kind: "schedule",
        scheduleId: "sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "schedule-nightly",
        // Deliberately colon-laden: reusing it as the identifier would produce an
        // illegal branch name.
        subjectKey: "schedule:sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        ownerToken: "owner-a",
        scheduledFor: "2026-08-05T14:00:00.000Z",
        previousScheduledFor: "2026-08-04T14:00:00.000Z",
        taskTitle: "Sweep the backlog",
        taskDescription: "Look for stale tickets.",
      },
      "AI",
    );

    expect(fetchTicket).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({ title: "Sweep the backlog", attachments: [] });
    // Composed here, around the schedule's own instruction: an occurrence
    // receives nothing from outside the workflow for a screen to look at.
    expect(ticket!.subjectTextIsPlaceholder).toBe(true);
    expect(ticket!.identifier).toBe(
      "schedule-sch_a1b2c3d4e5f6a7b8c9d0e1f2-20260805T1400",
    );
    // The instants reach the agent, so an authored instruction can be relative.
    expect(ticket!.description).toContain("Look for stale tickets.");
    expect(ticket!.description).toContain("Scheduled for: 2026-08-05T14:00:00.000Z");
    expect(ticket!.description).toContain("Previous run: 2026-08-04T14:00:00.000Z");

    // branchForTicket lowercases, so the stamp's "T" arrives as "t". Harmless
    // here: the only branch-to-identifier reader feeds a tracker fetch, which
    // fails for every synthesized identifier whatever its case.
    const branch = branchForTicket(ticket!.identifier);
    expect(branch).toBe(`ai-workflow/${ticket!.identifier.toLowerCase()}`);
    // git check-ref-format rules this branch must satisfy.
    expect(branch).not.toContain(":");
    expect(branch).not.toContain("..");
    expect(branch).toMatch(/^[A-Za-z0-9._/-]+$/);
  });

  // Every occurrence branches from the default branch under its own identity, so
  // without this the run cannot tell that the previous one already opened a pull
  // request nobody merged. A daily "keep the changelog current" schedule would
  // redo the same change and open a duplicate every day.
  it("tells the run about pull requests the previous occurrence left open", async () => {
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const ticket = await resolveWorkflowTicketStep(
      {
        kind: "schedule",
        scheduleId: "sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "schedule-nightly",
        subjectKey: "schedule:sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        ownerToken: "owner-a",
        scheduledFor: "2026-08-05T14:00:00.000Z",
        previousScheduledFor: "2026-08-04T14:00:00.000Z",
        taskTitle: "Keep the changelog current",
        taskDescription: "Summarise what merged since the previous run.",
        previousRunPullRequests: ["https://github.com/acme/api/pull/42"],
      },
      "AI",
    );

    expect(ticket!.description).toContain(
      "Still open from the previous run: https://github.com/acme/api/pull/42",
    );
    expect(ticket!.description).toContain("do not open a second one");
  });

  it("says nothing about previous pull requests when there were none", async () => {
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const ticket = await resolveWorkflowTicketStep(
      {
        kind: "schedule",
        scheduleId: "sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        definitionId: 9,
        definitionVersion: 3,
        nodeId: "schedule-nightly",
        subjectKey: "schedule:sch_a1b2c3d4e5f6a7b8c9d0e1f2",
        ownerToken: "owner-a",
        scheduledFor: "2026-08-05T14:00:00.000Z",
        taskTitle: "Keep the changelog current",
        taskDescription: "Summarise what merged since the previous run.",
      },
      "AI",
    );

    expect(ticket!.description).not.toContain("Still open from the previous run");
  });

  // Per occurrence, never per schedule. The identifier is the primary key of the
  // branch ledger and the Slack thread key, so one identifier per schedule would
  // land every occurrence on the first one's branch: the publication would push
  // into the existing pull request, Slack would edit the same post, and once a
  // human pushed a fix to that branch every later occurrence would die on
  // "branch has diverged".
  it("gives two occurrences of one schedule different identifiers", async () => {
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");
    const base = {
      kind: "schedule" as const,
      scheduleId: "sch_a1b2c3d4e5f6a7b8c9d0e1f2",
      definitionId: 9,
      definitionVersion: 3,
      nodeId: "schedule-nightly",
      subjectKey: "schedule:sch_a1b2c3d4e5f6a7b8c9d0e1f2",
      ownerToken: "owner-a",
      taskTitle: "Sweep the backlog",
      taskDescription: "Look for stale tickets.",
    };
    const first = await resolveWorkflowTicketStep(
      { ...base, scheduledFor: "2026-08-05T14:00:00.000Z" },
      "AI",
    );
    // The closest two occurrences can ever be: the minimum period is fifteen
    // minutes, so minute resolution is enough to keep them apart.
    const second = await resolveWorkflowTicketStep(
      { ...base, scheduledFor: "2026-08-05T14:15:00.000Z" },
      "AI",
    );

    expect(first!.identifier).not.toBe(second!.identifier);
    expect(second!.identifier).toBe(
      "schedule-sch_a1b2c3d4e5f6a7b8c9d0e1f2-20260805T1415",
    );
  });

  const correlatedEntry = {
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

  it("carries the account the workflow posts as, so its own comments stop reading as testimony", async () => {
    fetchTicket.mockResolvedValue({ identifier: "AIW-1", trackerStatus: "Review" });
    getCurrentUserAccountId = vi.fn().mockResolvedValue("bot-account-1");
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");

    const ticket = await resolveWorkflowTicketStep(correlatedEntry, "AI");

    expect(ticket).toMatchObject({ identifier: "AIW-1", botAccountId: "bot-account-1" });
  });

  it("fails open when the tracker cannot say who the bot is", async () => {
    fetchTicket.mockResolvedValue({ identifier: "AIW-1", trackerStatus: "Review" });
    getCurrentUserAccountId = vi.fn().mockRejectedValue(new Error("Jira /myself: 403"));
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const { resolveWorkflowTicketStep } = await import("./workflow-ticket.js");

    const ticket = await resolveWorkflowTicketStep(correlatedEntry, "AI");

    // The run continues without the identity, which is how every run behaved
    // before this field existed, and the reason is in the log rather than lost.
    expect(ticket).toMatchObject({ identifier: "AIW-1" });
    expect(ticket).not.toHaveProperty("botAccountId");
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
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
