import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import type { WorkflowBlockType, WorkflowDefinitionNode } from "@shared/contracts";
import {
  blockTypesMissingExecutor,
  implementationChangeSummary,
  planningClarificationResult,
  resolveOpenPrBody,
  resolveOpenPrTitle,
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

describe("open_pr title and body resolution", () => {
  const vars = {
    ticket_key: "AIW-117",
    ticket_title: "Updates to the generated PR",
    ticket_url: "https://jira.example.com/browse/AIW-117",
    change_summary: "Added templated PR title and body.",
  };

  it("prefers a bound input over the authored template and the default", () => {
    expect(resolveOpenPrTitle({ title: "authored" }, { title: "bound" }, vars)).toBe("bound");
    expect(resolveOpenPrBody({ body: "authored" }, { body: "bound body" }, vars)).toBe(
      "bound body",
    );
  });

  it("uses the authored (already-substituted) param when nothing is bound", () => {
    expect(resolveOpenPrTitle({ title: "[AIW-117] X" }, {}, vars)).toBe("[AIW-117] X");
    expect(resolveOpenPrBody({ body: "changed things" }, {}, vars)).toBe("changed things");
  });

  it("falls back to the default template resolved against the variables", () => {
    expect(resolveOpenPrTitle({}, {}, vars)).toBe("[AIW-117] Updates to the generated PR");
    expect(resolveOpenPrBody({}, {}, vars)).toBe(
      "**Ticket:** [AIW-117](https://jira.example.com/browse/AIW-117)\n\n## What changed\nAdded templated PR title and body.",
    );
  });

  it("treats a blank authored value as empty and falls back to the default", () => {
    expect(resolveOpenPrTitle({ title: "   " }, { title: "" }, vars)).toBe(
      "[AIW-117] Updates to the generated PR",
    );
  });
});

describe("implementationChangeSummary", () => {
  const nodes: WorkflowDefinitionNode[] = [
    { id: "impl", type: "implementation_agent", x: 0, y: 0, params: {}, inputs: {} },
  ];

  it("reads the implementation block summary from the durable steps", () => {
    const steps = {
      impl: { output: { status: "implemented", summary: "Did the work." } },
    };
    expect(implementationChangeSummary(steps, nodes)).toBe("Did the work.");
  });

  it("returns empty when no implementation output carries a summary yet", () => {
    expect(implementationChangeSummary({}, nodes)).toBe("");
    expect(
      implementationChangeSummary({ impl: { output: { status: "implemented" } } }, nodes),
    ).toBe("");
  });
});
