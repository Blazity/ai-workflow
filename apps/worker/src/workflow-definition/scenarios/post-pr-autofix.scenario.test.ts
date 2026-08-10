import { describe, expect, it } from "vitest";
import type { BlockOutput, ReviewResultFinding } from "@shared/contracts";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { buildReviewAgentSuccessOutput } from "../../workflows/agent.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  portsOf,
} from "./assertions.js";
import { createScenario, type Scenario } from "./harness.js";
import { executionError } from "../interpreter.js";

const TEMPLATE = {
  id: "post-pr-autofix",
  options: { includeReview: true, provider: "claude" as const },
};
const SNAPSHOT = { path: "post-pr-autofix-v1.json" };

const REVIEWS = [
  "security-review",
  "quality-review",
  "requirements-review",
] as const;

const CHECK = {
  id: "check-1",
  headSha: "abc123",
  name: "AI Workflow / Review",
};

const ENTRY: AgentWorkflowInput = {
  kind: "pr_trigger",
  triggerType: "trigger_pr_ready",
  subjectKey: "pr:github:acme/app#7",
  ownerToken: "owner-1",
  definitionId: 1,
  definitionVersion: 1,
  scope: "workflow_owned",
  pr: {
    provider: "github",
    repoPath: "acme/app",
    prNumber: 7,
    prUrl: "https://github.test/acme/app/pull/7",
    headRef: "feature",
    headSha: "abc123",
    baseRef: "main",
    title: "Autofix review",
    author: "contributor",
    isDraft: false,
  },
};

const FINDING: ReviewResultFinding = {
  file: "src/index.ts",
  description: "The implementation needs a correction.",
  severity: "High",
  startLine: 10,
  endLine: 10,
};

function scenario(source: "template" | "snapshot"): Scenario {
  return source === "template"
    ? createScenario({
        template: TEMPLATE,
        entry: ENTRY,
        entryTriggerId: "trigger-ready",
      })
    : createScenario({
        snapshot: SNAPSHOT,
        entry: ENTRY,
        entryTriggerId: "trigger-ready",
      });
}

function reviewOutput(
  nodeId: string,
  decision: "approve" | "request_changes",
  pass: number,
): BlockOutput {
  return buildReviewAgentSuccessOutput({
    feedback: `${nodeId} pass ${pass}`,
    issues: decision === "approve" ? [] : [FINDING],
  });
}

function scriptPrelude(scenarioToScript: Scenario): void {
  scenarioToScript.script({ nodeId: "create-check" }, {
    kind: "next",
    output: { status: "ok", check: CHECK },
  });
  scenarioToScript.script({ nodeId: "prepare" }, {
    kind: "next",
    output: {
      status: "ok",
      sandboxId: "sbx-scenario",
      repositories: ["github:acme/app"],
      workspace: { id: "sbx-scenario", repositories: ["github:acme/app"] },
    },
  });
  scenarioToScript.script({ nodeId: "fix" }, {
    kind: "next",
    output: {
      status: "fixed",
      workspaceId: "sbx-scenario",
      commits: [],
      resolvedConflicts: [],
      unresolvedConflicts: [],
      summary: "Fixed the review findings.",
    },
  });
}

function scriptReviews(
  scenarioToScript: Scenario,
  approveAfterFix: boolean,
): void {
  for (const nodeId of REVIEWS) {
    scenarioToScript.script({ nodeId }, (_node, _inputs, context) => {
      const decision =
        approveAfterFix && context.activationScopeId !== "root"
          ? "approve"
          : "request_changes";
      return {
        kind: "next",
        output: reviewOutput(
          nodeId,
          decision,
          context.activationScopeId === "root" ? 1 : 2,
        ),
      };
    });
  }
}

function scriptPostReview(
  scenarioToScript: Scenario,
  nodeId: "post-review-approved" | "post-review-exhausted",
): void {
  scenarioToScript.script({ nodeId }, (_node, inputs) => {
    const results = inputs.reviewResults as Array<{ decision: string; findings: unknown[] }>;
    const approved = results.every((result) => result.decision === "approve");
    return {
      kind: "next",
      output: {
        status: "ok",
        decision: approved ? "approve" : "request_changes",
        summary: approved ? "Approved." : "Unresolved findings.",
        inlineCommentCount: results.reduce(
          (count, result) => count + result.findings.length,
          0,
        ),
        summaryFallbackCount: 0,
      },
    };
  });
}

