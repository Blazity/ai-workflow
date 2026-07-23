import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import {
  validateWorkflowV2WorkspaceAccessIssues,
  workflowWorkspaceAccessOf,
} from "./workspace-access.js";

function node(
  id: string,
  type: WorkflowBlockType,
  configuration: Record<string, never> = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration,
    inputs: {},
    additionalInputs: [],
  };
}

function definition(
  nodes: WorkflowDefinitionV2Node[],
  edges: WorkflowDefinitionV2["edges"],
): WorkflowDefinitionV2 {
  return { schemaVersion: 2, nodes, edges };
}

describe("workflowWorkspaceAccessOf", () => {
  it("isolates Review and classifies shared readers and writers", () => {
    expect(workflowWorkspaceAccessOf(node("review", "review_agent"))).toBe(
      "isolated_review",
    );
    expect(workflowWorkspaceAccessOf(node("plan", "planning_agent"))).toBe(
      "shared_read",
    );
    expect(
      workflowWorkspaceAccessOf(
        node("generic", "generic_agent", { workspaceMode: "none" } as never),
      ),
    ).toBe("none");
    expect(workflowWorkspaceAccessOf(node("fix", "fix_agent"))).toBe(
      "shared_write",
    );
  });
});

describe("validateWorkflowV2WorkspaceAccessIssues", () => {
  it("rejects concurrent writer/writer and writer/reader paths", () => {
    const nodes = [
      node("trigger", "trigger_ticket_ai"),
      node("split", "post_ticket_comment"),
      node("implementation", "implementation_agent"),
      node("checks", "run_checks"),
      node("planning", "planning_agent"),
    ];
    const issues = validateWorkflowV2WorkspaceAccessIssues(
      definition(nodes, [
        { id: "e1", from: "trigger", to: "split" },
        { id: "e2", from: "split", to: "implementation" },
        { id: "e3", from: "split", to: "checks" },
        { id: "e4", from: "split", to: "planning" },
      ]),
    );

    expect(issues).toHaveLength(3);
    expect(issues.every((issue) => issue.code === "workspace.concurrent_access")).toBe(
      true,
    );
  });

  it("allows sequential workspace users", () => {
    expect(
      validateWorkflowV2WorkspaceAccessIssues(
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("implementation", "implementation_agent"),
            node("checks", "run_checks"),
          ],
          [
            { id: "e1", from: "trigger", to: "implementation" },
            { id: "e2", from: "implementation", to: "checks" },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("allows mutually exclusive Branch paths", () => {
    expect(
      validateWorkflowV2WorkspaceAccessIssues(
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("branch", "branch"),
            node("left", "implementation_agent"),
            node("right", "fix_agent"),
          ],
          [
            { id: "e1", from: "trigger", to: "branch" },
            { id: "e2", from: "branch", fromPort: "true", to: "left" },
            { id: "e3", from: "branch", fromPort: "false", to: "right" },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("allows parallel disposable Reviews", () => {
    expect(
      validateWorkflowV2WorkspaceAccessIssues(
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("split", "post_ticket_comment"),
            node("review-a", "review_agent"),
            node("review-b", "review_agent"),
          ],
          [
            { id: "e1", from: "trigger", to: "split" },
            { id: "e2", from: "split", to: "review-a" },
            { id: "e3", from: "split", to: "review-b" },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it("orders a disposable Review snapshot against concurrent shared writers", () => {
    const issues = validateWorkflowV2WorkspaceAccessIssues(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("split", "post_ticket_comment"),
          node("implementation", "implementation_agent"),
          node("review", "review_agent"),
        ],
        [
          { id: "e1", from: "trigger", to: "split" },
          { id: "e2", from: "split", to: "implementation" },
          { id: "e3", from: "split", to: "review" },
        ],
      ),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        code: "workspace.concurrent_access",
        nodeId: "review",
      }),
    ]);
  });
});
