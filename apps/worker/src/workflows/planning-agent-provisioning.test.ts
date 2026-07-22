import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";

const mocks = vi.hoisted(() => ({
  ensureAgentSandbox: vi.fn(),
}));

vi.mock("./blocks/agent-sandbox.js", () => ({
  ensureAgentSandbox: mocks.ensureAgentSandbox,
}));

import {
  buildRuntimeGraph,
  executeGraph,
  type BlockExecutor,
  type ExecuteGraphHooks,
} from "../workflow-definition/interpreter.js";
import { ensurePlanningAgentSandboxForBlock } from "./agent.js";
import { makeCtx, runControlErrorCases } from "./blocks/test-support.js";

const node = (id: string, type: WorkflowDefinitionNode["type"]): WorkflowDefinitionNode => ({
  id,
  type,
  x: 0,
  y: 0,
  params: {},
  inputs: {},
});

describe("planning agent scratch provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a provisioning failure through the authored failed edge", async () => {
    mocks.ensureAgentSandbox.mockRejectedValueOnce(new Error("registry unavailable"));
    const ctx = makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() });
    const calls: string[] = [];
    const executor: BlockExecutor = async (block) => {
      calls.push(block.id);
      if (block.type === "planning_agent") {
        const provisioned = await ensurePlanningAgentSandboxForBlock(
          ctx,
          "claude",
          "claude-model",
        );
        if (provisioned.kind === "execution_error") return provisioned;
      }
      return { kind: "next", output: { status: "ok" } };
    };
    const failures: string[] = [];
    const hooks: ExecuteGraphHooks = {
      onBlockStart: async () => {},
      onBlockFinish: async () => {},
      clarificationExit: async () => {},
      failureExit: async (_phase, reason) => {
        failures.push(reason);
      },
      terminate: async () => {},
    };

    const result = await executeGraph({
      graph: buildRuntimeGraph({
        nodes: [
          node("trigger", "trigger_ticket_ai"),
          node("plan", "planning_agent"),
          node("recover", "post_ticket_comment"),
        ],
        edges: [
          { from: "trigger", to: "plan" },
          { from: "plan", to: "recover", fromPort: "failed" },
        ],
      }),
      entryTriggerId: "trigger",
      triggerOutput: { status: "ok" },
      executeBlock: executor,
      hooks,
      outputValidator: () => [],
    });

    expect(result.outcome).toBe("completed");
    expect(calls).toEqual(["plan", "recover"]);
    expect(result.steps.plan).toBeUndefined();
    expect(result.executionError?.diagnosticId).toBe(
      "AIW-DIAG-test-run-plan-1",
    );
    expect(failures).toEqual([
      "The workspace environment could not complete this block. (registry unavailable) Diagnostic ID: AIW-DIAG-test-run-plan-1",
    ]);
  });

  it.each(runControlErrorCases())(
    "rethrows %s instead of routing it through the authored failed edge",
    async (_label, error) => {
      mocks.ensureAgentSandbox.mockRejectedValueOnce(error);

      await expect(
        ensurePlanningAgentSandboxForBlock(
          makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() }),
          "claude",
          "claude-model",
        ),
      ).rejects.toBe(error);
    },
  );
});
