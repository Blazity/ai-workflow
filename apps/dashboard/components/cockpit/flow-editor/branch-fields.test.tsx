import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowAvailableValue } from "@shared/contracts";
import { BranchFields } from "./branch-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const availableValues: WorkflowAvailableValue[] = [
  {
    reference: "steps.review.output.decision",
    label: "Review · decision",
    description: "Review decision",
    schema: {
      type: "string",
      enum: ["approve", "request_changes"],
    },
    source: {
      kind: "step",
      nodeId: "review",
      blockType: "review_agent",
    },
    guarantee: {
      kind: "unconditional_activation",
      triggerNodeIds: ["trigger"],
      viaEdgeIds: ["review-decision"],
    },
    compatibleInputNames: [],
  },
  {
    reference: "steps.checks.output.ok",
    label: "Checks · ok",
    description: "Check result",
    schema: { type: "boolean" },
    source: {
      kind: "step",
      nodeId: "checks",
      blockType: "run_checks",
    },
    guarantee: {
      kind: "unconditional_activation",
      triggerNodeIds: ["trigger"],
      viaEdgeIds: ["checks-decision"],
    },
    compatibleInputNames: [],
  },
];

test("Branch editor renders nested typed controls and enum choices", () => {
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{
        condition: {
          kind: "and",
          left: {
            kind: "eq",
            left: {
              kind: "path",
              reference: "steps.review.output.decision",
            },
            right: { kind: "lit", value: "approve" },
          },
          right: {
            kind: "not",
            operand: {
              kind: "path",
              reference: "steps.checks.output.ok",
            },
          },
        },
      }}
      availableValues={availableValues}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(html, /Branch decision/);
  assert.match(html, /All conditions/);
  assert.match(html, /Values are equal/);
  assert.match(html, /Review · decision/);
  assert.match(html, /approve/);
  assert.match(html, /request_changes/);
  assert.match(html, /Checks · ok/);
});

test("Branch editor preserves an unavailable path instead of replacing it", () => {
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{
        condition: {
          kind: "eq",
          left: {
            kind: "path",
            reference: "steps.old-review.output.decision",
          },
          right: { kind: "lit", value: "approve" },
        },
      }}
      availableValues={availableValues}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(
    html,
    /Unavailable: steps\.old-review\.output\.decision/,
  );
  assert.match(html, /value="steps\.old-review\.output\.decision" selected=""/);
});

test("Branch editor leaves malformed raw configuration untouched until replacement", () => {
  let changes = 0;
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{
        condition: {
          kind: "shell",
          command: "must remain untouched",
        },
      }}
      availableValues={availableValues}
      canEdit
      onChange={() => {
        changes += 1;
      }}
    />,
  );

  assert.match(html, /data-branch-configuration="preserved-invalid"/);
  assert.match(html, /remains unchanged until you replace it/);
  assert.match(html, /Replace with visual condition/);
  assert.equal(changes, 0);
});
