import { describe, expect, it } from "vitest";
import type {
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { v2NonAgentPromptPlaceholderIssue } from "./agent.js";
import { substituteNodePromptParams } from "./prompt-vars.js";

const node = (
  type: WorkflowDefinitionNode["type"],
  params: WorkflowDefinitionNode["params"],
): WorkflowDefinitionNode => ({
  id: "node",
  type,
  x: 0,
  y: 0,
  params,
  inputs: {},
});
const V2_NON_AGENT_PROMPT_CASES: Array<[
  WorkflowDefinitionNode["type"],
  Record<string, WorkflowParamValue>,
]> = [
  ["open_pr", { title: "{{ticket_key}}", body: "{{change_summary}}" }],
  ["post_ticket_comment", { body: "{{ticket_title}}" }],
  ["send_slack_message", { message: "{{pr_url}}" }],
  ["human_question", { questions: ["Review {{plan_markdown}}?"] }],
];

describe("v2 prompt runtime boundaries", () => {
  it("substitutes known variables in agent prompt fields", () => {
    const authored = node("implementation_agent", {
      prompt: "Implement {{plan_markdown}}",
    });

    expect(
      substituteNodePromptParams(
        authored,
        { plan_markdown: "the plan" },
      ).params.prompt,
    ).toBe("Implement the plan");
  });

  it("substitutes known variables in Call LLM prompt or system fields", () => {
    const authored = node("call_llm", {
      prompt: "Prompt {{plan_markdown}}",
      system: "System {{ticket_key}}",
    });
    const resolved = substituteNodePromptParams(
      authored,
      { plan_markdown: "the plan", ticket_key: "AIW-124" },
    );

    expect(resolved.params).toMatchObject({
      prompt: "Prompt the plan",
      system: "System AIW-124",
    });
  });

  it.each(V2_NON_AGENT_PROMPT_CASES)(
    "substitutes known variables in %s fields",
    (type, params) => {
      const authored = node(type, params);
      const resolved = substituteNodePromptParams(
        authored,
        {
          ticket_key: "AIW-124",
          ticket_title: "Title",
          change_summary: "Summary",
          pr_url: "https://example.test/pr/1",
          plan_markdown: "the plan",
        },
      );

      expect(resolved).not.toBe(authored);
      expect(resolved.params).not.toEqual(params);
    },
  );

  it.each(["{{plan}}", "{{unknown}}"])(
    "fails Call LLM immediately for residual placeholder %s",
    (placeholder) => {
      expect(
        v2NonAgentPromptPlaceholderIssue("call_llm", {
          prompt: `Use ${placeholder}`,
        }),
      ).toContain("unresolved placeholder");
    },
  );

  it("checks every non-agent v2 prompt-bearing field at runtime", () => {
    expect(
      v2NonAgentPromptPlaceholderIssue("call_llm", {
        prompt: "Use AIW-124",
        system: "Return JSON.",
      }),
    ).toBeNull();
    expect(
      v2NonAgentPromptPlaceholderIssue("human_question", {
        questions: ["Use {{unknown}}"],
      }),
    ).toContain("unresolved placeholder");
  });
});
