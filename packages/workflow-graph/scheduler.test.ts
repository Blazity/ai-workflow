/**
 * The seam stage 12-6b added, and only that: the walk answers the two questions
 * it cannot judge through `SchedulerDependencies`.
 *
 * Everything else the scheduler does is covered, unchanged, by
 * `apps/worker/src/workflow-graph-suites/v2-scheduler.test.ts` and the scenario
 * suites, which run it against the worker's real ajv-backed validators. What
 * they cannot show is that the verdict comes from the injected object rather
 * than from something this package reached for, which is what these three
 * prove.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { executeV2Graph, type SchedulerDependencies } from "./index";

function node(
  id: string,
  type: WorkflowDefinitionV2Node["type"],
  configuration: WorkflowDefinitionV2Node["configuration"] = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration:
      type === "generic_agent"
        ? { workspaceMode: "none", ...configuration }
        : configuration,
    inputs: {},
    additionalInputs: [],
  };
}

const definition: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  nodes: [node("trigger", "trigger_ticket_ai"), node("work", "generic_agent")],
  edges: [{ id: "trigger-work", from: "trigger", to: "work" }],
};

const permissive: SchedulerDependencies = {
  validateBlockOutput: () => [],
  validateJsonSchemaValue: () => [],
};

test("a clean block output passes when the injected validator reports nothing", async () => {
  const seen: string[] = [];
  const result = await executeV2Graph({
    dependencies: {
      ...permissive,
      validateBlockOutput: (type) => {
        seen.push(type);
        return [];
      },
    },
    definition,
    entryTriggerId: "trigger",
    triggerOutput: { status: "ok" },
    executeBlock: async () => ({
      kind: "next",
      output: { status: "completed", body: "done" },
    }),
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(seen, ["generic_agent"]);
});

test("the walk fails on the complaint the injected validator returns", async () => {
  const result = await executeV2Graph({
    dependencies: {
      ...permissive,
      validateBlockOutput: () => ["body must be a haiku"],
    },
    definition,
    entryTriggerId: "trigger",
    triggerOutput: { status: "ok" },
    executeBlock: async () => ({
      kind: "next",
      output: { status: "completed", body: "done" },
    }),
  });

  assert.equal(result.outcome, "failed");
  assert.match(
    result.executionError?.message ?? "",
    /body must be a haiku/,
  );
});

/** A loop whose carried value is the only thing the walk hands to a schema. */
const loopDefinition: WorkflowDefinitionV2 = {
  schemaVersion: 2,
  nodes: [
    node("trigger", "trigger_ticket_ai"),
    node("work", "generic_agent"),
    node("retry", "loop", {
      maxAttempts: 2,
      onExhaust: "fail",
      carry: [
        {
          name: "reviewBody",
          schema: { type: "string" },
          binding: {
            kind: "reference",
            reference: "steps.work.output.body",
          },
        },
      ],
    }),
    node("fix", "generic_agent"),
  ],
  edges: [
    { id: "trigger-work", from: "trigger", to: "work" },
    { id: "work-retry", from: "work", to: "retry" },
    { id: "retry-fix", from: "retry", fromPort: "continue", to: "fix" },
    { id: "fix-work", from: "fix", to: "work" },
  ],
};

test("the walk fails on the issue the injected schema validator returns", async () => {
  const seen: { schema: unknown; value: unknown }[] = [];
  const result = await executeV2Graph({
    dependencies: {
      ...permissive,
      validateJsonSchemaValue: (schema, value) => {
        seen.push({ schema, value });
        return [
          { code: "invalid_value", path: "", message: "must be a number" },
        ];
      },
    },
    definition: loopDefinition,
    entryTriggerId: "trigger",
    triggerOutput: { status: "ok" },
    executeBlock: async () => ({
      kind: "next",
      output: { status: "completed", body: "done" },
    }),
  });

  assert.equal(result.outcome, "failed");
  assert.deepEqual(seen, [{ schema: { type: "string" }, value: "done" }]);
  // The walk names the carried value rather than quoting the issue: it counts
  // the issues the injected validator returns and keeps their text private.
  assert.match(
    result.executionError?.message ?? "",
    /loop "retry" carried value "reviewBody" does not match its schema/,
  );
});
