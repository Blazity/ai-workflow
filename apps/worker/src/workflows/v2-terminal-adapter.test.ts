import { describe, expect, it } from "vitest";
import type {
  BlockOutput,
  JsonValue,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { executeV2Graph } from "../workflow-definition/v2-scheduler.js";
import { v2TerminalBlockResult } from "./agent.js";

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

function successfulGenericOutput(id: string): BlockOutput {
  return { status: "completed", body: `${id} completed` };
}

describe("v2 Terminate adapter and scheduler", () => {
  it.each(["done", "skipped"] as const)(
    "ends only its own %s path while sibling work completes",
    async (terminalStatus) => {
      const calls: string[] = [];
      const definition: WorkflowDefinitionV2 = {
        schemaVersion: 2,
        nodes: [
          node("trigger", "trigger_ticket_ai"),
          node("terminal", "terminate", { terminalStatus }),
          node("sibling", "generic_agent"),
        ],
        edges: [
          { id: "trigger-terminal", from: "trigger", to: "terminal" },
          { id: "trigger-sibling", from: "trigger", to: "sibling" },
        ],
      };

      const result = await executeV2Graph({
        definition,
        entryTriggerId: "trigger",
        triggerOutput: { status: "fired" },
        maxConcurrency: 1,
        executeBlock: async (current) => {
          calls.push(current.id);
          if (current.type === "terminate") {
            return v2TerminalBlockResult({ terminalStatus });
          }
          return {
            kind: "next",
            output: successfulGenericOutput(current.id),
          };
        },
      });

      expect(result.outcome).toBe("completed");
      expect(calls).toEqual(["terminal", "sibling"]);
      expect(result.steps.terminal?.output).toEqual({
        status: terminalStatus,
      });
      expect(result.steps.sibling?.output.status).toBe("completed");
    },
  );

  it("pauses and resumes waiting_for_human on the same terminal path", async () => {
    const definition: WorkflowDefinitionV2 = {
      schemaVersion: 2,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("terminal", "terminate", {
          terminalStatus: "waiting_for_human",
          postComment: "Choose the release window.",
        }),
      ],
      edges: [
        { id: "trigger-terminal", from: "trigger", to: "terminal" },
      ],
    };
    const executeBlock = async (
      current: WorkflowDefinitionV2Node,
      _steps: unknown,
      _inputs: unknown,
      invocation: { clarificationAnswer?: string },
    ) => v2TerminalBlockResult({
      terminalStatus: "waiting_for_human",
      postComment: String(current.configuration.postComment),
      ...(invocation.clarificationAnswer === undefined
        ? {}
        : { clarificationAnswer: invocation.clarificationAnswer }),
    });

    const paused = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      executeBlock,
    });
    expect(paused.outcome).toBe("paused");
    expect(paused.clarification?.questions).toEqual([
      "Choose the release window.",
    ]);

    const resumed = await executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      executeBlock,
      resume: {
        checkpoint: paused.state,
        clarificationAnswer: "Tomorrow",
      },
    });
    expect(resumed.outcome).toBe("completed");
    expect(resumed.steps.terminal?.output).toEqual({ status: "done" });
    expect(resumed.state.attempts.terminal).toBe(2);
  });

  it("hands failed termination to the scheduler as the primary run failure", async () => {
    const result = await executeV2Graph({
      runId: "run-terminal-failure",
      definition: {
        nodes: [
          node("trigger", "trigger_ticket_ai"),
          node("terminal", "terminate", {
            terminalStatus: "failed",
            postComment: "The acceptance gate failed.",
          }),
        ],
        edges: [
          { id: "trigger-terminal", from: "trigger", to: "terminal" },
        ],
      },
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      executeBlock: async () => v2TerminalBlockResult({
        terminalStatus: "failed",
        postComment: "The acceptance gate failed.",
      }),
    });

    expect(result.outcome).toBe("failed");
    expect(result.executionError).toMatchObject({
      nodeId: "terminal",
      attempt: 1,
      phase: "terminate",
      diagnosticId: "AIW-DIAG-run-terminal-failure-terminal-1",
    });
  });
});
