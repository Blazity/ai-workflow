import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import type { WorkflowBlockType } from "@shared/contracts";
import { blockTypesMissingExecutor } from "./agent.js";

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
});
