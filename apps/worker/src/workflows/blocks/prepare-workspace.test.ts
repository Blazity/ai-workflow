import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    AGENT_KIND: "claude",
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    CLAUDE_MODEL: "claude-model",
    CODEX_MODEL: "codex-model",
    JOB_TIMEOUT_MS: 1000,
  } as Record<string, unknown>,
  runPreSandboxPhase: vi.fn(),
  prepareSelectedRepositoryBranches: vi.fn(),
  blockFetchPrContextsStep: vi.fn(),
  blockPrTriggerRepositoriesStep: vi.fn(),
  provisionMultiRepo: vi.fn(),
  createAgentAdapter: vi.fn((kind: string) => ({ kind })),
  buildSandboxProviderConfigs: vi.fn().mockResolvedValue([]),
  registerSandbox: vi.fn(),
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));
vi.mock("../../pre-sandbox/runner.js", () => ({
  runPreSandboxPhase: mocks.runPreSandboxPhase,
}));
vi.mock("../repository-prs.js", () => ({
  prepareSelectedRepositoryBranches: mocks.prepareSelectedRepositoryBranches,
}));
vi.mock("./fetch-pr-context.js", () => ({
  blockFetchPrContextsStep: mocks.blockFetchPrContextsStep,
  blockPrTriggerRepositoriesStep: mocks.blockPrTriggerRepositoriesStep,
}));
vi.mock("../../sandbox/manager.js", () => ({
  SandboxManager: vi.fn(() => ({ provisionMultiRepo: mocks.provisionMultiRepo })),
}));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
vi.mock("../../lib/vcs-runtime.js", () => ({
  buildSandboxProviderConfigs: mocks.buildSandboxProviderConfigs,
}));
vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));

import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import { execute, paramsSchema } from "./prepare-workspace.js";
import { teardownSandboxes } from "../../sandbox/poll-agent.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  makePrPayload,
  runControlErrorCases,
} from "./test-support.js";

const repo: SelectedRepository = {
  provider: "github",
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "ticket mentions api",
};

function contextsFor(repository: SelectedRepository, hasConflicts = false) {
  return [{ repository, prComments: [], checkResults: [], hasConflicts }];
}

