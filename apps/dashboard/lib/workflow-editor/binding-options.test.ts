import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowEditorOptions,
  WorkflowValueSchema,
} from "@shared/contracts";
import {
  buildBindingEditorRows,
  canAddAdditionalInput,
  paramsAfterBindingRepair,
  removeLegacyRequiredCheck,
} from "./binding-options.ts";

const stringSchema = { type: "string" } as const;
const numberSchema = { type: "number" } as const;
const unknownSchema = { type: "unknown" } as const;

function objectSchema(
  properties: Record<string, WorkflowValueSchema>,
  required = Object.keys(properties),
): WorkflowValueSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function contract(
  type: WorkflowBlockType,
  output: WorkflowValueSchema,
  inputs: WorkflowBlockContract["inputs"] = {},
  additionalInputs: WorkflowBlockContract["additionalInputs"] = [],
): WorkflowBlockContract {
  return {
    type,
    presentation: {
      group: type.startsWith("trigger_") ? "trigger" : "utility",
      label: type,
      description: type,
      color: "#111",
      softColor: "#eee",
      glyph: "•",
    },
    defaults: {},
    ports: ["out"],
    allowsFailurePort: true,
    inputs,
    additionalInputs,
    output: { schema: output, bindingSchema: output, statusVariants: ["ok"] },
    availability: { available: true, unavailableReason: null },
  };
}

const registry = {
  trigger_ticket_ai: contract(
    "trigger_ticket_ai",
    objectSchema(
      { ticketKey: stringSchema, attempt: numberSchema, optional: stringSchema },
      ["ticketKey", "attempt"],
    ),
  ),
  planning_agent: contract(
    "planning_agent",
    objectSchema({ plan: stringSchema, score: numberSchema }),
  ),
  run_checks: contract(
    "run_checks",
    objectSchema({ report: stringSchema }),
  ),
  call_llm: contract(
    "call_llm",
    objectSchema({ output: stringSchema }),
    {
      prompt: { required: true, schema: stringSchema },
      system: { required: false, schema: stringSchema },
    },
    [{ keyPattern: "^context\\.[A-Za-z0-9_-]+$", schema: stringSchema }],
  ),
} as unknown as WorkflowEditorOptions["blockRegistry"];

const options = {
  blockRegistry: registry,
  runBindingSchema: objectSchema({ id: stringSchema, attempt: numberSchema }),
} as WorkflowEditorOptions;

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [
    { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {}, inputs: {} },
    { id: "plan", type: "planning_agent", x: 1, y: 0, params: {}, inputs: {} },
    { id: "side", type: "run_checks", x: 1, y: 1, params: {}, inputs: {} },
    {
      id: "consumer",
      type: "call_llm",
      x: 2,
      y: 0,
      params: {},
      inputs: {
        prompt: "steps.plan.output.plan",
        "context.ticket": "trigger.ticketKey",
        legacy: "steps.missing.output.old",
      },
    },
  ],
  edges: [
    { from: "trigger", to: "plan" },
    { from: "plan", to: "consumer" },
    { from: "trigger", to: "side" },
  ],
};

test("offers compatible trigger, dominating-step, and run paths from resolved contracts", () => {
  const rows = buildBindingEditorRows({ definition, consumerId: "consumer", options });
  const prompt = rows.find((row) => row.name === "prompt");

  assert.deepEqual(prompt?.suggestions, [
    "trigger.ticketKey",
    "steps.plan.output.plan",
    "run.id",
  ]);
  assert.equal(prompt?.value, "steps.plan.output.plan");
  assert.equal(prompt?.required, true);
});

