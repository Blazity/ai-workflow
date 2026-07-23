import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockTypeV1,
  WorkflowDefinitionV1,
  WorkflowDefinitionNode,
  WorkflowParamValue,
  WorkflowValueSchema,
} from "@shared/contracts";
import {
  isWorkflowSchemaAssignable,
  parseWorkflowBindingSource,
  resolveWorkflowInputBindings,
  resolveWorkflowSchemaPath,
  RUN_BINDING_SCHEMA,
  validateWorkflowBindings,
} from "./bindings.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";

const stringSchema: WorkflowValueSchema = { type: "string" };

describe("parseWorkflowBindingSource", () => {
  it.each([
    ["trigger.ticket.key", { root: "trigger", path: ["ticket", "key"] }],
    [
      "steps.plan.output.data.items.0.title",
      { root: "steps", nodeId: "plan", path: ["data", "items", "0", "title"] },
    ],
    ["run.defaultAgent.model", { root: "run", path: ["defaultAgent", "model"] }],
  ])("parses %s", (source, expected) => {
    expect(parseWorkflowBindingSource(source)).toEqual(expected);
  });

  it.each([
    " trigger.ticket.key",
    "trigger",
    "trigger.",
    "trigger.ticket..key",
    "steps.plan.output",
    "steps.plan.result.value",
    "steps..output.value",
    "run.branchName.",
    "run.constructor.name",
    "trigger.__proto__.polluted",
    "steps.prototype.output.value",
  ])("rejects the non-canonical or unsafe source %s", (source) => {
    expect(parseWorkflowBindingSource(source)).toBeNull();
  });
});

describe("resolveWorkflowSchemaPath", () => {
  const schema: WorkflowValueSchema = {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { title: stringSchema },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
    required: ["data"],
    additionalProperties: false,
  };

  it("looks up nested object fields and numeric array indices", () => {
    expect(resolveWorkflowSchemaPath(schema, ["data", "items", "0", "title"])).toEqual(
      stringSchema,
    );
  });

  it("rejects undeclared fields and non-numeric array indices", () => {
    expect(resolveWorkflowSchemaPath(schema, ["data", "missing"])).toBeNull();
    expect(resolveWorkflowSchemaPath(schema, ["data", "items", "first"])).toBeNull();
  });

  it("publishes the exact fixed run binding schema", () => {
    expect(RUN_BINDING_SCHEMA).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        branchName: { type: "string" },
        defaultAgent: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
          required: ["provider", "model"],
          additionalProperties: false,
        },
      },
      required: ["id", "branchName", "defaultAgent"],
      additionalProperties: false,
    });
  });
});

