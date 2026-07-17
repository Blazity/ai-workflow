import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import type { WorkflowBlockType } from "@shared/contracts";
import {
  blockTypesMissingExecutor,
  planningClarificationResult,
  resolveSlackMessageInput,
  resolveTicketStatusInput,
} from "./agent.js";

// Exhaustiveness guard for the block dispatch in agent.ts. If a new action-category
// WorkflowBlockType is added to the contract without wiring an executor (registry
// or inline switch case), this test goes red instead of the run silently
// succeeding as a no-op (executeBlock's default throws at runtime).
describe("block executor exhaustiveness", () => {
  it("wires an executor for every action block type", () => {
    const actionTypes = (Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[]).filter(
      (type) => BLOCK_TYPE_SPECS[type].category === "action",
    );
    // Sanity: the assertion below is not vacuously true.
    expect(actionTypes.length).toBeGreaterThan(0);
    expect(blockTypesMissingExecutor()).toEqual([]);
  });

  it("keeps planning suggestions in both the persisted output and clarification result", () => {
    expect(
      planningClarificationResult(
        ["Which database?"],
        ["Postgres", "MySQL"],
      ),
    ).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        questions: ["Which database?"],
        suggestedAnswers: ["Postgres", "MySQL"],
      },
      questions: ["Which database?"],
      suggestedAnswers: ["Postgres", "MySQL"],
    });
  });

  it("prefers resolved Slack messages and ticket targets over static params", () => {
    expect(resolveSlackMessageInput({ message: " static " }, { message: " bound " })).toBe(
      "bound",
    );
    expect(resolveTicketStatusInput({ target: "ai_review" }, { target: "backlog" })).toBe(
      "backlog",
    );
    expect(resolveTicketStatusInput({ target: "10042" }, {})).toBe("10042");
  });
});