function scriptCompletion(
  scenarioToScript: Scenario,
  nodeId: "complete-success" | "complete-failure",
): void {
  scenarioToScript.script({ nodeId }, (_node, inputs) => ({
    kind: "next",
    output: {
      status: "ok",
      check: inputs.check as typeof CHECK,
      conclusion: nodeId === "complete-success" ? "success" : "failure",
    },
  }));
}

describe("post-PR autofix workflow", () => {
  it.each(["template", "snapshot"] as const)(
    "approves after one fix and publishes exactly once (%s)",
    async (source) => {
    const scenarioToRun = scenario(source);
    scriptPrelude(scenarioToRun);
    scriptReviews(scenarioToRun, true);
    scriptPostReview(scenarioToRun, "post-review-approved");
    scriptCompletion(scenarioToRun, "complete-success");

    const outcome = await scenarioToRun.execute();

    expect(outcome.result.executionError).toBeUndefined();
    expect(outcome.result.outcome).toBe("completed");
    expect(executorRunsOf(outcome, "fix")).toHaveLength(1);
    for (const nodeId of REVIEWS) {
      expect(executorRunsOf(outcome, nodeId)).toHaveLength(2);
    }
    expect(portsOf(outcome, "review-approved")).toEqual(["false", "true"]);
    expect(executorRunsOf(outcome, "post-review-approved")).toHaveLength(1);
    expect(
      executorRunsOf(outcome, "post-review-approved")[0].resolvedInputs?.reviewResults,
    ).toEqual(
      REVIEWS.map((nodeId) =>
        expect.objectContaining({ decision: "approve" }),
      ),
    );
    expectNeverInvoked(outcome, ["post-review-exhausted", "exhausted-message", "complete-failure"]);
    },
  );

  it.each(["template", "snapshot"] as const)(
    "exhausts after two fixes and publishes the failure review exactly once (%s)",
    async (source) => {
    const scenarioToRun = scenario(source);
    scriptPrelude(scenarioToRun);
    scriptReviews(scenarioToRun, false);
    scriptPostReview(scenarioToRun, "post-review-exhausted");
    scenarioToRun.script({ nodeId: "exhausted-message" }, {
      kind: "next",
      output: { status: "ok" },
    });
    scriptCompletion(scenarioToRun, "complete-failure");

    const outcome = await scenarioToRun.execute();

    expect(outcome.result.executionError).toBeUndefined();
    expect(outcome.result.outcome).toBe("completed");
    expect(executorRunsOf(outcome, "fix")).toHaveLength(2);
    for (const nodeId of REVIEWS) {
      expect(executorRunsOf(outcome, nodeId)).toHaveLength(3);
    }
    expect(executorRunsOf(outcome, "post-review-exhausted")).toHaveLength(1);
    expect(executorRunsOf(outcome, "exhausted-message")).toHaveLength(1);
    expectNeverInvoked(outcome, ["post-review-approved", "complete-success"]);
    },
  );

  it.each(["template", "snapshot"] as const)(
    "does not publish a stale review when the second round dies (%s)",
    async (source) => {
      const scenarioToRun = scenario(source);
      scriptPrelude(scenarioToRun);
      for (const nodeId of REVIEWS) {
        scenarioToRun.script({ nodeId }, (_node, _inputs, context) => {
          if (nodeId === "quality-review" && context.activationScopeId !== "root") {
            return executionError("The review provider connection dropped.", {
              category: "provider",
              phase: "agent",
            });
          }
          return {
            kind: "next",
            output: reviewOutput(nodeId, "request_changes", context.activationScopeId === "root" ? 1 : 2),
          };
        });
      }

      const outcome = await scenarioToRun.execute();

      expect(outcome.result.outcome).toBe("failed");
      expect(outcome.result.executionError).toMatchObject({
        nodeId: "quality-review",
        category: "provider",
      });
      expectNeverInvoked(outcome, [
        "post-review-approved",
        "post-review-exhausted",
        "exhausted-message",
        "complete-success",
        "complete-failure",
      ]);
    },
  );
});
