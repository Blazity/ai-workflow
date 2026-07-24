import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkflowDataCatalogEntry,
  WorkflowBlockContract,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import {
  canAddV2AdditionalInputName,
  V2BindingFields,
} from "./binding-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const contract: WorkflowBlockContract = {
  type: "generic_agent",
  presentation: {
    group: "agents",
    label: "Generic agent",
    description: "Runs an agent.",
    color: "#3C43E7",
    softColor: "#EEF0FF",
    glyph: "A",
  },
  defaults: {},
  ports: ["next"],
  allowsFailurePort: false,
  inputs: {
    plan: {
      required: true,
      schema: { type: "string" },
    },
  },
  additionalInputs: [
    {
      keyPattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
      schema: { type: "unknown" },
    },
  ],
  output: {
    schema: { type: "unknown" },
    bindingSchema: { type: "unknown" },
    statusVariants: ["ok"],
  },
  availability: { available: true, unavailableReason: null },
};

const node: WorkflowDefinitionV2Node = {
  id: "implementation",
  type: "generic_agent",
  x: 0,
  y: 0,
  configuration: {},
  inputs: {
    plan: {
      kind: "reference",
      reference: "steps.planning.output.plan",
    },
  },
  additionalInputs: [
    {
      name: "score",
      schema: { type: "number" },
      binding: { kind: "literal", value: 3 },
    },
  ],
};

const availableValues: WorkflowDataCatalogEntry[] = [
  {
    reference: "steps.planning.output.plan",
    label: "Planning · plan",
    description: "The approved implementation plan.",
    schema: { type: "string" },
    source: {
      kind: "step",
      nodeId: "planning",
    },
    presence: "required",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: ["plan"],
  },
  {
    reference: "steps.review.output.decision",
    label: "Review · decision",
    description: "A type-compatible value the worker did not approve for this input.",
    schema: { type: "string" },
    source: {
      kind: "step",
      nodeId: "review",
    },
    presence: "required",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: [],
  },
];

test("v2 bindings use worker labels and compatibility without client graph traversal", () => {
  const html = renderToStaticMarkup(
    <V2BindingFields
      node={node}
      contract={contract}
      availableValues={availableValues}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(html, /Input values/);
  assert.match(html, /Planning · plan/);
  assert.doesNotMatch(html, /Review · decision/);
  assert.match(html, /aria-label="Change Planning · plan"/);
  assert.match(html, /aria-label="score JSON Schema"/);
  assert.match(html, /aria-label="score literal JSON"/);
  assert.match(html, /Add typed input/);
});

test("v2 additional-input authoring accepts safe dotted names", () => {
  const existingNames = new Set(["checks.unit"]);

  for (const name of [
    "checks.lint",
    "checks.lint-2",
    "0.context_value",
  ]) {
    assert.equal(canAddV2AdditionalInputName(name, existingNames), true, name);
  }
  assert.equal(
    canAddV2AdditionalInputName("checks.unit", existingNames),
    false,
    "duplicate",
  );
});

test("v2 additional-input authoring rejects unsafe path segments", () => {
  const existingNames = new Set<string>();

  for (const name of [
    "",
    ".checks",
    "checks.",
    "checks..lint",
    " checks.lint",
    "checks.lint ",
    "checks lint",
    "checks/lint",
    "__proto__",
    "checks.__proto__",
    "prototype.value",
    "checks.constructor",
  ]) {
    assert.equal(canAddV2AdditionalInputName(name, existingNames), false, name);
  }
});