describe("isWorkflowSchemaAssignable", () => {
  it("accepts exact primitive types and rejects incompatible or unknown sources", () => {
    expect(isWorkflowSchemaAssignable(stringSchema, stringSchema)).toBe(true);
    expect(isWorkflowSchemaAssignable({ type: "number" }, stringSchema)).toBe(false);
    expect(isWorkflowSchemaAssignable({ type: "unknown" }, stringSchema)).toBe(false);
    expect(isWorkflowSchemaAssignable(stringSchema, { type: "unknown" })).toBe(true);
    expect(isWorkflowSchemaAssignable({ type: "unknown" }, { type: "unknown" })).toBe(
      true,
    );
  });

  it("treats source enums as finite sets that must fit inside the target", () => {
    const ready: WorkflowValueSchema = { type: "string", enum: ["ready"] };
    const readyOrBlocked: WorkflowValueSchema = {
      type: "string",
      enum: ["ready", "blocked"],
    };
    const blocked: WorkflowValueSchema = {
      type: "string",
      enum: ["blocked"],
    };

    expect(isWorkflowSchemaAssignable(ready, ready)).toBe(true);
    expect(isWorkflowSchemaAssignable(ready, readyOrBlocked)).toBe(true);
    expect(isWorkflowSchemaAssignable(readyOrBlocked, ready)).toBe(false);
    expect(isWorkflowSchemaAssignable(ready, blocked)).toBe(false);
    expect(isWorkflowSchemaAssignable(ready, stringSchema)).toBe(true);
    expect(isWorkflowSchemaAssignable(stringSchema, ready)).toBe(false);
  });

  it("handles finite Boolean, null, nullable, array, and object enums exactly", () => {
    expect(
      isWorkflowSchemaAssignable(
        { type: "boolean" },
        { type: "boolean", enum: [false, true] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        { type: "boolean" },
        { type: "boolean", enum: [true] },
      ),
    ).toBe(false);
    expect(
      isWorkflowSchemaAssignable(
        { type: "null" },
        { type: "nullable", value: stringSchema, enum: ["ready", null] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "nullable",
          value: { type: "string", enum: ["ready"] },
          enum: ["ready"],
        },
        { type: "string", enum: ["ready"] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        { type: "array", items: stringSchema, enum: [["ready"]] },
        { type: "array", items: stringSchema, enum: [["ready"], ["blocked"]] },
      ),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { state: stringSchema },
          required: ["state"],
          additionalProperties: false,
          enum: [{ state: "ready" }],
        },
        {
          type: "object",
          properties: { state: { type: "string", enum: ["ready"] } },
          required: ["state"],
          additionalProperties: false,
          enum: [{ state: "ready" }],
        },
      ),
    ).toBe(true);
  });

  it("enforces closed-object property sets in both directions", () => {
    const closedTitle: WorkflowValueSchema = {
      type: "object",
      properties: { title: stringSchema },
      required: ["title"],
      additionalProperties: false,
    };
    const closedTitleAndOptionalCount: WorkflowValueSchema = {
      type: "object",
      properties: { title: stringSchema, count: { type: "number" } },
      required: ["title"],
      additionalProperties: false,
    };
    const closedTitleAndRequiredCount: WorkflowValueSchema = {
      ...closedTitleAndOptionalCount,
      required: ["title", "count"],
    };

    expect(isWorkflowSchemaAssignable(closedTitle, closedTitle)).toBe(true);
    expect(
      isWorkflowSchemaAssignable(closedTitle, closedTitleAndOptionalCount),
    ).toBe(true);
    expect(
      isWorkflowSchemaAssignable(closedTitleAndOptionalCount, closedTitle),
    ).toBe(false);
    expect(
      isWorkflowSchemaAssignable(closedTitleAndRequiredCount, closedTitle),
    ).toBe(false);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { title: { type: "number" } },
          required: ["title"],
          additionalProperties: false,
        },
        closedTitle,
      ),
    ).toBe(false);
  });

  it("allows closed sources into open targets but rejects unsafe open sources", () => {
    const closedTitle: WorkflowValueSchema = {
      type: "object",
      properties: { title: stringSchema },
      required: ["title"],
      additionalProperties: false,
    };
    const openTitle: WorkflowValueSchema = {
      ...closedTitle,
      additionalProperties: true,
    };
    const openAnything: WorkflowValueSchema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    };

    expect(isWorkflowSchemaAssignable(closedTitle, openTitle)).toBe(true);
    expect(isWorkflowSchemaAssignable(openTitle, closedTitle)).toBe(false);
    expect(isWorkflowSchemaAssignable(openTitle, openTitle)).toBe(true);
    expect(isWorkflowSchemaAssignable(openTitle, openAnything)).toBe(true);
    expect(isWorkflowSchemaAssignable(openAnything, openTitle)).toBe(false);
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { title: stringSchema, count: { type: "number" } },
          required: ["title", "count"],
          additionalProperties: true,
        },
        openTitle,
      ),
    ).toBe(true);
  });

  it("requires every target-required property to be guaranteed by the source", () => {
    expect(
      isWorkflowSchemaAssignable(
        {
          type: "object",
          properties: { title: stringSchema },
          required: [],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { title: stringSchema },
          required: ["title"],
          additionalProperties: false,
        },
      ),
    ).toBe(false);
  });
});

describe("resolveWorkflowInputBindings", () => {
  it("resolves trigger, prior-step, and run values using own properties", () => {
    const resolved = resolveWorkflowInputBindings(
      {
        ticketKey: "trigger.ticket.key",
        summary: "steps.plan.output.data.summary",
        model: "run.defaultAgent.model",
      },
      { status: "fired", ticket: { key: "AIW-92" } },
      { plan: { output: { status: "ok", data: { summary: "Ready" } } } },
      {
        id: "run-1",
        branchName: "ai-workflow/AIW-92",
        defaultAgent: { provider: "codex", model: "gpt-5-codex" },
      },
    );

    expect(resolved).toEqual({ ticketKey: "AIW-92", summary: "Ready", model: "gpt-5-codex" });
  });

  it("fails closed when a runtime path is missing", () => {
    expect(() =>
      resolveWorkflowInputBindings(
        { value: "trigger.missing" },
        { status: "fired" },
        {},
        {
          id: "run-1",
          branchName: "branch",
          defaultAgent: { provider: "claude", model: "model" },
        },
      ),
    ).toThrow('binding "trigger.missing" could not be resolved');
  });
});

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

