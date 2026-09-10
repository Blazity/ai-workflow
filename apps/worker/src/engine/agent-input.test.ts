import { describe, expect, it } from "vitest";
import {
  normalizeClarificationOrigin,
  restoreClarificationOrigin,
  runKindForAgentWorkflowInput,
  type AgentWorkflowInput,
} from "./agent-input.js";

describe("workflow run kind", () => {
  const ticket = {
    kind: "ticket",
    subjectKey: "ticket:jira:PROJ-1",
    ticketKey: "PROJ-1",
    ownerToken: "owner",
  } as const;
  const prTrigger = {
    kind: "pr_trigger",
    triggerType: "trigger_pr_created",
    subjectKey: "pr:github:acme/api:42",
    ownerToken: "owner",
    definitionId: 7,
    definitionVersion: 12,
    scope: "any",
    pr: {
      provider: "github",
      repoPath: "acme/api",
      prNumber: 42,
      prUrl: "https://github.com/acme/api/pull/42",
      headRef: "feature/review",
      headSha: "deadbeef",
      baseRef: "main",
      title: "Review me",
      author: "alice",
      isDraft: false,
    },
  } as const;

  const webhookTrigger = {
    kind: "webhook_trigger",
    endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
    definitionId: 9,
    definitionVersion: 3,
    nodeId: "webhook-support",
    deliveryId: "delivery-1",
    subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
    ownerToken: "owner",
    entry: {
      subject: "Printer is on fire",
      description: "Smoke after the firmware update.",
      requester: "customer@acme.test",
      priority: "urgent",
      payload: { ticket: { id: 77 } },
    },
  } as const;

  it.each([
    [ticket, "ticket"],
    [{ ...ticket, manualDispatchId: "manual-1" }, "manual_ticket"],
    [prTrigger, "pr_trigger"],
    [{ ...prTrigger, manualDispatchId: "manual-2" }, "manual_pr_trigger"],
    [webhookTrigger, "webhook_trigger"],
  ] as const)("maps %s to %s", (entry, expected) => {
    expect(runKindForAgentWorkflowInput(entry)).toBe(expected);
  });
});

describe("clarification origin entries", () => {
  it("restores the full PR trigger context under the successor identity", () => {
    const entry: Extract<AgentWorkflowInput, { kind: "pr_trigger" }> = {
      kind: "pr_trigger",
      triggerType: "trigger_pr_review",
      subjectKey: "pr:github:acme/api:42",
      ownerToken: "owner-predecessor",
      definitionId: 7,
      definitionVersion: 12,
      scope: "any",
      pendingEvent: {
        headSha: "deadbeef",
        triggerType: "trigger_pr_review",
        deliveryId: "delivery-1",
      },
      delivery: {
        provider: "github",
        producer: "github-actions",
        deliveryId: "delivery-1",
      },
      pr: {
        provider: "github",
        repoPath: "acme/api",
        prNumber: 42,
        prUrl: "https://github.com/acme/api/pull/42",
        headRef: "feature/review",
        headSha: "deadbeef",
        baseRef: "main",
        title: "Review me",
        author: "alice",
        isDraft: false,
        review: { state: "commented", author: "bob", body: "Please clarify this." },
      },
    };

    const origin = normalizeClarificationOrigin(entry);
    expect(origin).not.toHaveProperty("subjectKey");
    expect(origin).not.toHaveProperty("ownerToken");
    expect(origin).not.toHaveProperty("pendingEvent");
    expect(origin).not.toHaveProperty("delivery");
    expect(restoreClarificationOrigin(origin, {
      subjectKey: entry.subjectKey,
      ownerToken: "owner-successor",
      clarificationRequestId: "clar-1",
    })).toEqual({
      ...entry,
      ownerToken: "owner-successor",
      pendingEvent: undefined,
      delivery: undefined,
      continuation: { kind: "clarification", clarificationRequestId: "clar-1" },
    });
  });

  it("restores the webhook delivery context without inventing a ticket", () => {
    const entry: Extract<AgentWorkflowInput, { kind: "webhook_trigger" }> = {
      kind: "webhook_trigger",
      endpointId: "wh_a1b2c3d4e5f6a7b8c9d0e1f2",
      definitionId: 9,
      definitionVersion: 3,
      nodeId: "webhook-support",
      deliveryId: "delivery-1",
      subjectKey: "webhook:wh_a1b2c3d4e5f6a7b8c9d0e1f2:ticket-77",
      ownerToken: "owner-predecessor",
      entry: {
        subject: "Printer is on fire",
        description: "Smoke after the firmware update.",
        requester: "customer@acme.test",
        priority: "urgent",
        payload: { ticket: { id: 77 } },
      },
    };

    const origin = normalizeClarificationOrigin(entry);
    expect(origin).not.toHaveProperty("subjectKey");
    expect(origin).not.toHaveProperty("ownerToken");
    expect(origin).not.toHaveProperty("ticketKey");
    expect(restoreClarificationOrigin(origin, {
      subjectKey: entry.subjectKey,
      ownerToken: "owner-successor",
      clarificationRequestId: "clar-3",
    })).toEqual({
      ...entry,
      ownerToken: "owner-successor",
      continuation: { kind: "clarification", clarificationRequestId: "clar-3" },
    });
  });

  it("preserves plan approval context without carrying predecessor ownership", () => {
    const entry: Extract<AgentWorkflowInput, { kind: "plan_approved" }> = {
      kind: "plan_approved",
      subjectKey: "ticket:jira:AIW-96",
      ticketKey: "AIW-96",
      ownerToken: "owner-predecessor",
      definitionId: 5,
      definitionVersion: 9,
      approvedPlan: {
        markdown: "Implement the approved plan.",
        sourceRunId: "run-produced",
        assumptions: ["flagged"],
        repositoryScope: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/api",
              defaultBranch: "main",
              researchBranch: "main",
              researchBaseSha: "base-sha",
              access: "write",
              rationale: "implementation",
            },
          ],
        },
      },
      approval: {
        approvalRequestId: "approval-1",
        approver: "Alice",
        approvedAt: "2026-07-18T00:00:00.000Z",
      },
    };

    expect(restoreClarificationOrigin(normalizeClarificationOrigin(entry), {
      subjectKey: entry.subjectKey,
      ownerToken: "owner-successor",
      clarificationRequestId: "clar-2",
    })).toEqual({
      ...entry,
      ownerToken: "owner-successor",
      continuation: { kind: "clarification", clarificationRequestId: "clar-2" },
    });
  });
});
