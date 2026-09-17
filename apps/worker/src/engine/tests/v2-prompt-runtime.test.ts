import { describe, expect, it } from "vitest";
import type { BlockOutput, WorkflowDefinitionV2Node } from "@shared/contracts";
import type { V2BindingResolutionContext } from "@shared/workflow-graph";
import {
  resolveOpenPrBody,
  resolveOpenPrTitle,
  resolveV2PromptConfiguration,
} from "../helpers/prompt-output.js";

// A v2 run never substitutes a legacy {{name}} variable into a block's
// prompt-bearing fields. The executeV2Block closure in engine/agent-workflow.ts
// calls resolveV2PromptConfiguration, which inserts {{data:...}} values once,
// keeps agent prompt sources for compileEffectivePrompt, and fails a non-agent
// block on a placeholder its author left. Braces inside the data are content.

const node = (
  type: WorkflowDefinitionV2Node["type"],
  configuration: WorkflowDefinitionV2Node["configuration"],
): WorkflowDefinitionV2Node => ({
  id: "node",
  type,
  x: 0,
  y: 0,
  configuration,
  inputs: {},
  additionalInputs: [],
});

const context: V2BindingResolutionContext = {
  entryOutput: {
    status: "fired",
    ticketKey: "AIW-124",
    ticket: {
      title: "Rename {{ticket_key}} helper",
      description: "Pass ${{ secrets.GITHUB_TOKEN }} to the release job.",
    },
  },
  getStepOutput: (nodeId): BlockOutput | undefined => {
    if (nodeId === "plan") return { status: "ok", plan: "the plan" };
    if (nodeId === "review") {
      return {
        status: "completed",
        finding: "ci.yml pins ${{ matrix.os }} to one runner",
        location: { file: { path: "ci.yml", line: 12 } },
      };
    }
    return undefined;
  },
};

const resolve = (
  type: WorkflowDefinitionV2Node["type"],
  configuration: WorkflowDefinitionV2Node["configuration"],
) => resolveV2PromptConfiguration(node(type, configuration), context);

// One authored field per case, and the refusal the block fails with.
const LEGACY_VARIABLE_CASES: Array<[
  WorkflowDefinitionV2Node["type"],
  WorkflowDefinitionV2Node["configuration"],
  string,
]> = [
  ["open_pr", { title: "{{ticket_key}}" }, "open_pr title contains an unresolved placeholder."],
  ["open_pr", { body: "{{change_summary}}" }, "open_pr body contains an unresolved placeholder."],
  ["post_ticket_comment", { body: "{{ticket_title}}" }, "post_ticket_comment body contains an unresolved placeholder."],
  ["post_pr_comment", { body: "{{pr_url}}" }, "post_pr_comment body contains an unresolved placeholder."],
  ["complete_pr_check", { details: "{{run_id}}" }, "complete_pr_check details contains an unresolved placeholder."],
  ["send_slack_message", { message: "{{pr_url}}" }, "send_slack_message message contains an unresolved placeholder."],
  ["human_question", { questions: ["Fine?", "Review {{plan_markdown}}?"] }, "human_question questions contains an unresolved placeholder."],
  ["call_llm", { prompt: "Use {{plan}}" }, "call_llm prompt contains an unresolved placeholder."],
  ["call_llm", { prompt: "Summarize.", system: "You work on {{unknown}}." }, "call_llm system contains an unresolved placeholder."],
  ["terminate", { terminalStatus: "done", postComment: "Closed {{ticket_key}}." }, "terminate postComment contains an unresolved placeholder."],
];

