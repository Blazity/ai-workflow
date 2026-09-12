import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowBranchConfigurationV2 } from "@shared/contracts";
import {
  evaluateV2BranchCondition,
  isV2BranchConfiguration,
  V2BranchEvaluationError,
  type V2BindingResolutionContext,
} from "./index";

const context: V2BindingResolutionContext = {
  entryOutput: { status: "ok", text: "Hello WORLD", count: 4 },
  runValues: {},
  getStepOutput: () => undefined,
};

const configuration = (
  condition: Record<string, unknown>,
): WorkflowBranchConfigurationV2 =>
  ({
    combinator: "all",
    conditions: [condition],
  }) as unknown as WorkflowBranchConfigurationV2;

test("isV2BranchConfiguration accepts a well formed configuration and rejects a malformed one", () => {
  assert.equal(
    isV2BranchConfiguration({
      combinator: "all",
      conditions: [
        {
          reference: "steps.entry.output.status",
          operator: "equals",
          value: "ok",
        },
      ],
    }),
    true,
  );
  assert.equal(
    isV2BranchConfiguration({
      combinator: "sometimes",
      conditions: [],
    }),
    false,
  );
});

test("evaluateV2BranchCondition resolves a reference against the binding context", () => {
  assert.equal(
    evaluateV2BranchCondition(
      configuration({
        reference: "steps.entry.output.status",
        operator: "equals",
        value: "ok",
      }),
      context,
    ),
    true,
  );
  assert.equal(
    evaluateV2BranchCondition(
      configuration({
        reference: "steps.entry.output.count",
        operator: "greater_than",
        value: 10,
      }),
      context,
    ),
    false,
  );
});

test("V2BranchEvaluationError reports a reference that does not resolve to a scalar", () => {
  assert.throws(
    () =>
      evaluateV2BranchCondition(
        configuration({
          reference: "steps.entry.output.missing",
          operator: "equals",
          value: "ok",
        }),
        context,
      ),
    (error: unknown) =>
      error instanceof V2BranchEvaluationError &&
      /could not be resolved/.test(error.message),
  );
});
