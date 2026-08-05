import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  JsonValue,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { executeV2Graph } from "../workflow-definition/v2-scheduler.js";

function node(
  id: string,
  type: WorkflowBlockType,
  configuration: Record<string, JsonValue> = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration,
    inputs: {},
    additionalInputs: [],
  };
}

const NO_CHANGE_PLAN: BlockOutput = {
  status: "ready",
  plan: "The ticket is already resolved, so no change is needed.",
};

describe("v2 terminal_success", () => {
  it("ends the walk as a completed no-op and skips everything downstream", async () => {
    const calls: string[] = [];
    const skipped: string[] = [];
    const finishes: Array<{
      nodeId: string;
      status: string;
      runtimeState: string;
      selectedTransition: unknown;
    }> = [];
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
      ],
      edges: [
        { id: "trigger-planning", from: "trigger", to: "planning" },
        { id: "planning-implementation", from: "planning", to: "implementation" },
      ],
    };

    const result = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      maxConcurrency: 1,
      hooks: {
        onNodeSkipped(event) {
          skipped.push(event.nodeId);
        },
        onNodeFinish(event) {
          finishes.push({
            nodeId: event.nodeId,
            status: event.state.status,
            runtimeState: event.runtimeState,
            selectedTransition: event.selectedTransition,
          });
        },
      },
      executeBlock: async (current) => {
        calls.push(current.id);
        if (current.id === "planning") {
          return { kind: "terminal_success", output: NO_CHANGE_PLAN };
        }
        return { kind: "next", output: { status: "completed" } };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["planning"]);
    expect(result.steps.planning?.output).toEqual(NO_CHANGE_PLAN);
    expect(result.steps.implementation).toBeUndefined();
    expect(result.state.scopes.root.nodeStates.implementation?.status).toBe(
      "skipped",
    );
    expect(result.state.scopes.root.edgeTokens["planning-implementation"]).toBe(
      "inactive",
    );
    expect(skipped).toEqual(["implementation"]);
    expect(finishes).toEqual([
      {
        nodeId: "planning",
        status: "ok",
        runtimeState: "completed",
        selectedTransition: null,
      },
    ]);
    expect(result.state.ended).toBe(false);
  });

  it("keeps a parallel sibling branch running to completion", async () => {
    const calls: string[] = [];
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("implementation", "implementation_agent"),
        node("sibling", "generic_agent"),
        node("after-sibling", "generic_agent"),
      ],
      edges: [
        { id: "trigger-planning", from: "trigger", to: "planning" },
        { id: "planning-implementation", from: "planning", to: "implementation" },
        { id: "trigger-sibling", from: "trigger", to: "sibling" },
        { id: "sibling-after", from: "sibling", to: "after-sibling" },
      ],
    };

    const result = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      maxConcurrency: 1,
      executeBlock: async (current) => {
        calls.push(current.id);
        if (current.id === "planning") {
          return { kind: "terminal_success", output: NO_CHANGE_PLAN };
        }
        return {
          kind: "next",
          output: { status: "completed", body: `${current.id} completed` },
        };
      },
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["planning", "sibling", "after-sibling"]);
    expect(result.steps.planning?.output).toEqual(NO_CHANGE_PLAN);
    expect(result.steps.sibling?.output.status).toBe("completed");
    expect(result.steps["after-sibling"]?.output.status).toBe("completed");
    expect(result.state.scopes.root.nodeStates.implementation?.status).toBe(
      "skipped",
    );
  });

  it("validates the terminating output against the declared contract", async () => {
    const result = await executeV2Graph({
      runId: "run-terminal-success-contract",
      definition: {
        nodes: [
          node("trigger", "trigger_ticket_ai"),
          node("planning", "planning_agent"),
          node("implementation", "implementation_agent"),
        ],
        edges: [
          { id: "trigger-planning", from: "trigger", to: "planning" },
          {
            id: "planning-implementation",
            from: "planning",
            to: "implementation",
          },
        ],
      },
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      executeBlock: async () => ({
        kind: "terminal_success",
        output: { status: "ready" },
      }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.executionError).toMatchObject({
      nodeId: "planning",
      category: "schema",
      phase: "contract",
    });
  });
});
