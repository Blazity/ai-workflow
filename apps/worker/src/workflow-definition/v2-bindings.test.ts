import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  WorkflowDefinitionV2Node,
  WorkflowInputBindingV2,
} from "@shared/contracts";
import {
  parseWorkflowDataReferenceV2,
  resolveWorkflowDataReferenceV2,
  resolveWorkflowNodeInputsV2,
  resolveWorkflowPromptDataTokensV2,
  type V2BindingResolutionContext,
} from "./v2-bindings.js";

const entryOutput: BlockOutput = {
  status: "ok",
  ticket: { key: "AIW-120" },
};
const context: V2BindingResolutionContext = {
  entryOutput,
  runValues: {
    id: "run-1",
    nested: { branch: "ai-workflow/test" },
  },
  getStepOutput(nodeId) {
    return nodeId === "plan"
      ? { status: "ok", plan: { title: "Implement scheduler" } }
      : undefined;
  },
};

function node(
  inputs: Record<string, WorkflowInputBindingV2>,
  additionalInputs: WorkflowDefinitionV2Node["additionalInputs"] = [],
): Pick<WorkflowDefinitionV2Node, "inputs" | "additionalInputs"> {
  return { inputs, additionalInputs };
}

describe("v2 data bindings", () => {
  it("parses canonical entry, step, and run references", () => {
    expect(parseWorkflowDataReferenceV2("steps.entry.output")).toEqual({
      root: "entry",
      path: [],
    });
    expect(parseWorkflowDataReferenceV2("steps.entry.output.ticket.key")).toEqual({
      root: "entry",
      path: ["ticket", "key"],
    });
    expect(parseWorkflowDataReferenceV2("steps.plan.output")).toEqual({
      root: "steps",
      nodeId: "plan",
      path: [],
    });
    expect(parseWorkflowDataReferenceV2("steps.plan.output.plan.title")).toEqual({
      root: "steps",
      nodeId: "plan",
      path: ["plan", "title"],
    });
    expect(parseWorkflowDataReferenceV2("run.nested.branch")).toEqual({
      root: "run",
      path: ["nested", "branch"],
    });
  });

  it("rejects non-canonical and unsafe references", () => {
    expect(parseWorkflowDataReferenceV2("trigger.ticket")).toBeNull();
    expect(parseWorkflowDataReferenceV2("steps.plan.output.__proto__.x")).toBeNull();
    expect(parseWorkflowDataReferenceV2(" steps.plan.output.value")).toBeNull();
  });

  it("resolves literals, entry values, scoped step values, run values, and additional inputs", () => {
    expect(
      resolveWorkflowDataReferenceV2("steps.entry.output", context),
    ).toEqual(entryOutput);
    expect(
      resolveWorkflowDataReferenceV2("steps.plan.output", context),
    ).toEqual({ status: "ok", plan: { title: "Implement scheduler" } });
    expect(
      resolveWorkflowNodeInputsV2(
        node(
          {
            ticket: {
              kind: "reference",
              reference: "steps.entry.output.ticket.key",
            },
            plan: {
              kind: "reference",
              reference: "steps.plan.output.plan.title",
            },
            literal: { kind: "literal", value: { enabled: true } },
          },
          [
            {
              name: "branch",
              schema: { type: "string" },
              binding: { kind: "reference", reference: "run.nested.branch" },
            },
          ],
        ),
        context,
      ),
    ).toEqual({
      ticket: "AIW-120",
      plan: "Implement scheduler",
      literal: { enabled: true },
      branch: "ai-workflow/test",
    });
  });

  it("resolves canonical prompt data tokens with string and JSON values", () => {
    expect(
      resolveWorkflowPromptDataTokensV2(
        "Ticket {{data:steps.entry.output.ticket.key}}: {{data:steps.plan.output.plan}} on {{data:run.nested.branch}}",
        context,
      ),
    ).toBe(
      'Ticket AIW-120: {"title":"Implement scheduler"} on ai-workflow/test',
    );
  });

  it("fails instead of leaking an unresolved canonical prompt token", () => {
    expect(() =>
      resolveWorkflowPromptDataTokensV2(
        "{{data:steps.plan.output.missing}}",
        context,
      ),
    ).toThrow('binding "steps.plan.output.missing" could not be resolved');
  });

  it("does not expose inherited or missing object properties", () => {
    expect(() =>
      resolveWorkflowDataReferenceV2(
        "steps.plan.output.missing",
        context,
      ),
    ).toThrow('binding "steps.plan.output.missing" could not be resolved');
    expect(() =>
      resolveWorkflowDataReferenceV2(
        "steps.plan.output.constructor",
        context,
      ),
    ).toThrow();
  });

  it("rejects duplicate and unsafe input names", () => {
    expect(() =>
      resolveWorkflowNodeInputsV2(
        node(
          { plan: { kind: "literal", value: "one" } },
          [
            {
              name: "plan",
              schema: { type: "string" },
              binding: { kind: "literal", value: "two" },
            },
          ],
        ),
        context,
      ),
    ).toThrow('input name "plan" is declared more than once');
    expect(() =>
      resolveWorkflowNodeInputsV2(
        node({ "__proto__.value": { kind: "literal", value: true } }),
        context,
      ),
    ).toThrow('input name "__proto__.value" is not safe');
  });
});
