import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV2Node } from "@shared/contracts";

import { workflowNeedsRepositoryAccess } from "./repository-access.js";

/**
 * The graph question behind the run-start refusal: does this definition need a
 * repository at all?
 *
 * A ticket trigger is not one of the four paths the catalog decides dispatch
 * on, so a ticket moved into the AI column starts a run whatever the catalog
 * says. Refusing every one of those on an empty catalog would fail a triage
 * graph that never wanted a checkout, which is why this asks the graph first.
 */
function node(
  type: WorkflowDefinitionV2Node["type"],
  configuration: Record<string, unknown> = {},
): WorkflowDefinitionV2Node {
  return {
    id: `${type}-1`,
    type,
    x: 0,
    y: 0,
    configuration,
  } as unknown as WorkflowDefinitionV2Node;
}

describe("workflowNeedsRepositoryAccess", () => {
  it("says no to a triage graph, which does its whole job without a checkout", () => {
    expect(
      workflowNeedsRepositoryAccess([
        node("trigger_ticket_ai"),
        node("call_llm"),
        node("post_ticket_comment"),
        node("update_ticket_status"),
      ]),
    ).toBe(false);
  });

  it("says yes as soon as one block reads or writes the shared checkout", () => {
    for (const type of [
      "prepare_workspace",
      "implementation_agent",
      "fix_agent",
      "review_agent",
      "planning_agent",
      "leak_review",
      "run_checks",
      "run_pre_pr_checks",
      "run_scripts",
      "finalize_workspace",
    ] as const) {
      expect(
        workflowNeedsRepositoryAccess([node("trigger_ticket_ai"), node(type)]),
        type,
      ).toBe(true);
    }
  });

  it("reads a generic agent by the workspace it asked for, not by its type", () => {
    expect(
      workflowNeedsRepositoryAccess([node("generic_agent", { workspaceMode: "none" })]),
    ).toBe(false);
    expect(
      workflowNeedsRepositoryAccess([node("generic_agent", { workspaceMode: "shared" })]),
    ).toBe(true);
  });

  it("says no about an empty graph rather than guessing", () => {
    expect(workflowNeedsRepositoryAccess([])).toBe(false);
  });
});
