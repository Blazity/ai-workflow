import type {
  WorkflowBranchConditionV2,
  WorkflowBranchConfigurationV2,
} from "@shared/contracts";
import {
  parseWorkflowDataReferenceV2,
  resolveWorkflowDataReferenceV2,
  type V2BindingResolutionContext,
} from "./v2-bindings.js";

const PRESENCE_OPERATORS = new Set(["has_value", "has_no_value"]);

export class V2BranchEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2BranchEvaluationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function isV2BranchConfiguration(
  value: unknown,
): value is WorkflowBranchConfigurationV2 {
  if (
    !isRecord(value) ||
    (value.combinator !== "all" && value.combinator !== "any") ||
    !Array.isArray(value.conditions) ||
    value.conditions.length === 0 ||
    value.conditions.length > 100 ||
    Object.keys(value).some(
      (key) => key !== "combinator" && key !== "conditions",
    )
  ) {
    return false;
  }
  return value.conditions.every((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.reference !== "string" ||
      parseWorkflowDataReferenceV2(candidate.reference) === null ||
      typeof candidate.operator !== "string"
    ) {
      return false;
    }
    const presence = PRESENCE_OPERATORS.has(candidate.operator);
    const validOperator = [
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "has_value",
      "has_no_value",
    ].includes(candidate.operator);
    if (!validOperator) return false;
    if (presence) {
      return (
        candidate.value === undefined &&
        candidate.ignoreCase === undefined &&
        Object.keys(candidate).every(
          (key) => key === "reference" || key === "operator",
        )
      );
    }
    return (
      isScalar(candidate.value) &&
      (candidate.ignoreCase === undefined ||
        typeof candidate.ignoreCase === "boolean") &&
      Object.keys(candidate).every(
        (key) =>
          key === "reference" ||
          key === "operator" ||
          key === "value" ||
          key === "ignoreCase",
      )
    );
  });
}

function resolveConditionValue(
  condition: WorkflowBranchConditionV2,
  context: V2BindingResolutionContext,
): { present: boolean; value: string | number | boolean | null } {
  try {
    const value = resolveWorkflowDataReferenceV2(
      condition.reference,
      context,
    );
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new V2BranchEvaluationError(
        `Branch reference "${condition.reference}" did not resolve to a scalar value.`,
      );
    }
    return { present: value !== null, value };
  } catch (error) {
    if (PRESENCE_OPERATORS.has(condition.operator)) {
      return { present: false, value: null };
    }
    if (error instanceof V2BranchEvaluationError) throw error;
    throw new V2BranchEvaluationError(
      `Branch reference "${condition.reference}" could not be resolved.`,
    );
  }
}

function textPair(
  actual: string | number | boolean | null,
  expected: string | number | boolean | undefined,
  ignoreCase: boolean,
): [string, string] {
  if (typeof actual !== "string" || typeof expected !== "string") {
    throw new V2BranchEvaluationError(
      "Branch text operators require text values.",
    );
  }
  return ignoreCase
    ? [actual.toLocaleLowerCase("en-US"), expected.toLocaleLowerCase("en-US")]
    : [actual, expected];
}

function evaluateCondition(
  condition: WorkflowBranchConditionV2,
  context: V2BindingResolutionContext,
): boolean {
  const resolved = resolveConditionValue(condition, context);
  if (condition.operator === "has_value") return resolved.present;
  if (condition.operator === "has_no_value") return !resolved.present;
  const expected = condition.value;
  if (expected === undefined) {
    throw new V2BranchEvaluationError(
      `Branch operator "${condition.operator}" requires a comparison value.`,
    );
  }
  switch (condition.operator) {
    case "equals":
    case "not_equals": {
      let equal: boolean;
      if (
        condition.ignoreCase &&
        typeof resolved.value === "string" &&
        typeof expected === "string"
      ) {
        const [left, right] = textPair(resolved.value, expected, true);
        equal = left === right;
      } else {
        equal = resolved.value === expected;
      }
      return condition.operator === "equals" ? equal : !equal;
    }
    case "contains":
    case "not_contains": {
      const [left, right] = textPair(
        resolved.value,
        expected,
        condition.ignoreCase === true,
      );
      const contains = left.includes(right);
      return condition.operator === "contains" ? contains : !contains;
    }
    case "greater_than":
    case "greater_than_or_equal":
    case "less_than":
    case "less_than_or_equal": {
      if (
        typeof resolved.value !== "number" ||
        typeof expected !== "number"
      ) {
        throw new V2BranchEvaluationError(
          "Branch ordered comparisons require number values.",
        );
      }
      if (condition.operator === "greater_than") {
        return resolved.value > expected;
      }
      if (condition.operator === "greater_than_or_equal") {
        return resolved.value >= expected;
      }
      if (condition.operator === "less_than") {
        return resolved.value < expected;
      }
      return resolved.value <= expected;
    }
  }
}

export function evaluateV2BranchCondition(
  configuration: WorkflowBranchConfigurationV2,
  context: V2BindingResolutionContext,
): boolean {
  if (configuration.conditions.length === 0) {
    throw new V2BranchEvaluationError(
      "Branch requires at least one condition.",
    );
  }
  return configuration.combinator === "all"
    ? configuration.conditions.every((condition) =>
        evaluateCondition(condition, context),
      )
    : configuration.conditions.some((condition) =>
        evaluateCondition(condition, context),
      );
}
