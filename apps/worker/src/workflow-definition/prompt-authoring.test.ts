import { describe, expect, it, vi } from "vitest";
import type {
  PromptSlotDefinition,
  WorkflowAvailableValue,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  resolveNodePromptAuthoring,
  validateWorkflowPromptAuthoringIssuesWithLoader,
} from "./prompt-authoring.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "codex", model: "gpt-5-codex" },
  vcsProviders: ["github"],
  vcsBotIdentities: ["github"],
  slackConfigured: true,
  arthurConfigured: true,
};

const slot = (
  schema: PromptSlotDefinition["schema"] = { type: "string" },
): PromptSlotDefinition => ({
  name: "plan",
  description: "Approved plan",
  schema,
  required: true,
});

const node = (
  configuration: WorkflowDefinitionV2Node["configuration"],
): WorkflowDefinitionV2Node => ({
  id: "implementation",
  type: "generic_agent",
  x: 200,
  y: 0,
  configuration,
  inputs: {},
  additionalInputs: [],
});

const available = (
  reference: WorkflowAvailableValue["reference"],
  schema: WorkflowAvailableValue["schema"],
): WorkflowAvailableValue => ({
  reference,
  label: reference,
  description: null,
  schema,
  source: {
    kind: reference.startsWith("steps.entry.") ? "entry" : "step",
    nodeId: reference.startsWith("steps.entry.") ? null : "planning",
    blockType: reference.startsWith("steps.entry.")
      ? "trigger_ticket_ai"
      : "planning_agent",
  },
  guarantee: {
    kind: "unconditional_activation",
    triggerNodeIds: ["trigger"],
    viaEdgeIds: ["edge-1"],
  },
  compatibleInputNames: [],
});

