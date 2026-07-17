import { describe, expect, it } from "vitest";
import type { WorkflowParamValue } from "@shared/contracts";
import {
  resolveWorkflowBlockContract,
  validateBlockOutputAgainstContract,
  type WorkflowBlockRegistryContext,
} from "../workflow-definition/block-registry.js";
import type { AgentWorkflowInput, PrTriggerPayload } from "./agent-input.js";
import { triggerOutputFor } from "./agent.js";

const context: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github"],
  vcsBotIdentities: ["github"],
  slackConfigured: true,
  arthurConfigured: true,
};

const basePr: PrTriggerPayload = {
  provider: "github",
  repoPath: "acme/app",
  prNumber: 42,
  prUrl: "https://github.test/acme/app/pull/42",
  headRef: "external/change",
  headSha: "abc123",
  baseRef: "main",
  title: "External change",
  author: "contributor",
  isDraft: false,
};

type PrTriggerEntry = Extract<AgentWorkflowInput, { kind: "pr_trigger" }>;
type PrTriggerType = PrTriggerEntry["triggerType"];

function entryFor(type: PrTriggerType): PrTriggerEntry {
  const pr: PrTriggerPayload = {
    ...basePr,
    ...(type === "trigger_pr_checks_failed"
      ? { failedChecks: [{ name: "test", conclusion: "failure" }] }
      : {}),
    ...(type === "trigger_pr_review"
      ? { review: { state: "changes_requested" as const, author: "reviewer", body: "Fix this" } }
      : {}),
    ...(type === "trigger_pr_merged"
      ? { mergeSha: "merge123", mergedAt: "2026-07-18T00:00:00.000Z" }
      : {}),
  };
  return {
    kind: "pr_trigger",
    triggerType: type,
    subjectKey: "pr:github:acme/app#42",
    // A stale or hand-built envelope must not make scope:any publish a field
    // that its binding contract deliberately omits.
    ticketKey: "AIW-ignored",
    ownerToken: "owner-1",
    definitionId: 1,
    definitionVersion: 1,
    scope: "any",
    pr,
  };
}

describe("scope:any PR trigger output", () => {
  it.each([
    "trigger_pr_created",
    "trigger_pr_checks_failed",
    "trigger_pr_review",
    "trigger_pr_merged",
  ] as const)("omits ticketKey and satisfies the %s runtime contract", (type) => {
    const output = triggerOutputFor(entryFor(type));
    const params: Record<string, WorkflowParamValue> = {
      providers: ["github"],
      scope: "any",
      ...(type === "trigger_pr_review" ? { on: ["changes_requested"] } : {}),
    };
    const contract = resolveWorkflowBlockContract(type, params, context);

    expect(output).not.toHaveProperty("ticketKey");
    expect(validateBlockOutputAgainstContract(contract, output)).toEqual([]);
  });
});