describe("prepare_workspace paramsSchema", () => {
  it("accepts only empty params", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("prepare_workspace execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildSandboxProviderConfigs.mockResolvedValue([]);
    mocks.provisionMultiRepo.mockImplementation(async (...args: unknown[]) => {
      const lifecycle = args[4] as
        | { onCreated?: (sandboxId: string) => Promise<void> }
        | undefined;
      await lifecycle?.onCreated?.("sbx-9");
      return {
        sandbox: { sandboxId: "sbx-9" },
        workspaceManifest: {
          version: 1,
          repositories: [{
            ...repo,
            slug: "acme__api",
            localPath: "/vercel/sandbox",
            branchName: "blazebot/awt-1",
            preAgentSha: "trusted-sha",
          }],
        },
      };
    });
  });

  it("selects repos, provisions the sandbox, registers it, and mutates the ctx", async () => {
    const promptAdditions = {
      research: [
        { target: ["research"], title: "Selected Repositories", content: "- github:acme/api" },
      ],
      implementation: [],
      review: [],
    };
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions,
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({ sandboxId: null });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.runPreSandboxPhase).toHaveBeenCalledWith({
      ticket: expect.objectContaining({ identifier: "AWT-1" }),
      run: { branchName: "blazebot/awt-1" },
    });
    expect(mocks.prepareSelectedRepositoryBranches).toHaveBeenCalledWith(
      "AWT-1",
      "blazebot/awt-1",
      [repo],
      {
        subjectKey: "ticket:jira:AWT-1",
        ownerToken: "owner:test",
        runId: "run-1",
      },
    );
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "sbx-9",
    );
    expect(ctx.sandboxId).toBe("sbx-9");
    expect(ctx.workspaceManifest).toEqual({
      version: 1,
      repositories: [expect.objectContaining({
        repoPath: "acme/api",
        branchName: "blazebot/awt-1",
        preAgentSha: "trusted-sha",
      })],
    });
    expect(ctx.selectedRepositories).toEqual([repo]);
    expect(ctx.repositoryContexts).toEqual(contextsFor(repo));
    expect(ctx.preSandboxAdditions).toEqual(promptAdditions);
    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        sandboxId: "sbx-9",
        repositories: ["github:acme/api"],
        workspace: { id: "sbx-9", repositories: ["github:acme/api"] },
      },
    });
    expectOutputConformsToRegistry("prepare_workspace", result.output!);
  });

  it("passes the clarification answer back into pre-sandbox repository selection", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      promptAdditions: { research: [], implementation: [], review: [] },
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));

    await (execute as any)(
      makeNode("prepare_workspace"),
      {},
      makeCtx({ sandboxId: null }),
      {},
      { clarificationAnswer: "Use github:acme/api" },
    );

    expect(mocks.runPreSandboxPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: expect.objectContaining({
          comments: expect.arrayContaining([
            expect.objectContaining({
              author: "Human clarification",
              body: "Use github:acme/api",
            }),
          ]),
        }),
      }),
    );
  });

  it("marks conflicted repositories with a mergeBase", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo, true));
    const ctx = makeCtx({ sandboxId: null });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(ctx.selectedRepositories[0].mergeBase).toBe("main");
  });

  it("provisions every agent kind the definition resolves to", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({
      sandboxId: null,
      definitionNodes: [
        makeNode("fix_agent", { provider: "codex" }, "fix-1"),
        makeNode("open_pr", {}, "pr-1"),
      ],
    });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    const kinds = mocks.createAgentAdapter.mock.calls.map((call) => call[0]);
    expect(kinds).toContain("claude");
    expect(kinds).toContain("codex");
  });

  it("does not install planning or workspace-free Generic providers into the code workspace", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const ctx = makeCtx({
      sandboxId: null,
      definitionNodes: [
        makeNode("planning_agent", { provider: "codex" }, "plan-1"),
        makeNode(
          "generic_agent",
          { provider: "codex", prompt: "Summarize", workspaceMode: "none" },
          "generic-1",
        ),
        makeNode("implementation_agent", { provider: "claude" }, "impl-1"),
      ],
    });

    await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.createAgentAdapter).not.toHaveBeenCalledWith("codex");
    expect(mocks.createAgentAdapter).toHaveBeenCalledWith("claude");
  });

  it("is idempotent and reuses an already attached workspace", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({ status: "continue", selectedRepositories: [repo] });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.provisionMultiRepo.mockResolvedValueOnce({
      sandbox: { sandboxId: "sbx-a" },
      workspaceManifest: {
        version: 1,
        repositories: [{
          ...repo,
          slug: "acme__api",
          localPath: "/vercel/sandbox",
          branchName: "blazebot/awt-1",
          preAgentSha: "trusted-sha",
        }],
      },
    });

    const ctx = makeCtx({ sandboxId: null, sandboxIds: new Set<string>() });

    const first = await execute(makeNode("prepare_workspace"), {}, ctx);
    const second = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(ctx.sandboxId).toBe("sbx-a");
    expect([...ctx.sandboxIds]).toEqual(["sbx-a"]);
    expect(mocks.provisionMultiRepo).toHaveBeenCalledTimes(1);
    expect(mocks.registerSandbox).toHaveBeenLastCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "sbx-a",
    );
    expect(second).toEqual(first);

    const teardown = vi.fn().mockResolvedValue(undefined);
    await teardownSandboxes(ctx.sandboxIds, teardown);

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith("sbx-a");
  });

  it("reasserts the durable owner child for a reused code workspace", async () => {
    const ctx = makeCtx({
      sandboxId: "code-1",
      agentSandboxIds: { claude: "scratch-1" },
      sandboxIds: new Set(["scratch-1", "code-1"]),
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "code-1",
    );
    expect(result.kind).toBe("next");
  });

  it.each(runControlErrorCases())(
    "rethrows %s while reasserting a reused workspace owner",
    async (_label, error) => {
      mocks.registerSandbox.mockRejectedValueOnce(error);

      await expect(
        execute(
          makeNode("prepare_workspace"),
          {},
          makeCtx({ sandboxId: "code-1" }),
        ),
      ).rejects.toBe(error);
    },
  );

  it("fails closed when immediate durable sandbox registration throws", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({ status: "continue", selectedRepositories: [repo] });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.registerSandbox.mockRejectedValueOnce(new Error("registry write failed"));

    const ctx = makeCtx({ sandboxId: null, sandboxIds: new Set<string>() });
    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("registry write failed");
    expect(ctx.sandboxId).toBeNull();
    expect([...ctx.sandboxIds]).toEqual([]);
  });

  it("maps a pre-sandbox clarification halt to needs_human_input", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "needs_clarification",
      message: "unclear",
      questions: ["Which service?"],
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result).toEqual({
      kind: "needs_human_input",
      output: { status: "needs_human_input", questions: ["Which service?"] },
      questions: ["Which service?"],
    });
    expect(mocks.provisionMultiRepo).not.toHaveBeenCalled();
  });

  it("maps a pre-sandbox failure halt to kind failed", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "halt",
      outcome: "failed",
      message: "step exploded",
    });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("pre-sandbox: step exploded");
  });

  it("asks for a repository when none is selectable", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({ status: "continue", selectedRepositories: [] });

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        questions: ["Which repository should this ticket modify?"],
      },
      questions: ["Which repository should this ticket modify?"],
    });
  });

  it("selects the PR repository for pr_trigger entries without the pre-sandbox phase", async () => {
    mocks.blockPrTriggerRepositoriesStep.mockResolvedValue([repo]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    const pr = makePrPayload();
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_created",
        subjectKey: "ticket:jira:AWT-1",
        ticketKey: "AWT-1",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "workflow_owned",
        pr,
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledWith("AWT-1", pr);
    expect(mocks.runPreSandboxPhase).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
  });

  it("prepares a review-only human PR without creating a workflow branch", async () => {
    const pr = makePrPayload();
    const reviewRepo: SelectedRepository = {
      ...repo,
      workflowOwnedBranch: {
        branchName: pr.headRef,
        pr: { id: pr.prNumber, url: pr.prUrl, branch: pr.headRef },
      },
    };
    mocks.blockPrTriggerRepositoriesStep.mockResolvedValue([reviewRepo]);
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(reviewRepo));
    const ctx = makeCtx({
      sandboxId: null,
      entry: {
        kind: "pr_trigger",
        triggerType: "trigger_pr_review",
        subjectKey: "pr:github:acme/api#42",
        ownerToken: "owner:test",
        definitionId: 1,
        definitionVersion: 1,
        scope: "any",
        pr,
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledWith(
      "pr:github:acme/api#42",
      pr,
    );
    expect(mocks.prepareSelectedRepositoryBranches).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
  });

  it("maps provisioning errors to kind failed", async () => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.provisionMultiRepo.mockRejectedValue(new Error("no capacity"));

    const result = await execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null }));

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("no capacity");
  });

  it.each(runControlErrorCases())("rethrows %s from provisioning", async (_label, error) => {
    mocks.runPreSandboxPhase.mockResolvedValue({
      status: "continue",
      selectedRepositories: [repo],
    });
    mocks.blockFetchPrContextsStep.mockResolvedValue(contextsFor(repo));
    mocks.provisionMultiRepo.mockRejectedValue(error);

    await expect(
      execute(makeNode("prepare_workspace"), {}, makeCtx({ sandboxId: null })),
    ).rejects.toBe(error);
  });
});
