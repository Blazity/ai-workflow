import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV2Node } from "@shared/contracts";

import {
  catalogRefusalExecutionOptions,
  repositoryNotEnabledMessage,
  NO_ENABLED_REPOSITORIES_MESSAGE,
  workflowNeedsRepositoryAccess,
} from "./repository-access.js";

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

/**
 * The refusal a person reads when a repository is withheld, on the several
 * blocks that catch it after a `throw`.
 *
 * Both consequences come from the one answer. The category was already decided
 * from it; the lead was not, so the sentence reached people as a 160-character
 * both-ends clamp with the repository in the elided middle (production run
 * wrun_01M2SDKXF5QYNCXGCMRJJQ2HFF). These are the cases each caller hits.
 */
describe("catalogRefusalExecutionOptions", () => {
  const REFUSAL = repositoryNotEnabledMessage("open a pull request on", {
    provider: "github",
    repoPath: "blazity/ai-workflow",
  });

  it("leads with the refusal, and calls it configuration rather than a fault", () => {
    // Over the snippet cap, which is what made the clamp fire: a shorter
    // sentence would have survived the old path too and proves nothing.
    expect(REFUSAL.length).toBeGreaterThan(160);
    expect(catalogRefusalExecutionOptions(REFUSAL, "provider")).toEqual({
      category: "configuration",
      message: REFUSAL,
    });
  });

  it("recognises the other refusal, which names no repository because there is none", () => {
    expect(catalogRefusalExecutionOptions(NO_ENABLED_REPOSITORIES_MESSAGE, "sandbox")).toEqual({
      category: "configuration",
      message: NO_ENABLED_REPOSITORIES_MESSAGE,
    });
  });

  it("leads with a WRAPPED refusal too, which is the accepted cost of a text test", () => {
    // post_pr_comment catches its own throw inside the step and prefixes the
    // target before rethrowing the batch, so what arrives here is the refusal
    // with prose in front of it. A containment test cannot tell that from a bare
    // refusal, and this is the direction to err in: the person reads a whole
    // sentence with a prefix instead of a clipped one.
    const wrapped = `github:blazity/ai-workflow#42: ${REFUSAL}`;
    expect(catalogRefusalExecutionOptions(wrapped, "provider")).toEqual({
      category: "configuration",
      message: wrapped,
    });
  });

  it("leaves an ordinary failure to the caller's category and to the snippet path", () => {
    // The guard against the opposite mistake: promoting every caught detail to a
    // lead would hand raw provider output the whole message, which is the case
    // the parenthesised both-ends snippet exists for.
    expect(
      catalogRefusalExecutionOptions("fatal: unable to access: error 403", "provider"),
    ).toEqual({ category: "provider" });
    expect(catalogRefusalExecutionOptions("the sandbox died", "sandbox")).toEqual({
      category: "sandbox",
    });
  });
});
