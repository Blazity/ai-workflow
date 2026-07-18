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
import { makeCtx } from "./blocks/test-support.js";

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
        if (provisioned.kind === "failed") return provisioned;
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
    expect(result.steps.plan.output).toEqual({ status: "failed" });
    expect(failures).toEqual([]);
  });
});
