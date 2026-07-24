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
import {
  ensurePlanningAgentSandboxForBlock,
  ensurePlanningWorkspaceForBlock,
} from "./agent.js";
import { maybePromoteTicketWorkspaceWrites } from "./blocks/prepare-workspace.js";
import type { WorkspaceManifestV2 } from "../sandbox/repo-workspace.js";
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

  it("requests an unshared scratch sandbox for a v2 planning invocation", async () => {
    mocks.ensureAgentSandbox.mockResolvedValueOnce("scratch-v2");
    const ctx = makeCtx({ schemaVersion: 2 });

    await expect(
      ensurePlanningAgentSandboxForBlock(
        ctx,
        "claude",
        "claude-model",
        true,
      ),
    ).resolves.toEqual({ kind: "ready", sandboxId: "scratch-v2" });

    expect(mocks.ensureAgentSandbox).toHaveBeenCalledWith(
      ctx,
      "claude",
      "claude-model",
      { reuse: false },
    );
  });

  it("retains provider-keyed scratch reuse for v1 planning", async () => {
    mocks.ensureAgentSandbox.mockResolvedValueOnce("scratch-v1");
    const ctx = makeCtx({ schemaVersion: 1 });

    await ensurePlanningAgentSandboxForBlock(ctx, "claude", "claude-model");

    expect(mocks.ensureAgentSandbox).toHaveBeenCalledWith(
      ctx,
      "claude",
      "claude-model",
    );
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

describe("planning agent shared workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses an explicitly prepared workspace without preparing again", async () => {
    const ctx = makeCtx({ sandboxId: "workspace-v2" });
    const prepare = vi.fn();

    await expect(
      ensurePlanningWorkspaceForBlock(ctx, undefined, prepare),
    ).resolves.toEqual({ kind: "ready", sandboxId: "workspace-v2" });

    expect(prepare).not.toHaveBeenCalled();
  });

  it("implicitly prepares a workspace for planning-first definitions", async () => {
    const ctx = makeCtx({ schemaVersion: 1, sandboxId: null });
    const prepare = vi.fn(async () => {
      ctx.sandboxId = "workspace-v1";
      return { kind: "next", output: { status: "ok" } } as const;
    });

    await expect(
      ensurePlanningWorkspaceForBlock(ctx, undefined, prepare),
    ).resolves.toEqual({ kind: "ready", sandboxId: "workspace-v1" });

    expect(prepare).toHaveBeenCalledOnce();
  });

  it("passes preparation clarification through without provisioning scratch", async () => {
    const ctx = makeCtx({ sandboxId: null });
    const clarification = {
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        questions: ["Which repository?"],
      },
      questions: ["Which repository?"],
    } as const;
    const prepare = vi.fn().mockResolvedValue(clarification);

    await expect(
      ensurePlanningWorkspaceForBlock(ctx, undefined, prepare),
    ).resolves.toEqual({ kind: "exit", result: clarification });

    expect(mocks.ensureAgentSandbox).not.toHaveBeenCalled();
  });

  // Regression guard for AIW-147: a planning graph must keep its research
  // workspace read-only. The implicit ticket-without-planning promotion must
  // never fire while a planning node is present, so research stays read until
  // the plan itself declares the write set.
  it("keeps a planning-graph ticket workspace read-only (no implicit write promotion)", async () => {
    const readManifest: WorkspaceManifestV2 = {
      version: 2,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "main",
          selectedRationale: "ticket mentions api",
          access: "read",
          researchBaseSha: "base-sha",
        },
      ],
    };
    const ctx = makeCtx({
      workspaceManifest: readManifest,
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
        },
      ],
      definitionNodes: [
        node("plan", "planning_agent"),
        node("impl", "implementation_agent"),
      ],
      researchWriteRepositories: [],
    });

    const result = await maybePromoteTicketWorkspaceWrites(ctx);

    expect(result).toBeNull();
    expect(
      (ctx.workspaceManifest as WorkspaceManifestV2).repositories.every(
        (repository) => repository.access === "read",
      ),
    ).toBe(true);
  });
});
