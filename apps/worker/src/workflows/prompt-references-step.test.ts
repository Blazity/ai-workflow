import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import {
  materializeImplicitDefaultPromptReferences,
  resolvePromptReferencesInNodes,
} from "./prompt-references-step.js";
import { substituteNodePromptParams } from "./prompt-vars.js";
import type { PromptReferenceTarget } from "./prompt-references.js";

function node(
  type: WorkflowDefinitionNode["type"],
  params: WorkflowDefinitionNode["params"],
): WorkflowDefinitionNode {
  return { id: `node-${type}`, type, x: 0, y: 0, params, inputs: {} };
}

describe("resolvePromptReferencesInNodes", () => {
  it("resolves only prompt-bearing params and shares latest snapshots across nodes", async () => {
    const load = vi.fn(async (target: PromptReferenceTarget) => ({
      promptId: target.legacyPromptId ?? 0,
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

describe("materializeImplicitDefaultPromptReferences", () => {
  const activeRows = [
    { id: 11, slug: "research-plan", name: "research-plan", archivedAt: null },
    { id: 12, slug: "implement", name: "implement", archivedAt: null },
    { id: 13, slug: "review", name: "review", archivedAt: null },
  ];

  it("materializes blank first-party defaults without mutating the definition", () => {
    const nodes = [
      node("planning_agent", {}),
      node("implementation_agent", { prompt: "   " }),
      node("review_agent", { prompt: "custom" }),
      node("generic_agent", { prompt: "generic" }),
    ];

    const result = materializeImplicitDefaultPromptReferences(nodes, activeRows);

    expect(result[0].params.prompt).toBe("{{prompt:research-plan}}");
    expect(result[1].params.prompt).toBe("{{prompt:implement}}");
    expect(result[2]).toBe(nodes[2]);
    expect(result[3]).toBe(nodes[3]);
    expect(nodes[0].params.prompt).toBeUndefined();
  });

  it("fails clearly when a required default is missing or archived", () => {
    expect(() => materializeImplicitDefaultPromptReferences(
      [node("planning_agent", {})],
      activeRows.filter((row) => row.name !== "research-plan"),
    )).toThrow('Default prompt "research-plan" is missing');

    expect(() => materializeImplicitDefaultPromptReferences(
      [node("planning_agent", {})],
      [{ id: 11, slug: "research-plan", name: "research-plan", archivedAt: new Date() }],
    )).toThrow('Default prompt "research-plan" is archived');
  });

  it("uses the active replacement when an older prompt with the same name is archived", () => {
    const result = materializeImplicitDefaultPromptReferences(
      [node("planning_agent", {})],
      [
        { id: 2, slug: "research-plan", name: "research-plan", archivedAt: new Date() },
        { id: 9, slug: "research-plan-2", name: "research-plan", archivedAt: null },
      ],
    );

    expect(result[0].params.prompt).toBe("{{prompt:research-plan-2}}");
  });
});
