import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowNodeDef } from "../flows.ts";
import {
  collectFlowNodeReferences,
  remapFlowNodeReferences,
  remapLegacyBranchCondition,
  remapPromptDataTokens,
  remapWorkflowDataReference,
  workflowReferenceSourceNodeId,
} from "./reference-visitor.ts";

const ids = new Map([
  ["plan", "plan-copy"],
  ["review", "review-copy"],
]);

test("remaps canonical references without touching entry, run, or output paths", () => {
  assert.equal(
    remapWorkflowDataReference("steps.plan.output.result.value", ids),
    "steps.plan-copy.output.result.value",
  );
  assert.equal(
    remapWorkflowDataReference("steps.entry.output.ticketKey", ids),
    "steps.entry.output.ticketKey",
  );
  assert.equal(remapWorkflowDataReference("run.attempt", ids), "run.attempt");
});

test("remaps every canonical prompt token losslessly around ordinary text", () => {
  const source =
    "Use {{data:steps.plan.output.plan}} and {{data:steps.review.output.decision}}; keep {{data:run.attempt}}.";
  assert.equal(
    remapPromptDataTokens(source, ids),
    "Use {{data:steps.plan-copy.output.plan}} and {{data:steps.review-copy.output.decision}}; keep {{data:run.attempt}}.",
  );
});

test("remaps legacy Branch paths but not path-like quoted literals", () => {
  const source =
    `steps.review.output.decision == "steps.review.output.decision" && steps.plan.output.ok == true`;
  assert.equal(
    remapLegacyBranchCondition(source, ids),
    `steps.review-copy.output.decision == "steps.review.output.decision" && steps.plan-copy.output.ok == true`,
  );
});

test("one node visitor remaps v1 inputs and the Branch condition source", () => {
  const node: FlowNodeDef = {
    id: "branch",
    type: "branch",
    x: 0,
    y: 0,
    name: "Decide",
    params: {
      condition: "steps.review.output.ok == true",
    },
    inputs: {
      decision: "steps.review.output.decision",
      attempt: "run.attempt",
    },
  };

  const remapped = remapFlowNodeReferences(node, ids);
  assert.deepEqual(remapped.inputs, {
    decision: "steps.review-copy.output.decision",
    attempt: "run.attempt",
  });
  assert.equal(
    remapped.params.condition,
    "steps.review-copy.output.ok == true",
  );
  assert.deepEqual(node.inputs, {
    decision: "steps.review.output.decision",
    attempt: "run.attempt",
  });
});

test("prompt tokens remap only in fields owned by their actual block types", () => {
  const terminate: FlowNodeDef = {
    id: "stop",
    type: "terminate",
    x: 0,
    y: 0,
    params: {
      postComment: "Plan: {{data:steps.plan.output.plan}}",
    },
    inputs: {},
  };
  const question: FlowNodeDef = {
    id: "ask",
    type: "human_question",
    x: 0,
    y: 0,
    params: {
      questions: ["Review {{data:steps.review.output.decision}}"],
    },
    inputs: {},
  };

  assert.equal(
    remapFlowNodeReferences(terminate, ids).params.postComment,
    "Plan: {{data:steps.plan-copy.output.plan}}",
  );
  assert.deepEqual(
    remapFlowNodeReferences(question, ids).params.questions,
    ["Review {{data:steps.review-copy.output.decision}}"],
  );
});

test("one node visitor remaps v2 bindings and a typed Branch AST", () => {
  const node: FlowNodeDef = {
    id: "consumer",
    type: "branch",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: {
      inputs: {
        review: {
          kind: "reference",
          reference: "steps.review.output.decision",
        },
      },
      additionalInputs: [
        {
          name: "plan",
          schema: { type: "string" },
          binding: {
            kind: "reference",
            reference: "steps.plan.output.plan",
          },
        },
      ],
      configuration: {
        combinator: "all",
        conditions: [{
          reference: "steps.review.output.decision",
          operator: "equals",
          value: "approve",
        }],
      },
    },
  };

  const remapped = remapFlowNodeReferences(node, ids);
  assert.equal(
    remapped.v2?.inputs.review?.kind === "reference"
      ? remapped.v2.inputs.review.reference
      : null,
    "steps.review-copy.output.decision",
  );
  assert.equal(
    remapped.v2?.additionalInputs[0]?.binding.kind === "reference"
      ? remapped.v2.additionalInputs[0].binding.reference
      : null,
    "steps.plan-copy.output.plan",
  );
  assert.deepEqual(remapped.v2?.configuration, {
    combinator: "all",
    conditions: [{
      reference: "steps.review-copy.output.decision",
      operator: "equals",
      value: "approve",
    }],
  });
});