test("keeps variadic and unknown legacy inputs visible so exact paths can be repaired", () => {
  const rows = buildBindingEditorRows({ definition, consumerId: "consumer", options });

  assert.deepEqual(
    rows.map(({ name, variadic, legacy, value }) => ({ name, variadic, legacy, value })),
    [
      { name: "prompt", variadic: false, legacy: false, value: "steps.plan.output.plan" },
      { name: "system", variadic: false, legacy: false, value: "" },
      { name: "context.ticket", variadic: true, legacy: false, value: "trigger.ticketKey" },
      { name: "legacy", variadic: true, legacy: true, value: "steps.missing.output.old" },
    ],
  );
  assert.deepEqual(canAddAdditionalInput("context.review", rows, registry.call_llm), {
    allowed: true,
    reason: null,
  });
  assert.match(
    canAddAdditionalInput("prompt", rows, registry.call_llm).reason ?? "",
    /already exists/i,
  );
  assert.match(
    canAddAdditionalInput("context.bad.name", rows, registry.call_llm).reason ?? "",
    /does not match/i,
  );
});

test("uses parameter-resolved node contracts when validation returns them", () => {
  const resolved = {
    ...registry.call_llm,
    inputs: { prompt: { required: true, schema: numberSchema } },
    additionalInputs: [],
  } satisfies WorkflowBlockContract;

  const rows = buildBindingEditorRows({
    definition,
    consumerId: "consumer",
    options,
    nodeContracts: { consumer: resolved },
  });

  assert.deepEqual(rows[0]?.suggestions, ["trigger.attempt", "steps.plan.output.score", "run.attempt"]);
  assert.equal(rows.some((row) => row.name === "context.ticket" && row.legacy), true);
});

test("does not suggest a field that can reach the consumer through a failure path without it", () => {
  const failureGraph: WorkflowDefinition = {
    ...definition,
    edges: [
      { from: "trigger", to: "plan" },
      { from: "plan", to: "consumer", fromPort: "failed" },
    ],
  };
  const planContract: WorkflowBlockContract = {
    ...registry.planning_agent,
    output: {
      ...registry.planning_agent.output,
      schema: objectSchema({ status: stringSchema }),
    },
  };

  const rows = buildBindingEditorRows({
    definition: failureGraph,
    consumerId: "consumer",
    options,
    nodeContracts: { plan: planContract },
  });

  assert.equal(rows[0]?.suggestions.includes("steps.plan.output.plan"), false);
});

test("authoring a replacement binding clears the matching Arthur compatibility marker", () => {
  const node = {
    id: "arthur",
    type: "arthur_injection_check" as const,
    x: 0,
    y: 0,
    params: { legacyContentFromStep: "dynamic" },
    inputs: { content: "steps.dynamic.output.value" as const },
  };

  assert.deepEqual(paramsAfterBindingRepair(node), {});
  assert.deepEqual(paramsAfterBindingRepair({ ...node, inputs: {} }), node.params);
});

test("Finalize marker cleanup is derived from the complete binding map and is reversible", () => {
  const node = {
    id: "finalize",
    type: "finalize_workspace" as const,
    x: 0,
    y: 0,
    params: { legacyRequiredChecks: ["lint", "tests"] },
    inputs: { "checks.lint": "steps.lint.output.status" as const },
  };

  const afterLint = paramsAfterBindingRepair(node);
  assert.deepEqual(afterLint, { legacyRequiredChecks: ["tests"] });
  assert.deepEqual(
    paramsAfterBindingRepair({
      ...node,
      inputs: {
        "checks.lint": "steps.lint.output.status" as const,
        "checks.tests": "steps.tests.output.status" as const,
      },
    }),
    {},
  );
  assert.deepEqual(paramsAfterBindingRepair({ ...node, inputs: {} }), node.params);
});

test("an unrepresentable legacy check has an explicit removal path", () => {
  const params = { legacyRequiredChecks: ["checks.with.dot", "checks space"] };

  assert.deepEqual(removeLegacyRequiredCheck(params, "checks space"), {
    legacyRequiredChecks: ["checks.with.dot"],
  });
  assert.deepEqual(removeLegacyRequiredCheck(params, "checks.with.dot"), {
    legacyRequiredChecks: ["checks space"],
  });
  assert.deepEqual(removeLegacyRequiredCheck({ legacyRequiredChecks: ["only"] }, "only"), {});
});
