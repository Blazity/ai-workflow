import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowBranchConfigurationV2,
  summarizeWorkflowBranchConfiguration,
} from "./branch-ast";

test("parses and summarizes a flat Branch condition list", () => {
  const parsed = parseWorkflowBranchConfigurationV2({
    combinator: "all",
    conditions: [{
      reference: "steps.entry.output.status",
      operator: "equals",
      value: "ready",
    }],
  });
  assert.ok(parsed);
  assert.equal(
    summarizeWorkflowBranchConfiguration(parsed),
    "equals ready",
  );
});

test("rejects the obsolete nested AST shape", () => {
  assert.equal(
    parseWorkflowBranchConfigurationV2({
      condition: { kind: "lit", value: true },
    }),
    null,
  );
});
