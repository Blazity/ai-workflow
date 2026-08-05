import { describe, expect, it } from "vitest";
import { runKindForAgentWorkflowInput } from "./agent-input.js";

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

  it.each([
    [ticket, "ticket"],
    [{ ...ticket, manualDispatchId: "manual-1" }, "manual_ticket"],
    [prTrigger, "pr_trigger"],
    [{ ...prTrigger, manualDispatchId: "manual-2" }, "manual_pr_trigger"],
  ] as const)("maps %s to %s", (entry, expected) => {
    expect(runKindForAgentWorkflowInput(entry)).toBe(expected);
  });
});
