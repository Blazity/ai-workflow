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
import { makeCtx, makeNode, makePrPayload } from "./test-support.js";

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
    mocks.provisionMultiRepo.mockResolvedValue({ sandboxId: "sbx-9" });
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
    );
    expect(mocks.registerSandbox).toHaveBeenCalledWith("AWT-1", "sbx-9");
    expect(ctx.sandboxId).toBe("sbx-9");
    expect(ctx.selectedRepositories).toEqual([repo]);
    expect(ctx.repositoryContexts).toEqual(contextsFor(repo));
    expect(ctx.preSandboxAdditions).toEqual(promptAdditions);
    expect(result).toEqual({
      kind: "next",
      output: { status: "ok", sandboxId: "sbx-9", repositories: ["github:acme/api"] },
    });
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

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("pre-sandbox: step exploded");
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
        ticketKey: "AWT-1",
        definitionId: 1,
        pr,
      },
    });

    const result = await execute(makeNode("prepare_workspace"), {}, ctx);

    expect(mocks.blockPrTriggerRepositoriesStep).toHaveBeenCalledWith("AWT-1", pr);
    expect(mocks.runPreSandboxPhase).not.toHaveBeenCalled();
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

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("no capacity");
  });
});
