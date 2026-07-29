import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { workflowDefinitionTemplate } from "./templates.js";
import { executeV2Graph } from "./v2-scheduler.js";

function reviewedTemplate() {
  const template = workflowDefinitionTemplate("reviewed-ticket-workflow", {
    includeReview: true,
    provider: "claude",
  });
  if (!template || template.definition.schemaVersion !== 2) {
    throw new Error("Reviewed ticket template is unavailable.");
  }
  return template.definition;
}

function ordinaryOutput(node: WorkflowDefinitionV2Node): BlockOutput {
  switch (node.type) {
    case "prepare_workspace":
      return {
        status: "ok",
        sandboxId: "sbx-template",
        repositories: ["github:acme/app"],
        workspace: {
          id: "sbx-template",
          repositories: ["github:acme/app"],
        },
      };
    case "planning_agent":
      return { status: "ready", plan: "Implement the ticket." };
    case "implementation_agent":
      return {
        status: "implemented",
        workspaceId: "sbx-template",
        branches: [],
        commits: [],
        summary: "Implemented.",
      };
    case "fix_agent":
      return {
        status: "fixed",
        workspaceId: "sbx-template",
        commits: [],
        resolvedConflicts: [],
        unresolvedConflicts: [],
        summary: "Fixed.",
      };
    case "run_pre_pr_checks":
      return {
        status: "ok",
        ok: true,
        outcome: "passed",
        fixCycles: 0,
        summary: "Checks passed.",
      };
    case "finalize_workspace":
      return {
        status: "finalized",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/app",
            branchName: "ai-workflow/AIW-186",
            defaultBranch: "main",
            expectedHead: "before",
            pushedHead: "after",
          },
        ],
      };
    case "open_pr":
      return {
        status: "ok",
        prs: [
          {
            provider: "github",
            repoPath: "acme/app",
            id: 1,
            url: "https://github.com/acme/app/pull/1",
            branch: "ai-workflow/AIW-186",
            isNew: true,
          },
        ],
        prUrl: "https://github.com/acme/app/pull/1",
        prNumber: 1,
      };
    case "update_ticket_status":
      return { status: "ok", target: "ai_review" };
    case "send_slack_message":
      return { status: "ok" };
    default:
      return { status: "ok" };
  }
}

describe("Reviewed ticket workflow template execution", () => {
  it("passes the exact prior results to Fix and exits after the fourth review pass", async () => {
    const reviewAttempts = new Map<string, number[]>();
    const fixInputs: unknown[] = [];
    const result = await executeV2Graph({
      definition: reviewedTemplate(),
      entryTriggerId: "trigger",
      triggerOutput: {
        status: "ok",
        ticket: {},
        comments: [],
        priorAnswers: [],
      },
      executeBlock: async (node, _steps, inputs, context) => {
        if (node.type === "review_agent") {
          const attempts = reviewAttempts.get(node.id) ?? [];
          attempts.push(context.attempt);
          reviewAttempts.set(node.id, attempts);
          return {
            kind: "next",
            output: {
              status: "reviewed",
              decision:
                context.attempt === 4 ? "approve" : "request_changes",
              findings:
                context.attempt === 4
                  ? []
                  : [
                      {
                        file: `${node.id}.ts`,
                        description: `Finding from pass ${context.attempt}.`,
                        severity: "critical",
                      },
                    ],
            },
          };
        }
        if (node.id === "fix") {
          fixInputs.push(structuredClone(inputs.reviewResults));
        }
        return { kind: "next", output: ordinaryOutput(node) };
      },
    });

    expect(result.executionError).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect([...reviewAttempts.values()]).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
    expect(fixInputs).toHaveLength(3);
    for (const [index, input] of fixInputs.entries()) {
      expect(input).toEqual([
        expect.objectContaining({
          decision: "request_changes",
          findings: [
            expect.objectContaining({
              description: `Finding from pass ${index + 1}.`,
            }),
          ],
        }),
        expect.objectContaining({ decision: "request_changes" }),
        expect.objectContaining({ decision: "request_changes" }),
      ]);
    }
  });

  it("reports exhaustion and terminates the workflow as failed", async () => {
    const invoked: string[] = [];
    const result = await executeV2Graph({
      definition: reviewedTemplate(),
      entryTriggerId: "trigger",
      triggerOutput: {
        status: "ok",
        ticket: {},
        comments: [],
        priorAnswers: [],
      },
      executeBlock: async (node) => {
        invoked.push(node.id);
        if (node.type === "terminate") {
          return {
            kind: "execution_error",
            error: {
              category: "engine",
              phase: "terminate",
              message: "Terminated by workflow.",
            },
          };
        }
        if (node.type === "review_agent") {
          return {
            kind: "next",
            output: {
              status: "reviewed",
              decision: "request_changes",
              findings: [
                {
                  file: `${node.id}.ts`,
                  description: "Still unresolved.",
                  severity: "critical",
                },
              ],
            },
          };
        }
        return { kind: "next", output: ordinaryOutput(node) };
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.executionError).toMatchObject({
      nodeId: "exhausted-failure",
      category: "engine",
      phase: "terminate",
    });
    expect(invoked).toContain("exhausted-message");
    expect(invoked).not.toContain("checks");
    expect(result.state.scopes.root.nodeStates["exhausted-failure"]).toEqual({
      status: "failed",
      attempt: 1,
    });
  });
});
