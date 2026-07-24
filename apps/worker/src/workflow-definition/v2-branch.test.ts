import { describe, expect, it } from "vitest";
import type {
  WorkflowBranchConfigurationV2,
  WorkflowDataReferenceV2,
} from "@shared/contracts";
import {
  evaluateV2BranchCondition,
  isV2BranchConfiguration,
  V2BranchEvaluationError,
} from "./v2-branch.js";

const context = {
  entryOutput: { status: "ok", text: "Hello WORLD", count: 4, ready: false, empty: "", nil: null },
  runValues: {},
  getStepOutput: () => undefined,
};

function branch(
  operator: WorkflowBranchConfigurationV2["conditions"][number]["operator"],
  value?: string | number | boolean,
  reference: WorkflowDataReferenceV2 = "steps.entry.output.text",
  ignoreCase?: boolean,
): WorkflowBranchConfigurationV2 {
  return {
    combinator: "all",
    conditions: [{ reference, operator, value, ignoreCase }],
  };
}

describe("v2 Branch", () => {
  it("validates the flat configuration contract", () => {
    expect(isV2BranchConfiguration(branch("equals", "Hello WORLD"))).toBe(true);
    expect(isV2BranchConfiguration({ combinator: "all", conditions: [] })).toBe(false);
    expect(
      isV2BranchConfiguration({
        combinator: "all",
        conditions: [{ reference: "steps.entry.output.text", operator: "has_value" }],
      }),
    ).toBe(true);
  });

  it.each([
    ["equals", "Hello WORLD", true],
    ["not_equals", "other", true],
    ["contains", "WORLD", true],
    ["not_contains", "missing", true],
  ] as const)("evaluates text %s", (operator, value, expected) => {
    expect(evaluateV2BranchCondition(branch(operator, value), context)).toBe(expected);
  });

  it("supports case-insensitive text comparisons", () => {
    expect(
      evaluateV2BranchCondition(branch("contains", "world", undefined, true), context),
    ).toBe(true);
  });

  it.each([
    ["equals", 4, true],
    ["not_equals", 3, true],
    ["greater_than", 3, true],
    ["greater_than_or_equal", 4, true],
    ["less_than", 5, true],
    ["less_than_or_equal", 4, true],
  ] as const)("evaluates number %s without coercion", (operator, value, expected) => {
    expect(
      evaluateV2BranchCondition(
        branch(operator, value, "steps.entry.output.count"),
        context,
      ),
    ).toBe(expected);
  });

  it("distinguishes missing/null from valid falsy values", () => {
    expect(evaluateV2BranchCondition(branch("has_value", undefined, "steps.entry.output.empty"), context)).toBe(true);
    expect(evaluateV2BranchCondition(branch("has_value", undefined, "steps.entry.output.ready"), context)).toBe(true);
    expect(evaluateV2BranchCondition(branch("has_no_value", undefined, "steps.entry.output.nil"), context)).toBe(true);
    expect(evaluateV2BranchCondition(branch("has_no_value", undefined, "steps.entry.output.missing"), context)).toBe(true);
  });

  it("uses global AND and OR semantics", () => {
    const conditions = [
      branch("contains", "Hello").conditions[0]!,
      branch("equals", 4, "steps.entry.output.count").conditions[0]!,
    ];
    expect(evaluateV2BranchCondition({ combinator: "all", conditions }, context)).toBe(true);
    expect(
      evaluateV2BranchCondition({
        combinator: "any",
        conditions: [branch("equals", "no").conditions[0]!, conditions[1]!],
      }, context),
    ).toBe(true);
  });

  it("rejects missing values for ordinary comparisons", () => {
    expect(() =>
      evaluateV2BranchCondition(
        branch("equals", "x", "steps.entry.output.missing"),
        context,
      ),
    ).toThrow(V2BranchEvaluationError);
  });
});
