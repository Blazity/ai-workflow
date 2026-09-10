import { describe, expect, it } from "vitest";
import { BLOCK_CATALOG, BLOCK_TYPE_SPECS } from "@shared/contracts";
import type { WorkflowBlockType, WorkflowDefinitionNode } from "@shared/contracts";
import {
  BLOCK_EXECUTORS,
  INLINE_EXECUTED_BLOCK_TYPES,
} from "../blocks/executors.generated.js";
import { detachScratchSandboxesForClarification, planningClarificationResult } from "../agent-workflow.js";
import { blockTypesMissingExecutor, implementationChangeSummary, resolveOpenPrBody, resolveOpenPrTitle, resolveSlackMessageInput, resolveTicketStatusInput } from "../helpers/prompt-output.js";

// Exhaustiveness guard for the v1 block dispatch in agent.ts. V2-only action
// types are executed by the v2 scheduler once that runtime is enabled.
describe("block executor exhaustiveness", () => {
  it("keeps map, inline, and graph execution sets exact", () => {
    const mapTypes = [
      "arthur_injection_check",
      "call_llm",
      "complete_pr_check",
      "create_pr_check",
      "fetch_pr_context",
      "finalize_workspace",
      "fix_agent",
      "generic_agent",
      "human_question",
      "investigate",
      "leak_review",
      "post_pr_comment",
      "post_pr_review",
      "post_ticket_comment",
      "run_checks",
      "run_scripts",
      "send_plan_approval",
    ];
    const inlineTypes = [
      "implementation_agent",
      "open_pr",
      "planning_agent",
      "prepare_workspace",
      "review_agent",
      "run_pre_pr_checks",
      "send_slack_message",
      "update_ticket_status",
    ];
    const graphTypes = [
      "branch",
      "loop",
      "terminate",
      "transform",
      "trigger_plan_approved",
      "trigger_pr_checks_failed",
      "trigger_pr_created",
      "trigger_pr_merged",
      "trigger_pr_ready",
      "trigger_pr_review",
      "trigger_pr_updated",
      "trigger_schedule",
      "trigger_ticket_ai",
      "trigger_webhook",
    ];
    const generatedGraphTypes = Object.entries(BLOCK_CATALOG)
      .filter(([, entry]) => entry.execution === "graph")
      .map(([type]) => type);

    expect(new Set(Object.keys(BLOCK_EXECUTORS))).toEqual(new Set(mapTypes));
    expect(new Set(INLINE_EXECUTED_BLOCK_TYPES)).toEqual(new Set(inlineTypes));
    expect(new Set(generatedGraphTypes)).toEqual(new Set(graphTypes));
  });

  it("dispatches run_scripts through the generated executor map", () => {
    expect(BLOCK_EXECUTORS.run_scripts).toBeTypeOf("function");
  });

  it("wires an executor for every v1 action block type", () => {
    const actionTypes = (Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[]).filter(
      (type) => type !== "transform" && BLOCK_TYPE_SPECS[type].category === "action",
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

  it("detaches every cached scratch sandbox before clarification suspension", () => {
    const ctx = {
      agentSandboxIds: {
        first: "scratch-1",
        duplicate: "scratch-1",
        second: "scratch-2",
      },
      sandboxIds: new Set(["code-1", "scratch-1", "scratch-2"]),
    };

    expect(detachScratchSandboxesForClarification(ctx)).toEqual([
      "scratch-1",
      "scratch-2",
    ]);
    expect(ctx.agentSandboxIds).toEqual({});
    expect([...ctx.sandboxIds]).toEqual(["code-1"]);
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
