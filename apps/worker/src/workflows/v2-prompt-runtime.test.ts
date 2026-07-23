import { describe, expect, it } from "vitest";
import type {
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  substituteNodePromptParamsForSchema,
  v2NonAgentPromptPlaceholderIssue,
} from "./agent.js";

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
  it("does not apply legacy flat variables to v2 agent prompt fields", () => {
    const authored = node("implementation_agent", {
      prompt: "Implement {{plan_markdown}}",
    });

    expect(
      substituteNodePromptParamsForSchema(
        authored,
        { plan_markdown: "the plan" },
        2,
      ).params.prompt,
    ).toBe("Implement {{plan_markdown}}");
    expect(
      substituteNodePromptParamsForSchema(
        authored,
        { plan_markdown: "the plan" },
        1,
      ).params.prompt,
    ).toBe("Implement the plan");
  });

  it("does not apply legacy flat variables to v2 Call LLM prompt or system fields", () => {
    const authored = node("call_llm", {
      prompt: "Prompt {{plan_markdown}}",
      system: "System {{ticket_key}}",
    });
    const resolved = substituteNodePromptParamsForSchema(
      authored,
      { plan_markdown: "the plan", ticket_key: "AIW-124" },
      2,
    );

    expect(resolved.params).toMatchObject({
      prompt: "Prompt {{plan_markdown}}",
      system: "System {{ticket_key}}",
    });
  });

  it.each(V2_NON_AGENT_PROMPT_CASES)(
    "does not apply legacy flat variables to v2 %s fields",
    (type, params) => {
      const authored = node(type, params);
      const resolved = substituteNodePromptParamsForSchema(
        authored,
        {
          ticket_key: "AIW-124",
          ticket_title: "Title",
          change_summary: "Summary",
          pr_url: "https://example.test/pr/1",
          plan_markdown: "the plan",
        },
        2,
      );

      expect(resolved).toBe(authored);
      expect(resolved.params).toEqual(params);
    },
  );

  it("keeps legacy flat substitution for v1 non-agent fields", () => {
    expect(
      substituteNodePromptParamsForSchema(
        node("send_slack_message", { message: "Ready: {{pr_url}}" }),
        { pr_url: "https://example.test/pr/1" },
        1,
      ).params.message,
    ).toBe("Ready: https://example.test/pr/1");
  });

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
