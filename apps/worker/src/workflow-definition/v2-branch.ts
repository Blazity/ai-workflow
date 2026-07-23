import type { JsonValue, WorkflowDataReferenceV2 } from "@shared/contracts";
import {
  parseWorkflowDataReferenceV2,
  resolveWorkflowDataReferenceV2,
  type V2BindingResolutionContext,
} from "./v2-bindings.js";

export type V2BranchLiteralOperand = {
  kind: "lit";
  value: string | number | boolean | null;
};

export type V2BranchPathOperand = {
  kind: "path";
  reference: WorkflowDataReferenceV2;
};

export type V2BranchOperand = V2BranchLiteralOperand | V2BranchPathOperand;

export type V2BranchBooleanAst =
  | { kind: "lit"; value: boolean }
  | V2BranchPathOperand
  | { kind: "not"; operand: V2BranchBooleanAst }
  | {
      kind: "and" | "or";
      left: V2BranchBooleanAst;
      right: V2BranchBooleanAst;
    }
  | {
      kind: "eq" | "neq";
      left: V2BranchOperand;
      right: V2BranchOperand;
    };

export class V2BranchEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2BranchEvaluationError";
  }
}

export const V2_BRANCH_MAX_DEPTH = 16;
export const V2_BRANCH_MAX_NODES = 100;

export function v2BranchConditionComplexityMessage(
  value: JsonValue | undefined,
): string | null {
  if (value === undefined) return null;
  const stack: Array<{ value: JsonValue; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > V2_BRANCH_MAX_NODES) {
      return `condition must contain at most ${V2_BRANCH_MAX_NODES} operations.`;
    }
    if (current.depth > V2_BRANCH_MAX_DEPTH) {
      return `condition must be at most ${V2_BRANCH_MAX_DEPTH} levels deep.`;
    }
    if (
      current.value === null ||
      Array.isArray(current.value) ||
      typeof current.value !== "object"
    ) {
      continue;
    }
    if (current.value.kind === "not" && current.value.operand !== undefined) {
      stack.push({
        value: current.value.operand,
        depth: current.depth + 1,
      });
    } else if (
      (current.value.kind === "and" || current.value.kind === "or") &&
      current.value.left !== undefined &&
      current.value.right !== undefined
    ) {
      stack.push({
        value: current.value.left,
        depth: current.depth + 1,
      });
      stack.push({
        value: current.value.right,
        depth: current.depth + 1,
      });
    }
  }
  return null;
}

function primitive(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new V2BranchEvaluationError(
    "Branch comparison operands must resolve to primitive JSON values.",
  );
}

function operandValue(
  operand: V2BranchOperand,
  context: V2BindingResolutionContext,
): string | number | boolean | null {
  return operand.kind === "lit"
    ? operand.value
    : primitive(resolveWorkflowDataReferenceV2(operand.reference, context));
}

function evaluate(
  condition: V2BranchBooleanAst,
  context: V2BindingResolutionContext,
  depth: number,
  budget: { nodes: number },
): boolean {
  budget.nodes += 1;
  if (
    depth > V2_BRANCH_MAX_DEPTH ||
    budget.nodes > V2_BRANCH_MAX_NODES
  ) {
    throw new V2BranchEvaluationError("Branch condition is too complex.");
  }
  switch (condition.kind) {
    case "lit":
      return condition.value;
    case "path": {
      const value = resolveWorkflowDataReferenceV2(condition.reference, context);
      if (typeof value !== "boolean") {
        throw new V2BranchEvaluationError(
          `Branch path "${condition.reference}" did not resolve to a Boolean.`,
        );
      }
      return value;
    }
    case "not":
      return !evaluate(condition.operand, context, depth + 1, budget);
    case "and":
      return (
        evaluate(condition.left, context, depth + 1, budget) &&
        evaluate(condition.right, context, depth + 1, budget)
      );
    case "or":
      return (
        evaluate(condition.left, context, depth + 1, budget) ||
        evaluate(condition.right, context, depth + 1, budget)
      );
    case "eq":
      return operandValue(condition.left, context) === operandValue(condition.right, context);
    case "neq":
      return operandValue(condition.left, context) !== operandValue(condition.right, context);
  }
}

export function evaluateV2BranchCondition(
  condition: V2BranchBooleanAst,
  context: V2BindingResolutionContext,
): boolean {
  return evaluate(condition, context, 0, { nodes: 0 });
}

export function isV2BranchBooleanAst(value: JsonValue): value is V2BranchBooleanAst {
  if (v2BranchConditionComplexityMessage(value) !== null) return false;
  const isRecord = (
    candidate: JsonValue | undefined,
  ): candidate is Record<string, JsonValue> =>
    candidate !== undefined &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    typeof candidate === "object";
  const hasExactKeys = (
    candidate: Record<string, JsonValue>,
    keys: readonly string[],
  ): boolean => {
    const actual = Object.keys(candidate).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
    );
  };
  const isPath = (
    candidate: JsonValue | undefined,
  ): candidate is V2BranchPathOperand =>
    isRecord(candidate) &&
    hasExactKeys(candidate, ["kind", "reference"]) &&
    candidate.kind === "path" &&
    typeof candidate.reference === "string" &&
    parseWorkflowDataReferenceV2(candidate.reference) !== null;
  const isLiteralOperand = (
    candidate: JsonValue | undefined,
  ): candidate is V2BranchLiteralOperand =>
    isRecord(candidate) &&
    hasExactKeys(candidate, ["kind", "value"]) &&
    candidate.kind === "lit" &&
    (candidate.value === null ||
      typeof candidate.value === "string" ||
      typeof candidate.value === "number" ||
      typeof candidate.value === "boolean");

  try {
    const visit = (candidate: JsonValue, depth: number, budget: { nodes: number }): void => {
      budget.nodes += 1;
      if (
        depth > V2_BRANCH_MAX_DEPTH ||
        budget.nodes > V2_BRANCH_MAX_NODES ||
        !isRecord(candidate)
      ) {
        throw new Error("invalid");
      }
      const kind = candidate.kind;
      if (
        kind === "lit" &&
        hasExactKeys(candidate, ["kind", "value"]) &&
        typeof candidate.value === "boolean"
      ) {
        return;
      }
      if (isPath(candidate)) return;
      if (kind === "not" && hasExactKeys(candidate, ["kind", "operand"])) {
        visit(candidate.operand as JsonValue, depth + 1, budget);
        return;
      }
      if (
        (kind === "and" || kind === "or") &&
        hasExactKeys(candidate, ["kind", "left", "right"])
      ) {
        visit(candidate.left as JsonValue, depth + 1, budget);
        visit(candidate.right as JsonValue, depth + 1, budget);
        return;
      }
      if (
        (kind === "eq" || kind === "neq") &&
        hasExactKeys(candidate, ["kind", "left", "right"])
      ) {
        for (const operand of [candidate.left, candidate.right]) {
          if (!isPath(operand) && !isLiteralOperand(operand)) {
            throw new Error("invalid");
          }
        }
        return;
      }
      throw new Error("invalid");
    };
    visit(value, 0, { nodes: 0 });
    return true;
  } catch {
    return false;
  }
}
