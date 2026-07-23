import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  JsonValue,
  PromptSlotDefinition,
  WorkflowAvailableValue,
} from "@shared/contracts";
import {
  aggregatePromptSlotSchemaDraftState,
  promptSlotSchemaDraftBlocksSave,
  promptSlotSchemaDraftMarksDirty,
  PromptSlotBindingsEditor,
  PromptSlotDefinitionsEditor,
  promptSlotBindingsFromConfiguration,
} from "./prompt-slot-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const definitions: PromptSlotDefinition[] = [
  {
    name: "plan",
    description: "Approved implementation plan",
    schema: { type: "string" },
    required: true,
  },
  {
    name: "tone",
    description: "Writing tone",
    schema: { type: "string", enum: ["short", "detailed"] },
    required: false,
    defaultValue: "short",
  },
];

const availableValues: WorkflowAvailableValue[] = [
  {
    reference: "steps.planning.output.plan",
    label: "Planning · plan",
    description: "The approved implementation plan.",
    schema: { type: "string" },
    source: {
      kind: "step",
      nodeId: "planning",
      blockType: "planning_agent",
    },
    guarantee: {
      kind: "unconditional_activation",
      triggerNodeIds: ["trigger"],
      viaEdgeIds: ["planning-to-implementation"],
    },
    compatibleInputNames: [],
  },
];

test("slot definition UI exposes names, schemas, defaults, and add/remove controls", () => {
  const html = renderToStaticMarkup(
    <PromptSlotDefinitionsEditor
      slots={definitions}
      disabled={false}
      onChange={() => undefined}
    />,
  );

  assert.match(html, /Prompt slots/);
  assert.match(html, /Approved implementation plan/);
  assert.match(html, /aria-label="plan type"/);
  assert.match(html, /aria-label="tone default JSON"/);
  assert.match(html, /\+ Add slot/);
  assert.match(html, /Advanced schema/);
  assert.match(html, />Remove</);
});

test("slot binding UI uses worker labels and supports literals and defaults", () => {
  const html = renderToStaticMarkup(
    <PromptSlotBindingsEditor
      definitions={definitions}
      bindings={{
        plan: {
          kind: "reference",
          reference: "steps.planning.output.plan",
        },
        tone: { kind: "literal", value: "detailed" },
      }}
      availableValues={availableValues}
      disabled={false}
      onChange={() => undefined}
    />,
  );

  assert.match(html, /Prompt slot values/);
  assert.match(html, /Planning · plan/);
  assert.match(html, /aria-label="plan workflow value"/);
  assert.match(html, /aria-label="tone literal JSON"/);
  assert.match(html, /Default available/);
});

test("slot binding reader keeps valid bindings and ignores malformed saved values", () => {
  const configuration = {
    promptSlotBindings: {
      plan: {
        kind: "reference",
        reference: "steps.planning.output.plan",
      },
      literal: { kind: "literal", value: { nested: true } },
      invalid: { kind: "reference", reference: "steps.missing.value" },
    },
  } as unknown as Record<string, JsonValue>;

  assert.deepEqual(promptSlotBindingsFromConfiguration(configuration), {
    plan: {
      kind: "reference",
      reference: "steps.planning.output.plan",
    },
    literal: { kind: "literal", value: { nested: true } },
  });
});

test("slot schema draft state blocks save and retains invalid uncommitted raw input", () => {
  const keys = ["0:plan", "1:tone"];
  assert.deepEqual(aggregatePromptSlotSchemaDraftState(keys, {}), {
    state: "checking",
    hasUncommittedInvalidSource: false,
  });
  assert.deepEqual(
    aggregatePromptSlotSchemaDraftState(keys, {
      "0:plan": {
        state: "valid",
        hasUncommittedInvalidSource: false,
      },
      "1:tone": {
        state: "invalid",
        hasUncommittedInvalidSource: true,
      },
    }),
    {
      state: "invalid",
      hasUncommittedInvalidSource: true,
    },
  );
  assert.deepEqual(
    aggregatePromptSlotSchemaDraftState(keys, {
      "0:plan": {
        state: "valid",
        hasUncommittedInvalidSource: false,
      },
      "1:tone": {
        state: "valid",
        hasUncommittedInvalidSource: false,
      },
    }),
    {
      state: "valid",
      hasUncommittedInvalidSource: false,
    },
  );
  assert.equal(
    promptSlotSchemaDraftBlocksSave({
      state: "invalid",
      hasUncommittedInvalidSource: true,
    }),
    true,
  );
  assert.equal(
    promptSlotSchemaDraftMarksDirty({
      state: "invalid",
      hasUncommittedInvalidSource: true,
    }),
    true,
  );
  assert.equal(
    promptSlotSchemaDraftBlocksSave({
      state: "valid",
      hasUncommittedInvalidSource: false,
    }),
    false,
  );
});