function node(
  id: string,
  type: WorkflowBlockTypeV1,
  params: Record<string, WorkflowParamValue> = {},
  inputs: WorkflowDefinitionNode["inputs"] = {},
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs };
}

function definition(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionV1["edges"],
): WorkflowDefinitionV1 {
  return { schemaVersion: 1, nodes, edges };
}

describe("validateWorkflowBindings", () => {
  it("rejects unknown inputs and a missing required binding-only input", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("approval", "send_plan_approval", {}, { madeUp: "trigger.ticketKey" }),
      ],
      [{ from: "trigger", to: "approval" }],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual(
      expect.arrayContaining([
        'Block "approval" has unknown input "madeUp".',
        'Block "approval" is missing required input "plan".',
      ]),
    );
  });

  it("requires Open PR to consume the exact output of a dominating Finalize block", () => {
    const valid = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("finalize", "finalize_workspace"),
        node("open", "open_pr", {}, {
          repositories: "steps.finalize.output.repositories",
        }),
      ],
      [
        { from: "trigger", to: "finalize" },
        { from: "finalize", to: "open" },
      ],
    );
    expect(validateWorkflowBindings(valid, registryContext)).toEqual([]);

    const invalid: Array<[string, WorkflowDefinitionV1]> = [
      [
        "run value",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("open", "open_pr", {}, { repositories: "run.branchName" }),
          ],
          [{ from: "trigger", to: "open" }],
        ),
      ],
      [
        "trigger value",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("open", "open_pr", {}, { repositories: "trigger.ticketKey" }),
          ],
          [{ from: "trigger", to: "open" }],
        ),
      ],
      [
        "generic string",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("generic", "generic_agent", { prompt: "reuse an attempt" }),
            node("open", "open_pr", {}, {
              repositories: "steps.generic.output.body",
            }),
          ],
          [
            { from: "trigger", to: "generic" },
            { from: "generic", to: "open" },
          ],
        ),
      ],
      [
        "wrong Finalize field",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("finalize", "finalize_workspace"),
            node("open", "open_pr", {}, {
              repositories: "steps.finalize.output.status",
            }),
          ],
          [
            { from: "trigger", to: "finalize" },
            { from: "finalize", to: "open" },
          ],
        ),
      ],
      [
        "non-dominating Finalize",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("branch", "branch", { condition: "true" }),
            node("finalize", "finalize_workspace"),
            node("bypass", "run_checks"),
            node("open", "open_pr", {}, {
              repositories: "steps.finalize.output.repositories",
            }),
          ],
          [
            { from: "trigger", to: "branch" },
            { from: "branch", to: "finalize", fromPort: "true" },
            { from: "branch", to: "bypass", fromPort: "false" },
            { from: "finalize", to: "open" },
            { from: "bypass", to: "open" },
          ],
        ),
      ],
    ];
    const expected =
      'Block "open" input "repositories" must bind exactly to steps.<finalize_workspace_id>.output.repositories from a dominating Finalize Workspace block.';
    for (const [label, def] of invalid) {
      expect(validateWorkflowBindings(def, registryContext), label).toContain(expected);
    }
  });

  it("rejects unknown, self, downstream, and non-dominating step sources", () => {
    const cases: Array<[string, WorkflowDefinitionV1]> = [
      [
        "unknown",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("approval", "send_plan_approval", {}, { plan: "steps.ghost.output.plan" }),
          ],
          [{ from: "trigger", to: "approval" }],
        ),
      ],
      [
        "itself",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("approval", "send_plan_approval", {}, { plan: "steps.approval.output.plan" }),
          ],
          [{ from: "trigger", to: "approval" }],
        ),
      ],
      [
        "downstream",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("approval", "send_plan_approval", {}, { plan: "steps.later.output.body" }),
            node("later", "generic_agent", { prompt: "later" }),
          ],
          [
            { from: "trigger", to: "approval" },
            { from: "approval", to: "later" },
          ],
        ),
      ],
      [
        "does not dominate",
        definition(
          [
            node("trigger", "trigger_ticket_ai"),
            node("branch", "branch", { condition: "true" }),
            node("left", "planning_agent"),
            node("right", "planning_agent"),
            node("approval", "send_plan_approval", {}, { plan: "steps.left.output.plan" }),
          ],
          [
            { from: "trigger", to: "branch" },
            { from: "branch", to: "left", fromPort: "true" },
            { from: "branch", to: "right", fromPort: "false" },
            { from: "left", to: "approval" },
            { from: "right", to: "approval" },
          ],
        ),
      ],
    ];

    for (const [label, def] of cases) {
      expect(
        validateWorkflowBindings(def, registryContext).some((issue) =>
          issue.toLowerCase().includes(label),
        ),
        label,
      ).toBe(true);
    }
  });

  it("accepts a top-level declared Generic Agent output from a strict dominator", () => {
    const outputSchema = JSON.stringify({
      type: "object",
      properties: {
        summary: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
      required: ["summary"],
      additionalProperties: false,
    });
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("generate", "generic_agent", { prompt: "generate", outputSchema }),
        node("approval", "send_plan_approval", {}, {
          plan: "steps.generate.output.summary.title",
        }),
      ],
      [
        { from: "trigger", to: "generate" },
        { from: "generate", to: "approval" },
      ],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual([]);
  });

  it("accepts Generic Agent body from an unstructured normal output", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("generate", "generic_agent", { prompt: "generate" }),
        node("approval", "send_plan_approval", {}, {
          plan: "steps.generate.output.body",
        }),
      ],
      [
        { from: "trigger", to: "generate" },
        { from: "generate", to: "approval" },
      ],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual([]);
  });

  it("binds fields guaranteed on the producer's normal output", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("plan", "planning_agent"),
        node("approval", "send_plan_approval", {}, { plan: "steps.plan.output.plan" }),
      ],
      [
        { from: "trigger", to: "plan" },
        { from: "plan", to: "approval" },
      ],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual([]);
  });

  it("rejects a binding when a source-to-consumer path starts on the failure port", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("plan", "planning_agent"),
        node("done", "terminate", { terminalStatus: "done" }),
        node("approval", "send_plan_approval", {}, { plan: "steps.plan.output.plan" }),
      ],
      [
        { from: "trigger", to: "plan" },
        { from: "plan", to: "done" },
        { from: "plan", to: "approval", fromPort: "failed" },
      ],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('may reach "approval" through its failure port'),
      ]),
    );
  });

  it("rejects fields that are not guaranteed on normal output", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("review", "review_agent"),
        node("approval", "send_plan_approval", {}, { plan: "steps.review.output.feedback" }),
      ],
      [
        { from: "trigger", to: "review" },
        { from: "review", to: "approval" },
      ],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual(
      expect.arrayContaining([expect.stringContaining("is not guaranteed on normal output")]),
    );
  });

  it("accepts safe variadic Finalize checks and rejects other additional inputs", () => {
    const base = [
      node("trigger", "trigger_ticket_ai"),
      node("checks", "run_checks"),
    ];
    const edges = [
      { from: "trigger", to: "checks" },
      { from: "checks", to: "finalize" },
    ];
    const valid = definition(
      [...base, node("finalize", "finalize_workspace", {}, {
        "checks.lint": "steps.checks.output.status",
      })],
      edges,
    );
    const invalid = definition(
      [...base, node("finalize", "finalize_workspace", {}, {
        "other.lint": "steps.checks.output.status",
      })],
      edges,
    );

    expect(validateWorkflowBindings(valid, registryContext)).toEqual([]);
    expect(validateWorkflowBindings(invalid, registryContext)).toEqual([
      'Block "finalize" has unknown input "other.lint".',
    ]);
  });

  it("accepts a status gate when the check reaches Finalize through its failure port", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("checks", "run_checks"),
        node("finalize", "finalize_workspace", {}, {
          "checks.test": "steps.checks.output.status",
        }),
      ],
      [
        { from: "trigger", to: "checks" },
        { from: "checks", to: "finalize", fromPort: "failed" },
      ],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual([]);
  });

  it("rejects source fields whose contract type does not match the input", () => {
    const def = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("approval", "send_plan_approval", {}, { plan: "run.defaultAgent" }),
      ],
      [{ from: "trigger", to: "approval" }],
    );

    expect(validateWorkflowBindings(def, registryContext)).toEqual([
      'Block "approval" input "plan" expects string but "run.defaultAgent" provides object.',
    ]);
  });

  it("validates trigger paths against every trigger that can reach the consumer", () => {
    const def = definition(
      [
        node("ticket", "trigger_ticket_ai"),
        node("review", "trigger_pr_review"),
        node("approval", "send_plan_approval", {}, { plan: "trigger.approvedPlan" }),
      ],
      [
        { from: "ticket", to: "approval" },
        { from: "review", to: "approval" },
      ],
    );

    const issues = validateWorkflowBindings(def, registryContext);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('trigger "ticket"'),
        expect.stringContaining('trigger "review"'),
      ]),
    );
  });
});