test("agent prompt tokens and slot bindings remap without touching literals", () => {
  const node: FlowNodeDef = {
    id: "consumer",
    type: "generic_agent",
    x: 0,
    y: 0,
    params: {
      prompt: "{{data:steps.plan.output.plan}}",
    },
    inputs: {},
    v2: {
      inputs: {},
      additionalInputs: [],
      configuration: {
        prompt: "{{data:steps.plan.output.plan}}",
        promptSlotBindings: {
          plan: {
            kind: "reference",
            reference: "steps.plan.output.plan",
          },
        },
      },
    },
  };

  const remapped = remapFlowNodeReferences(node, ids);
  assert.equal(
    remapped.params.prompt,
    "{{data:steps.plan-copy.output.plan}}",
  );
  assert.deepEqual(remapped.v2?.configuration, {
    prompt: "{{data:steps.plan-copy.output.plan}}",
    promptSlotBindings: {
      plan: {
        kind: "reference",
        reference: "steps.plan-copy.output.plan",
      },
    },
  });
});

test("reference visiting preserves arbitrary Transform literals and schema source", () => {
  const transform: FlowNodeDef = {
    id: "shape",
    type: "transform",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: {
      inputs: {},
      additionalInputs: [],
      configuration: {
        operation: "build_object",
        fields: [
          {
            name: "literal",
            value: { kind: "literal", value: "steps.plan.output.plan" },
          },
        ],
      },
    },
  };
  const agent: FlowNodeDef = {
    id: "agent",
    type: "generic_agent",
    x: 0,
    y: 0,
    params: {
      prompt: "Use {{data:steps.plan.output.plan}}.",
      outputSchema:
        '{"examples":["{{data:steps.review.output.decision}}"]}',
    },
    inputs: {},
    v2: {
      inputs: {},
      additionalInputs: [],
      configuration: {
        prompt: "Use {{data:steps.plan.output.plan}}.",
        outputSchema:
          '{"examples":["{{data:steps.review.output.decision}}"]}',
        promptSlotBindings: {
          literal: {
            kind: "literal",
            value: {
              kind: "reference",
              reference: "steps.review.output.decision",
            },
          },
        },
      },
    },
  };

  assert.deepEqual(
    remapFlowNodeReferences(transform, ids).v2?.configuration,
    transform.v2?.configuration,
  );
  const remappedAgent = remapFlowNodeReferences(agent, ids);
  assert.equal(
    remappedAgent.v2?.configuration.prompt,
    "Use {{data:steps.plan-copy.output.plan}}.",
  );
  assert.equal(
    remappedAgent.v2?.configuration.outputSchema,
    agent.v2?.configuration.outputSchema,
  );
  assert.deepEqual(
    remappedAgent.v2?.configuration.promptSlotBindings,
    agent.v2?.configuration.promptSlotBindings,
  );
  assert.deepEqual(collectFlowNodeReferences(transform), []);
  assert.deepEqual(collectFlowNodeReferences(agent), [
    {
      reference: "steps.plan.output.plan",
      path: "/configuration/prompt",
    },
  ]);
});

test("collects every serialized reference with an exact relative path", () => {
  const node: FlowNodeDef = {
    id: "consumer",
    type: "branch",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: {
      inputs: {
        fixed: {
          kind: "reference",
          reference: "steps.plan.output.plan",
        },
      },
      additionalInputs: [
        {
          name: "review",
          schema: { type: "string" },
          binding: {
            kind: "reference",
            reference: "steps.review.output.decision",
          },
        },
      ],
      configuration: {
        combinator: "all",
        conditions: [{
          reference: "steps.review.output.ok",
          operator: "equals",
          value: true,
        }],
      },
    },
  };

  assert.deepEqual(collectFlowNodeReferences(node), [
    {
      reference: "steps.plan.output.plan",
      path: "/inputs/fixed/reference",
    },
    {
      reference: "steps.review.output.decision",
      path: "/additionalInputs/0/binding/reference",
    },
    {
      reference: "steps.review.output.ok",
      path: "/configuration/conditions/0/reference",
    },
  ]);

  const promptNode: FlowNodeDef = {
    id: "prompt",
    type: "generic_agent",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: {
      inputs: {},
      additionalInputs: [],
      configuration: {
        prompt:
          "Use {{data:steps.plan.output.plan}} and {{data:run.attempt}}.",
        promptSlotBindings: {
          ticket: {
            kind: "reference",
            reference: "steps.entry.output.ticket",
          },
        },
      },
    },
  };
  assert.deepEqual(collectFlowNodeReferences(promptNode), [
    {
      reference: "steps.plan.output.plan",
      path: "/configuration/prompt",
    },
    {
      reference: "run.attempt",
      path: "/configuration/prompt",
    },
    {
      reference: "steps.entry.output.ticket",
      path: "/configuration/promptSlotBindings/ticket/reference",
    },
  ]);
});

test("extracts only real step sources", () => {
  assert.equal(
    workflowReferenceSourceNodeId("steps.plan.output.value"),
    "plan",
  );
  assert.equal(
    workflowReferenceSourceNodeId("steps.entry.output.ticket"),
    null,
  );
  assert.equal(workflowReferenceSourceNodeId("run.attempt"), null);
  assert.equal(workflowReferenceSourceNodeId("trigger.ticket"), null);
});
