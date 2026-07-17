import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS, type WorkflowBlockType } from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

const context: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: false },
  llmProviders: { claude: true, codex: false },
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
      expect(contract.additionalInputs, `${type} additional inputs`).toBeInstanceOf(Array);
      expect(contract.output.schema, `${type} output`).toBeTypeOf("object");
      expect(contract.output.bindingSchema, `${type} binding output`).toBeTypeOf("object");
      expect(contract.output.statusVariants.length, `${type} statuses`).toBeGreaterThan(0);
    }
  });

  it("declares safe variadic Finalize check inputs", () => {
    const contract = buildWorkflowBlockRegistry(context).finalize_workspace;
    expect(contract.additionalInputs).toEqual([
      {
        keyPattern: "^checks\\.[A-Za-z0-9_-]+$",
        schema: { type: "string" },
      },
    ]);
  });

  it("separates the full output envelope from fields guaranteed on normal output", () => {
    const registry = buildWorkflowBlockRegistry(context);
    expect(registry.planning_agent.output.schema).toMatchObject({ required: ["status"] });
    expect(registry.planning_agent.output.bindingSchema).toMatchObject({
      required: ["status", "plan"],
    });
    expect(registry.review_agent.output.bindingSchema).toMatchObject({
      required: ["status"],
    });
  });

  it("advertises only inputs current executors actually consume", () => {
    const registry = buildWorkflowBlockRegistry(context);

    for (const contract of Object.values(registry)) {
      for (const [name, inputContract] of Object.entries(contract.inputs)) {
        const isBindingOnlyPlan = contract.type === "send_plan_approval" && name === "plan";
        expect(inputContract.required, `${contract.type}.${name}`).toBe(isBindingOnlyPlan);
      }
    }
    expect(registry.open_pr.inputs).toEqual({});
    expect(registry.implementation_agent.inputs).toEqual({});
    expect(registry.fix_agent.inputs).toEqual({});
    expect(registry.fetch_pr_context.inputs).toEqual({});
    expect(Object.keys(registry.generic_agent.inputs)).toEqual(["prompt"]);
    expect(Object.keys(registry.call_llm.inputs)).toEqual(["prompt", "system"]);
    expect(Object.keys(registry.update_ticket_status.inputs)).toEqual(["target"]);
    expect(Object.keys(registry.post_ticket_comment.inputs)).toEqual(["body"]);
    expect(Object.keys(registry.post_pr_comment.inputs)).toEqual(["body"]);
    expect(Object.keys(registry.send_slack_message.inputs)).toEqual(["message"]);
    expect(Object.keys(registry.human_question.inputs)).toEqual([
      "questions",
      "suggestedAnswers",
    ]);
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

  it.each([
    ["42", "outputSchema must be a JSON Schema object."],
    ['{"type":"made-up"}', 'outputSchema has unsupported type "made-up".'],
    [
      '{"type":"object","properties":{"nested":{"type":"made-up"}}}',
      'outputSchema.properties.nested has unsupported type "made-up".',
    ],
  ])("disables valid JSON that is not a supported recursive schema", (outputSchema, reason) => {
    const contract = resolveWorkflowBlockContract(
      "call_llm",
      { prompt: "work", outputSchema },
      context,
    );
    expect(contract.availability).toMatchObject({
      available: false,
      unavailableReason: reason,
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

  it("distinguishes OAuth-capable Codex agents from API-key-only Call LLM", () => {
    const oauthOnly: WorkflowBlockRegistryContext = {
      ...context,
      agentProviders: { claude: false, codex: true },
      llmProviders: { claude: false, codex: false },
      defaultAgent: { provider: "codex", model: "gpt-5-codex" },
    };

    expect(
      resolveWorkflowBlockContract("generic_agent", { prompt: "work" }, oauthOnly).availability,
    ).toEqual({ available: true, unavailableReason: null });
    expect(
      resolveWorkflowBlockContract("call_llm", { prompt: "work" }, oauthOnly).availability,
    ).toEqual({
      available: false,
      unavailableReason: "Codex API credentials are not configured for Call LLM.",
    });
  });

  it("uses runtime model inference for Call LLM across a different run default", () => {
    const claudeDefault: WorkflowBlockRegistryContext = {
      ...context,
      llmProviders: { claude: true, codex: false },
      defaultAgent: { provider: "claude", model: "claude-test" },
    };
    expect(
      resolveWorkflowBlockContract(
        "call_llm",
        { prompt: "work", model: "gpt-5" },
        claudeDefault,
      ).availability,
    ).toEqual({
      available: false,
      unavailableReason: "Codex API credentials are not configured for Call LLM.",
    });

    const codexDefault: WorkflowBlockRegistryContext = {
      ...context,
      llmProviders: { claude: true, codex: false },
      defaultAgent: { provider: "codex", model: "gpt-5-codex" },
    };
    expect(
      resolveWorkflowBlockContract(
        "call_llm",
        { prompt: "work", model: "claude-haiku-4-5" },
        codexDefault,
      ).availability,
    ).toEqual({ available: true, unavailableReason: null });
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