describe("v2 prompt runtime boundaries", () => {
  it("resolves data tokens in Call LLM prompt and system, keeping braces the data carries", () => {
    expect(
      resolve("call_llm", {
        prompt: "Prompt {{data:steps.plan.output.plan}}: {{data:steps.entry.output.ticket.description}}",
        system: "System {{data:steps.entry.output.ticketKey}}",
      }),
    ).toEqual({
      ok: true,
      configuration: {
        prompt: "Prompt the plan: Pass ${{ secrets.GITHUB_TOKEN }} to the release job.",
        system: "System AIW-124",
      },
    });
  });

  it.each(LEGACY_VARIABLE_CASES)(
    "fails %s instead of sending a legacy variable as literal braces (%j)",
    (type, configuration, refusal) => {
      expect(resolve(type, configuration)).toEqual({ ok: false, issue: refusal });
    },
  );

  it("fails with the binding error, not a placeholder, when a data path has a typo", () => {
    expect(() =>
      resolve("post_ticket_comment", {
        body: "{{data:steps.entry.output.ticket.titel}}",
      }),
    ).toThrow('binding "steps.entry.output.ticket.titel" could not be resolved');
  });

  it("fails a malformed data token with its binding error, not a placeholder refusal", () => {
    expect(() =>
      resolve("post_ticket_comment", { body: "Hi {{data:not a path}}" }),
    ).toThrow('binding "not a path" could not be resolved');
  });

  it.each([
    ["implementation_agent", "prompt"],
    ["fix_agent", "instructions"],
  ] as const)(
    "leaves %s %s tokens for the effective prompt compiler instead of failing the block",
    (type, field) => {
      // compileEffectivePrompt resolves {{slot:...}} and {{data:...}} later
      // and rejects a leftover {{name}} itself (engine/helpers/
      // effective-prompt.test.ts, "rejects the legacy or unknown placeholder").
      const source = "Implement {{slot:plan}} for {{data:steps.entry.output.ticketKey}}";

      expect(resolve(type, { [field]: source })).toEqual({
        ok: true,
        configuration: { [field]: source },
      });
    },
  );

  describe("braces that come from run data reach people as written", () => {
    it("posts a review finding quoting ${{ }} in a PR comment and a check's details", () => {
      expect(
        resolve("post_pr_comment", {
          body: "Finding: {{data:steps.review.output.finding}}",
        }),
      ).toEqual({
        ok: true,
        configuration: { body: "Finding: ci.yml pins ${{ matrix.os }} to one runner" },
      });
      expect(
        resolve("complete_pr_check", {
          conclusion: "failure",
          details: "{{data:steps.review.output.finding}}",
        }),
      ).toEqual({
        ok: true,
        configuration: {
          conclusion: "failure",
          details: "ci.yml pins ${{ matrix.os }} to one runner",
        },
      });
    });

    it("posts an object output whose JSON ends in }}", () => {
      expect(
        resolve("post_pr_comment", {
          body: "Where: {{data:steps.review.output.location}}",
        }),
      ).toEqual({
        ok: true,
        configuration: { body: 'Where: {"file":{"path":"ci.yml","line":12}}' },
      });
    });

    it("comments a ticket description carrying ${{ }} on the ticket", () => {
      expect(
        resolve("post_ticket_comment", {
          body: "Picked up: {{data:steps.entry.output.ticket.description}}",
        }),
      ).toEqual({
        ok: true,
        configuration: {
          body: "Picked up: Pass ${{ secrets.GITHUB_TOKEN }} to the release job.",
        },
      });
    });

    it("keeps a ticket title with {{ticket_key}} literal in authored and default PR titles and bodies", () => {
      const resolution = resolve("open_pr", {
        title: "{{data:steps.entry.output.ticket.title}}",
        body: "Implements {{data:steps.entry.output.ticket.title}}.",
      });
      expect(resolution).toEqual({
        ok: true,
        configuration: {
          title: "Rename {{ticket_key}} helper",
          body: "Implements Rename {{ticket_key}} helper.",
        },
      });
      if (!resolution.ok) return;

      const vars = { ticket_key: "AIW-124", ticket_title: "Rename {{ticket_key}} helper" };
      expect(resolveOpenPrTitle(resolution.configuration, {}, vars)).toBe(
        "Rename {{ticket_key}} helper",
      );
      expect(resolveOpenPrBody(resolution.configuration, {}, vars)).toBe(
        "Implements Rename {{ticket_key}} helper.",
      );
      // With no authored title, the default template takes {{name}} variables,
      // one pass, so the {{ticket_key}} inside the title stays as written.
      expect(resolveOpenPrTitle({}, {}, vars)).toBe(
        "[AIW-124] Rename {{ticket_key}} helper",
      );
    });
  });
});
