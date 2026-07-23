import { describe, expect, it } from "vitest";
import type { BlockOutput } from "@shared/contracts";
import {
  evaluateV2BranchCondition,
  isV2BranchBooleanAst,
  V2BranchEvaluationError,
  type V2BranchBooleanAst,
} from "./v2-branch.js";

const outputs: Record<string, BlockOutput> = {
  checks: {
    status: "ok",
    passed: true,
    outcome: "passed",
    count: 2,
    results: [],
  },
};
const context = {
  entryOutput: { status: "ok", provider: "github" },
  runValues: { branchName: "ai-workflow/test" },
  getStepOutput(nodeId: string) {
    return outputs[nodeId];
  },
};

describe("v2 Branch evaluation", () => {
  it("evaluates nested Boolean conditions and path operands", () => {
    const condition: V2BranchBooleanAst = {
      kind: "and",
      left: { kind: "path", reference: "steps.checks.output.passed" },
      right: {
        kind: "not",
        operand: {
          kind: "eq",
          left: { kind: "path", reference: "steps.entry.output.provider" },
          right: { kind: "lit", value: "gitlab" },
        },
      },
    };
    expect(evaluateV2BranchCondition(condition, context)).toBe(true);
  });

  it("supports equality and inequality across canonical roots", () => {
    expect(
      evaluateV2BranchCondition(
        {
          kind: "or",
          left: {
            kind: "neq",
            left: { kind: "path", reference: "steps.checks.output.outcome" },
            right: { kind: "lit", value: "failed" },
          },
          right: { kind: "lit", value: false },
        },
        context,
      ),
    ).toBe(true);
  });

  it("fails closed when a Boolean path has the wrong runtime type", () => {
    expect(() =>
      evaluateV2BranchCondition(
        { kind: "path", reference: "steps.checks.output.count" },
        context,
      ),
    ).toThrow(V2BranchEvaluationError);
  });

  it("recognizes the persisted AST shape and rejects malformed conditions", () => {
    expect(
      isV2BranchBooleanAst({
        kind: "eq",
        left: { kind: "path", reference: "steps.checks.output.outcome" },
        right: { kind: "lit", value: "passed" },
      }),
    ).toBe(true);
    expect(
      isV2BranchBooleanAst({
        kind: "not",
        operand: { kind: "lit", value: "not-a-boolean" },
      }),
    ).toBe(false);
    expect(
      isV2BranchBooleanAst({
        kind: "path",
        reference: "steps.checks.output.__proto__.value",
      }),
    ).toBe(false);
  });

  it("uses the same depth boundary for parsing and execution", () => {
    let maximumDepth: V2BranchBooleanAst = { kind: "lit", value: true };
    for (let depth = 0; depth < 16; depth += 1) {
      maximumDepth = { kind: "not", operand: maximumDepth };
    }
    expect(isV2BranchBooleanAst(maximumDepth)).toBe(true);
    expect(evaluateV2BranchCondition(maximumDepth, context)).toBe(true);

    const tooDeep = {
      kind: "not",
      operand: maximumDepth,
    } as const;
    expect(isV2BranchBooleanAst(tooDeep)).toBe(false);
    expect(() =>
      evaluateV2BranchCondition(tooDeep, context),
    ).toThrow(V2BranchEvaluationError);
  });

  it("fails closed when a comparison operand resolves outside the scalar domain", () => {
    expect(() =>
      evaluateV2BranchCondition(
        {
          kind: "eq",
          left: { kind: "path", reference: "steps.checks.output.results" },
          right: { kind: "lit", value: "passed" },
        },
        context,
      ),
    ).toThrow(
      "Branch comparison operands must resolve to primitive JSON values.",
    );
  });
});
