import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS, type WorkflowBlockType } from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

const context: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: false },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github"],
  slackConfigured: false,
  arthurConfigured: false,
};

describe("workflow block registry", () => {
  it("owns a complete contract for every workflow block type", () => {
    const registry = buildWorkflowBlockRegistry(context);
    const blockTypes = Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[];

    expect(Object.keys(registry).sort()).toEqual([...blockTypes].sort());
    for (const type of blockTypes) {
      const contract = registry[type];
      expect(contract.type).toBe(type);
      expect(contract.presentation.label.trim(), `${type} label`).not.toBe("");
      expect(contract.presentation.description.trim(), `${type} description`).not.toBe("");
      expect(contract.presentation.group.trim(), `${type} group`).not.toBe("");
      expect(contract.defaults, `${type} defaults`).toBeTypeOf("object");
      expect(contract.ports, `${type} ports`).toEqual(BLOCK_TYPE_SPECS[type].ports);
      expect(contract.allowsFailurePort, `${type} failure port`).toBe(
        BLOCK_TYPE_SPECS[type].allowsFailurePort,
      );
      expect(contract.inputs, `${type} inputs`).toBeTypeOf("object");
      expect(contract.output.schema, `${type} output`).toBeTypeOf("object");
      expect(contract.output.statusVariants.length, `${type} statuses`).toBeGreaterThan(0);
    }
  });

  it("does not require bindings that current executors source from context or params", () => {
    const registry = buildWorkflowBlockRegistry(context);

    for (const contract of Object.values(registry)) {
      for (const [name, inputContract] of Object.entries(contract.inputs)) {
        expect(inputContract.required, `${contract.type}.${name}`).toBe(false);
      }
    }
    expect(registry.open_pr.inputs).toEqual({
      workspace: {
        required: false,
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            repositories: { type: "array", items: { type: "string" } },
          },
          required: ["id"],
          additionalProperties: true,
        },
      },
    });
    expect(registry.trigger_ticket_ai.output.schema).not.toMatchObject({
      properties: { ticket: expect.anything() },
    });
  });

  it("always explains why an environmentally unavailable block is disabled", () => {
    const registry = buildWorkflowBlockRegistry(context);
    expect(registry.send_slack_message.availability).toEqual({
      available: false,
      unavailableReason: "Slack messaging is not configured.",
    });
    expect(registry.arthur_injection_check.availability).toEqual({
      available: false,
      unavailableReason: "Arthur Engine is not configured.",
    });

    for (const contract of Object.values(registry)) {
      if (!contract.availability.available) {
        expect(contract.availability.unavailableReason.trim(), contract.type).not.toBe("");
      }
    }
  });

  it("derives Generic Agent's nested data schema from outputSchema", () => {
    const contract = resolveWorkflowBlockContract(
      "generic_agent",
      {
        provider: "claude",
        prompt: "summarize",
        outputSchema: JSON.stringify({
          type: "object",
          properties: {
            summary: { type: "string" },
            stats: {
              type: "object",
              properties: { passed: { type: "number" } },
              required: ["passed"],
              additionalProperties: false,
            },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "stats"],
          additionalProperties: false,
        }),
      },
      context,
    );

    expect(contract.output.schema).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        data: {
          type: "object",
          properties: {
            summary: { type: "string" },
            stats: {
              type: "object",
              properties: { passed: { type: "number" } },
              required: ["passed"],
              additionalProperties: false,
            },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "stats"],
          additionalProperties: false,
        },
      },
      required: ["status"],
      additionalProperties: false,
    });
  });

  it("derives Call LLM's output field and disables malformed JSON schema", () => {
    const declared = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "count", outputSchema: '{"type":"array","items":{"type":"boolean"}}' },
      context,
    );
    expect(declared.output.schema).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        output: { type: "array", items: { type: "boolean" } },
      },
      required: ["status"],
      additionalProperties: false,
    });

    const invalid = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "count", outputSchema: "{not-json" },
      context,
    );
    expect(invalid.output.schema).toMatchObject({
      type: "object",
      properties: { output: { type: "unknown" } },
    });
    expect(invalid.availability).toEqual({
      available: false,
      unavailableReason: "outputSchema is not valid JSON.",
    });
  });

  it("treats a blank outputSchema as the block's unstructured default", () => {
    const registry = buildWorkflowBlockRegistry(context);
    const generic = resolveWorkflowBlockContract(
      "generic_agent",
      { prompt: "work", outputSchema: "   " },
      context,
    );
    const llm = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "work", outputSchema: "   " },
      context,
    );

    expect(generic.output.schema).toEqual(registry.generic_agent.output.schema);
    expect(llm.output.schema).toEqual(registry.call_llm.output.schema);
  });

  it("marks a block unavailable when its selected agent provider has no credentials", () => {
    const contract = resolveWorkflowBlockContract(
      "generic_agent",
      { provider: "codex", prompt: "work" },
      context,
    );
    expect(contract.availability).toEqual({
      available: false,
      unavailableReason: "Codex credentials are not configured.",
    });
  });

  it("marks a VCS trigger unavailable when none of its selected providers are installed", () => {
    const gitlabOnly = resolveWorkflowBlockContract(
      "trigger_pr_review",
      { providers: ["gitlab"], on: ["changes_requested"] },
      context,
    );
    expect(gitlabOnly.availability).toEqual({
      available: false,
      unavailableReason: "Selected VCS providers are not configured: gitlab.",
    });

    expect(buildWorkflowBlockRegistry(context).trigger_pr_review.availability).toEqual({
      available: true,
      unavailableReason: null,
    });
  });
});
