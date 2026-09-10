import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";

const mocks = vi.hoisted(() => ({
  ensureAgentSandbox: vi.fn(),
}));

vi.mock("./blocks/agent-sandbox.js", () => ({
  ensureAgentSandbox: mocks.ensureAgentSandbox,
}));

import {
  ensurePlanningAgentSandboxForBlock,
  shouldPromoteResearchWriteScope,
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
    const ctx = makeCtx();

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

describe("shouldPromoteResearchWriteScope", () => {
  const writeRepositories = [
    { provider: "github" as const, repoPath: "acme/api", rationale: "plan changes api" },
  ];

  // IM-3: an approval-gated graph must not create a remote branch or ledger row in
  // the planning run. Promotion is deferred to the approved implementation run.
  it("skips promotion when the definition contains a send_plan_approval node", () => {
    expect(
      shouldPromoteResearchWriteScope({
        definitionNodes: [
          node("plan", "planning_agent"),
          node("approval", "send_plan_approval"),
        ],
        writeRepositories,
        manifestVersion: 2,
      }),
    ).toBe(false);
  });

  // Non-approval planning graph (research -> implementation in the same run) keeps
  // promoting exactly as before.
  it("promotes for a non-approval planning graph with a write set", () => {
    expect(
      shouldPromoteResearchWriteScope({
        definitionNodes: [
          node("plan", "planning_agent"),
          node("impl", "implementation_agent"),
        ],
        writeRepositories,
        manifestVersion: 2,
      }),
    ).toBe(true);
  });

  // IM-1: a completed research with an empty write set (research-only ticket) has
  // nothing to promote.
  it("skips promotion when the completed write set is empty", () => {
    expect(
      shouldPromoteResearchWriteScope({
        definitionNodes: [
          node("plan", "planning_agent"),
          node("impl", "implementation_agent"),
        ],
        writeRepositories: [],
        manifestVersion: 2,
      }),
    ).toBe(false);
  });

  it("skips promotion for a non-trusted (non-v2) workspace", () => {
    expect(
      shouldPromoteResearchWriteScope({
        definitionNodes: [node("plan", "planning_agent")],
        writeRepositories,
        manifestVersion: 1,
      }),
    ).toBe(false);
  });
});
