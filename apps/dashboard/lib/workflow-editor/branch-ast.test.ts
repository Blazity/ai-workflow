import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDataCatalogEntry } from "@shared/contracts";
import {
  branchConditionForKind,
  branchLiteralForSchema,
  isWorkflowBranchBooleanAstV2,
  parseWorkflowBranchConfigurationV2,
  summarizeWorkflowBranchCondition,
} from "./branch-ast";

const values: WorkflowDataCatalogEntry[] = [
  {
    reference: "steps.review.output.decision",
    label: "Review · decision",
    description: "Review decision",
    schema: {
      type: "string",
      enum: ["approve", "request_changes"],
    },
    source: { kind: "step", nodeId: "review" },
    presence: "required",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: [],
  },
  {
    reference: "steps.check.output.ok",
    label: "Checks · ok",
    description: "Check result",
    schema: { type: "boolean" },
    source: { kind: "step", nodeId: "check" },
    presence: "required",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: [],
  },
];

test("Branch AST guards preserve malformed stored configuration", () => {
  assert.equal(
    parseWorkflowBranchConfigurationV2({
      condition: { kind: "shell", command: "echo nope" },
    }),
    null,
  );
  assert.equal(
    isWorkflowBranchBooleanAstV2({
      kind: "eq",
      left: { kind: "path", reference: "steps.review.output.decision" },
      right: { kind: "lit", value: "approve" },
    }),
    true,
  );
});

test("Branch kind changes produce typed nested ASTs from the worker catalog", () => {
  assert.deepEqual(branchConditionForKind("path", values), {
    kind: "path",
    reference: "steps.check.output.ok",
  });
  assert.deepEqual(branchConditionForKind("eq", values), {
    kind: "eq",
    left: {
      kind: "path",
      reference: "steps.review.output.decision",
    },
    right: { kind: "lit", value: "approve" },
  });
  assert.deepEqual(branchConditionForKind("and", values), {
    kind: "and",
    left: {
      kind: "path",
      reference: "steps.check.output.ok",
    },
    right: {
      kind: "path",
      reference: "steps.check.output.ok",
    },
  });
});

test("Branch literals and summaries use schema enum metadata", () => {
  assert.equal(
    branchLiteralForSchema({
      type: "string",
      enum: ["approve", "request_changes"],
    }),
    "approve",
  );
  assert.equal(
    summarizeWorkflowBranchCondition(
      {
        kind: "eq",
        left: {
          kind: "path",
          reference: "steps.review.output.decision",
        },
        right: { kind: "lit", value: "approve" },
      },
      values,
    ),
    'Review · decision equals "approve"',
  );
});
