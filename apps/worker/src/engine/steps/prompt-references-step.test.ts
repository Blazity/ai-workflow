import { describe, expect, it, vi } from "vitest";
import type {
  PromptSlotDefinition,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { resolvePromptReferencesInNodes } from "./prompt-references-step.js";
import type { PromptReferenceTarget } from "@shared/prompts";
import { compileEffectivePrompt } from "../helpers/effective-prompt.js";
import { resolveV2PromptConfiguration } from "../helpers/prompt-output.js";

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

  describe("what a run does with an expanded reference", () => {
    // A run expands references once at run start (resolvePromptReferencesForRun,
    // copied back into the v2 configuration in engine/agent-workflow.ts). The
    // expanded body is authored text from then on: a non-agent block resolves
    // its {{data:...}} tokens with resolveV2PromptConfiguration, an agent block
    // compiles its data and slot tokens with compileEffectivePrompt, and both
    // refuse a placeholder the body left.
    const bindingContext = {
      entryOutput: {
        status: "fired",
        ticketKey: "AIW-42",
        ticket: { title: "Add rate limiting" },
      },
      runValues: { branchName: "feat/live-prompts" },
      getStepOutput: () => undefined,
    };

    const expand = async (
      type: WorkflowDefinitionNode["type"],
      field: string,
      body: string,
      slots: PromptSlotDefinition[] = [],
    ) => {
      const load = vi.fn(async () => ({
        promptId: 3,
        promptName: "impl",
        requestedVersion: 2 as const,
        resolvedVersion: 2,
        body,
        slots,
      }));
      const original = node(type, { [field]: "{{prompt:impl@2}}" });
      const referenced = await resolvePromptReferencesInNodes([original], load, {
        requirePinned: true,
      });
      return {
        text: referenced.nodes[0].params[field] as string,
        slots: referenced.slotsByNode[original.id] ?? [],
      };
    };

    const v2Node = (
      type: WorkflowDefinitionNode["type"],
      configuration: WorkflowDefinitionV2Node["configuration"],
    ): WorkflowDefinitionV2Node => ({
      id: `node-${type}`,
      type,
      x: 0,
      y: 0,
      configuration,
      inputs: {},
      additionalInputs: [],
    });

    it("resolves data tokens a referenced body carries when a non-agent block runs", async () => {
      const { text } = await expand(
        "send_slack_message",
        "message",
        "Shipped {{data:steps.entry.output.ticketKey}} on {{data:run.branchName}}",
      );

      expect(
        resolveV2PromptConfiguration(
          v2Node("send_slack_message", { message: text }),
          bindingContext,
        ),
      ).toEqual({
        ok: true,
        configuration: { message: "Shipped AIW-42 on feat/live-prompts" },
      });
    });

    it("refuses a legacy variable a referenced body carries on a non-agent block", async () => {
      const { text } = await expand("send_slack_message", "message", "Shipped {{ticket_key}}");

      expect(
        resolveV2PromptConfiguration(
          v2Node("send_slack_message", { message: text }),
          bindingContext,
        ),
      ).toEqual({
        ok: false,
        issue: "send_slack_message message contains an unresolved placeholder.",
      });
    });

    it("compiles a referenced agent prompt with its slot and data tokens filled", async () => {
      const { text, slots } = await expand(
        "implementation_agent",
        "prompt",
        "Scope: {{slot:scope}}\nTicket: {{data:steps.entry.output.ticket.title}}",
        [{
          name: "scope",
          description: "What to change",
          schema: { type: "string" },
          required: true,
        }],
      );

      const compilation = await compileEffectivePrompt({
        nodeId: "node-implementation_agent",
        blockPrompt: text,
        runtimeData: "",
        slots,
        slotBindings: { scope: { kind: "literal", value: "the billing module" } },
        bindingContext,
      });

      expect(compilation.issues).toEqual([]);
      expect(compilation.sections.find((section) => section.kind === "block")
        ?.content).toBe("Scope: the billing module\nTicket: Add rate limiting");
    });

    it("refuses a legacy variable a referenced agent prompt carries", async () => {
      const { text } = await expand("implementation_agent", "prompt", "Implement {{ticket_key}}");

      const compilation = await compileEffectivePrompt({
        nodeId: "node-implementation_agent",
        blockPrompt: text,
        runtimeData: "",
        bindingContext,
      });

      expect(compilation.issues).toEqual([
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          message: "The prompt contains an unresolved placeholder.",
        }),
      ]);
    });
  });

  it("keeps per-node manifests and recursive slot declarations separate", async () => {
    const load = vi.fn(async (target: PromptReferenceTarget) => ({
      promptId: target.legacyPromptId ?? 4,
      promptName: "Implementation",
      requestedVersion: 2 as const,
      resolvedVersion: 2,
      body: "Implement {{slot:plan}}",
      slots: [{
        name: "plan",
        description: "Approved plan",
        schema: { type: "string" as const },
        required: true,
      }],
    }));
    const original = node("implementation_agent", {
      prompt: "{{prompt:implementation@2}}",
    });

    const result = await resolvePromptReferencesInNodes(
      [original],
      load,
      { requirePinned: true },
    );

    expect(result.manifestByNode[original.id]).toEqual([
      expect.objectContaining({ resolvedVersion: 2 }),
    ]);
    expect(result.slotsByNode[original.id]).toEqual([
      expect.objectContaining({ name: "plan", required: true }),
    ]);
    expect(result.nodes[0].params.prompt).toBe("Implement {{slot:plan}}");
  });

  it("rejects unpinned prompt references in v2 mode", async () => {
    const load = vi.fn(async () => ({
      promptId: 1,
      promptName: "Shared",
      requestedVersion: "latest" as const,
      resolvedVersion: 1,
      body: "BODY",
    }));

    await expect(
      resolvePromptReferencesInNodes(
        [node("generic_agent", { prompt: "{{prompt:shared}}" })],
        load,
        { requirePinned: true },
      ),
    ).rejects.toThrow("must pin an exact version");
  });

});
