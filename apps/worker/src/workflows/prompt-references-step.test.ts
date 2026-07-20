import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import { resolvePromptReferencesInNodes } from "./prompt-references-step.js";
import { substituteNodePromptParams } from "./prompt-vars.js";

function node(
  type: WorkflowDefinitionNode["type"],
  params: WorkflowDefinitionNode["params"],
): WorkflowDefinitionNode {
  return { id: `node-${type}`, type, x: 0, y: 0, params };
}

describe("resolvePromptReferencesInNodes", () => {
  it("resolves only prompt-bearing params and shares latest snapshots across nodes", async () => {
    const load = vi.fn(async (promptId: number) => ({
      promptId,
      promptName: "Shared",
      requestedVersion: "latest" as const,
      resolvedVersion: 4,
      body: "Resolved {{ticket_key}}",
    }));
    const nodes = [
      node("planning_agent", { prompt: "Plan: {{prompt:1}}", model: "{{prompt:1}}" }),
      node("send_slack_message", { message: "Message: {{prompt:1}}" }),
      node("run_checks", { commands: ["echo {{prompt:1}}"] }),
    ];

    const result = await resolvePromptReferencesInNodes(nodes, load);

    expect(result.nodes[0].params.prompt).toBe("Plan: Resolved {{ticket_key}}");
    expect(result.nodes[0].params.model).toBe("{{prompt:1}}");
    expect(result.nodes[1].params.message).toBe("Message: Resolved {{ticket_key}}");
    expect(result.nodes[2]).toBe(nodes[2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.manifest).toHaveLength(1);
  });

  it("resolves every string element in prompt-bearing string arrays", async () => {
    const load = vi.fn(async () => ({
      promptId: 2,
      promptName: "Question",
      requestedVersion: 1 as const,
      resolvedVersion: 1,
      body: "included",
    }));
    const original = node("human_question", { questions: ["A {{prompt:2@1}}", "B"] });
    const result = await resolvePromptReferencesInNodes([original], load);
    expect(result.nodes[0].params.questions).toEqual(["A included", "B"]);
    expect(original.params.questions).toEqual(["A {{prompt:2@1}}", "B"]);
  });

  it("produces text that the existing global-variable pass resolves afterwards", async () => {
    const load = vi.fn(async () => ({
      promptId: 3,
      promptName: "Research",
      requestedVersion: "latest" as const,
      resolvedVersion: 5,
      body: "Work on {{ticket_key}} from {{branch_name}}",
    }));
    const original = node("planning_agent", { prompt: "Instructions: {{prompt:3}}" });
    const referenced = await resolvePromptReferencesInNodes([original], load);
    const finalNode = substituteNodePromptParams(referenced.nodes[0], {
      ticket_key: "AIW-42",
      branch_name: "feat/live-prompts",
    });
    expect(finalNode.params.prompt).toBe("Instructions: Work on AIW-42 from feat/live-prompts");
  });
});