describe("v2 prompt authoring validation", () => {
  it("validates pinned recursive slots against the available-value catalog", async () => {
    const load = vi.fn(async () => ({
      promptId: 1,
      promptName: "Implementation",
      requestedVersion: 2 as const,
      resolvedVersion: 2,
      body: "Implement {{slot:plan}} for {{data:steps.entry.output.ticketKey}}",
      slots: [slot()],
    }));

    const result = await resolveNodePromptAuthoring({
      node: node({
        prompt: "{{prompt:implementation@2}}",
        promptSlotBindings: {
          plan: {
            kind: "reference",
            reference: "steps.planning.output.plan",
          },
        },
      }),
      nodeIndex: 1,
      availableValues: [
        available("steps.planning.output.plan", { type: "string" }),
        available("steps.entry.output.ticketKey", { type: "string" }),
      ],
      loadPromptReference: load,
    });

    expect(result.issues).toEqual([]);
    expect(result.compilation.sections.find((entry) => entry.kind === "block")
      ?.content).toBe("Implement example for example");
    expect(result.compilation.unresolvedSources).toEqual([
      expect.objectContaining({
        kind: "data",
        reference: "steps.entry.output.ticketKey",
      }),
      expect.objectContaining({
        kind: "slot",
        reference: "steps.planning.output.plan",
      }),
      expect.objectContaining({ kind: "profile" }),
    ]);
  });

  it("reports unavailable data and slot references with exact node paths", async () => {
    const result = await resolveNodePromptAuthoring({
      node: node({
        prompt: "{{prompt:implementation@2}}",
        promptSlotBindings: {
          plan: {
            kind: "reference",
            reference: "steps.planning.output.plan",
          },
        },
      }),
      nodeIndex: 3,
      availableValues: [],
      loadPromptReference: async () => ({
        promptId: 1,
        promptName: "Implementation",
        requestedVersion: 2,
        resolvedVersion: 2,
        body:
          "{{slot:plan}} {{data:steps.entry.output.ticketKey}}",
        slots: [slot()],
      }),
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_slot_unavailable",
          path: "/nodes/3/configuration/promptSlotBindings/plan",
        }),
        expect.objectContaining({
          code: "prompt_data_unavailable",
          path: "/nodes/3/configuration/prompt",
        }),
      ]),
    );
  });

  it("rejects a catalog value whose schema is not assignable to the slot", async () => {
    const result = await resolveNodePromptAuthoring({
      node: node({
        prompt: "{{prompt:implementation@2}}",
        promptSlotBindings: {
          plan: {
            kind: "reference",
            reference: "steps.planning.output.plan",
          },
        },
      }),
      nodeIndex: 1,
      availableValues: [
        available("steps.planning.output.plan", { type: "number" }),
      ],
      loadPromptReference: async () => ({
        promptId: 1,
        promptName: "Implementation",
        requestedVersion: 2,
        resolvedVersion: 2,
        body: "{{slot:plan}}",
        slots: [slot({ type: "string" })],
      }),
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_slot_type_mismatch",
          path: "/nodes/1/configuration/promptSlotBindings/plan",
        }),
      ]),
    );
  });

  it("reports missing required slot bindings across a complete v2 graph", async () => {
    const agent = node({ prompt: "{{prompt:implementation@1}}" });
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        agent,
      ],
      edges: [{ id: "edge-1", from: "trigger", to: agent.id }],
    };

    const issues = await validateWorkflowPromptAuthoringIssuesWithLoader(
      definition,
      registryContext,
      async () => ({
        promptId: 1,
        promptName: "Implementation",
        requestedVersion: 1,
        resolvedVersion: 1,
        body: "{{slot:plan}}",
        slots: [slot()],
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_slot_missing",
          nodeId: "implementation",
        }),
      ]),
    );
  });

  it("rejects unpinned v2 prompt references before deployment", async () => {
    const result = await resolveNodePromptAuthoring({
      node: node({ prompt: "{{prompt:implementation}}" }),
      nodeIndex: 1,
      availableValues: [],
      loadPromptReference: vi.fn(),
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_reference_invalid",
          path: "/nodes/1/configuration/prompt",
        }),
      ]),
    );
  });

  it("keeps the code-owned prompt only for a profile-less PR2/PR3 compatibility node", async () => {
    const compatibilityNode: WorkflowDefinitionV2Node = {
      id: "planning",
      type: "planning_agent",
      x: 0,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    };
    const compatible = await resolveNodePromptAuthoring({
      node: compatibilityNode,
      nodeIndex: 1,
      availableValues: [],
      loadPromptReference: vi.fn(),
    });
    expect(compatible.issues).toEqual([]);
    expect(
      compatible.compilation.sections.find((section) => section.kind === "block")
        ?.content,
    ).toContain("You are an AI research agent.");

    const pinned = await resolveNodePromptAuthoring({
      node: {
        ...compatibilityNode,
        configuration: {
          harnessProfile: { profileId: "builtin-codex", version: 1 },
        },
      },
      nodeIndex: 1,
      availableValues: [],
      loadPromptReference: vi.fn(),
    });
    expect(pinned.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_empty",
          path: "/nodes/1/configuration/prompt",
        }),
      ]),
    );
  });

  it.each(["{{plan}}", "{{unknown}}"])(
    "rejects residual v2 agent placeholder %s before deployment",
    async (placeholder) => {
      const result = await resolveNodePromptAuthoring({
        node: node({ prompt: `Implement ${placeholder}` }),
        nodeIndex: 1,
        availableValues: [],
        loadPromptReference: vi.fn(),
      });

      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "prompt_placeholder_unresolved",
            path: "/nodes/1/configuration/prompt",
          }),
        ]),
      );
    },
  );

  it("validates Call LLM references without enabling Agent-only prompt slots", async () => {
    const callLlm: WorkflowDefinitionV2Node = {
      id: "llm",
      type: "call_llm",
      x: 200,
      y: 0,
      configuration: {
        prompt: "{{prompt:shared@1}}",
        system: "{{unknown}}",
      },
      inputs: {},
      additionalInputs: [],
    };
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        callLlm,
      ],
      edges: [{ id: "edge-1", from: "trigger", to: "llm" }],
    };
    const issues = await validateWorkflowPromptAuthoringIssuesWithLoader(
      definition,
      registryContext,
      async () => ({
        promptId: 1,
        promptName: "Shared",
        requestedVersion: 1,
        resolvedVersion: 1,
        body: "Use {{slot:plan}}",
        slots: [slot()],
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "call_llm_prompt_slots_unsupported",
          nodeId: "llm",
          path: "/nodes/1/configuration/prompt",
        }),
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          nodeId: "llm",
          path: "/nodes/1/configuration/system",
        }),
      ]),
    );
  });

  it("rejects legacy or unknown placeholders in every non-agent v2 prompt field", async () => {
    const blocks: WorkflowDefinitionV2["nodes"] = [
      {
        id: "open-pr",
        type: "open_pr",
        x: 200,
        y: 0,
        configuration: {
          title: "{{ticket_key}}",
          body: "{{unknown}}",
        },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "comment",
        type: "post_ticket_comment",
        x: 400,
        y: 0,
        configuration: { body: "{{ticket_title}}" },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "slack",
        type: "send_slack_message",
        x: 600,
        y: 0,
        configuration: { message: "{{pr_url}}" },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "question",
        type: "human_question",
        x: 800,
        y: 0,
        configuration: { questions: ["Use {{plan}}?"] },
        inputs: {},
        additionalInputs: [],
      },
    ];
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        {
          id: "trigger",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          configuration: {},
          inputs: {},
          additionalInputs: [],
        },
        ...blocks,
      ],
      edges: blocks.map((block, index) => ({
        id: `edge-${index}`,
        from: "trigger",
        to: block.id,
      })),
    };

    const issues = await validateWorkflowPromptAuthoringIssuesWithLoader(
      definition,
      registryContext,
      vi.fn(),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          path: "/nodes/1/configuration/title",
        }),
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          path: "/nodes/1/configuration/body",
        }),
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          path: "/nodes/2/configuration/body",
        }),
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          path: "/nodes/3/configuration/message",
        }),
        expect.objectContaining({
          code: "prompt_placeholder_unresolved",
          path: "/nodes/4/configuration/questions/0",
        }),
      ]),
    );
  });
});
