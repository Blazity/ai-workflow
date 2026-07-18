import { describe, expect, it } from "vitest";
import {
  normalizeClarificationOrigin,
  restoreClarificationOrigin,
  type AgentWorkflowInput,
} from "./agent-input.js";

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

  it("preserves plan approval context without carrying predecessor ownership", () => {
    const entry: Extract<AgentWorkflowInput, { kind: "plan_approved" }> = {
      kind: "plan_approved",
      subjectKey: "ticket:jira:AIW-96",
      ticketKey: "AIW-96",
      ownerToken: "owner-predecessor",
      definitionId: 5,
      definitionVersion: 9,
      approvedPlan: { markdown: "Implement the approved plan.", assumptions: ["flagged"] },
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
