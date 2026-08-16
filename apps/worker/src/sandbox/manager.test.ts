import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockStdout = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
      stop: mockStop,
    })),
  },
}));

import { SandboxManager } from "./manager.js";
import { MEMORY_PRE_COMMIT_HOOK } from "./git-excludes.js";
import { logger } from "../lib/logger.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";
import { WORKSPACE_MANIFEST_PATH, WORKSPACE_REPOS_DIR } from "./repo-workspace.js";

const makeFakeAgent = (): AgentAdapter & { calls: any[] } => {
  const calls: any[] = [];
  return {
    kind: "claude",
    install: vi.fn(async () => { calls.push({ op: "install" }); }),
    configure: vi.fn(async (_, opts: ConfigureOpts) => { calls.push({ op: "configure", opts }); }),
    setCommitGuard: vi.fn(async (_s, enabled) => { calls.push({ op: "guard", enabled }); }),
    buildPhaseScript: () => "#!/bin/bash\necho noop",
    artifactPaths: () => ({ wrapper: "", input: "", stdout: "", stderr: "", sentinel: "", structuredOutput: null }),
    parseAgentOutput: () => ({ result: "implemented" }),
    parseReviewOutput: () => ({ result: "approved", feedback: "", issues: [] }),
    parseResearchStatus: () => ({ status: "completed", body: "" }),
    extractUsage: () => null,
    calls,
  } as any;
};

describe("SandboxManager.provisionMultiRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCommand.mockResolvedValue({ exitCode: 0, stdout: mockStdout });
    mockStdout.mockResolvedValue("");
    mockWriteFiles.mockResolvedValue(undefined);
    mockStop.mockResolvedValue({ status: "stopped" });
  });

  const baseConfig = {
    providers: [
      {
        kind: "github" as const,
        getToken: () => Promise.resolve("ghs_test"),
        host: "https://github.com",
        commitAuthor: "ai-workflow-blazity",
        commitEmail: "bot@blazity.com",
      },
    ],
    jobTimeoutMs: 1_800_000,
  };

  it("creates the sandbox with a git source pointed at the first repository branch", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ type: "git", revision: "feat/test-branch" }),
        runtime: "node24",
      }),
    );
  });

  it("checks out default branches and records research baselines in read mode", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(
        args.includes("status") ? "" : "research-sha\n",
      ),
    }));
    const manager = new SandboxManager(baseConfig);

    const result = await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        access: "read",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "research candidate",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ revision: "main" }),
      }),
    );
    expect(result.workspaceManifest.repositories[0]).toMatchObject({
      access: "read",
      branchName: "main",
      researchBaseSha: "research-sha",
    });
  });

  it("rejects a dirty read-only checkout before recording its baseline", async () => {
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(
        args.includes("status") ? "UU src/conflict.ts\n" : "research-sha\n",
      ),
    }));
    const manager = new SandboxManager(baseConfig);

    await expect(manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        access: "read",
        repositories: [{
          provider: "github",
          repoPath: "test-org/test-repo",
          defaultBranch: "main",
          selectedRationale: "research candidate",
        }],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    )).rejects.toThrow("read-only checkout is dirty");
  });

  it("provisions normally and records the approved baseline when the clone head matches", async () => {
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(args.includes("status") ? "" : "approved-sha\n"),
    }));
    const manager = new SandboxManager(baseConfig);

    const result = await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        access: "read",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "approved research candidate",
            expectedResearchBaseSha: "approved-sha",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(result.workspaceManifest.repositories[0]).toMatchObject({
      access: "read",
      researchBaseSha: "approved-sha",
    });
  });

  it("throws a replan-required error and records nothing when the approved baseline drifted", async () => {
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(args.includes("status") ? "" : "moved-sha\n"),
    }));
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          access: "read",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/test-repo",
              defaultBranch: "main",
              selectedRationale: "approved research candidate",
              expectedResearchBaseSha: "approved-sha",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
      ),
    ).rejects.toThrow(/moved after research; replan required/);

    expect(
      mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .some((file) => file.path === WORKSPACE_MANIFEST_PATH),
    ).toBe(false);
    expect(mockStop).toHaveBeenCalled();
  });

  it("verifies an approved write owned-branch checkout against its pre-merge remote baseline", async () => {
    // Two `rev-parse HEAD` calls happen per repo: the first captures the owned
    // branch head at clone (expectedRemoteSha), the second captures the post-merge
    // head (preAgentSha). The approved baseline pins the owned-branch head, so a
    // different post-merge head must NOT trip the drift check.
    let revParseCall = 0;
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        revParseCall += 1;
        return {
          exitCode: 0,
          stdout: vi.fn().mockResolvedValue(revParseCall === 1 ? "owned-sha\n" : "merged-sha\n"),
        };
      }
      return {
        exitCode: 0,
        stdout: vi.fn().mockResolvedValue(args.includes("status") ? "" : "noise\n"),
        stderr: vi.fn().mockResolvedValue(""),
      };
    });
    const manager = new SandboxManager(baseConfig);

    const result = await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-200",
        access: "read",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "approved write repository",
            workflowOwnedBranch: { branchName: "blazebot/aiw-200" },
            mergeBase: "main",
            access: "write",
            expectedResearchBaseSha: "owned-sha",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(result.workspaceManifest.repositories[0]).toMatchObject({
      access: "write",
      expectedRemoteSha: "owned-sha",
      preAgentSha: "merged-sha",
    });
    expect(result.workspaceManifest.repositories[0]).not.toHaveProperty("researchBaseSha");
  });

  it("rejects an approved write owned-branch checkout whose owned branch moved before clone", async () => {
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(args.includes("status") ? "" : "owned-moved-sha\n"),
      stderr: vi.fn().mockResolvedValue(""),
    }));
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "blazebot/aiw-200",
          access: "read",
          repositories: [
            {
              provider: "github",
              repoPath: "acme/api",
              defaultBranch: "main",
              selectedRationale: "approved write repository",
              workflowOwnedBranch: { branchName: "blazebot/aiw-200" },
              mergeBase: "main",
              access: "write",
              expectedResearchBaseSha: "owned-sha",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
      ),
    ).rejects.toThrow(/moved after research; replan required/);

    expect(
      mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .some((file) => file.path === WORKSPACE_MANIFEST_PATH),
    ).toBe(false);
    expect(mockStop).toHaveBeenCalled();
  });

  it("leaves legacy inputs without an approved baseline unchanged", async () => {
    mockRunCommand.mockImplementation(async (_name: string, args: string[]) => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(args.includes("status") ? "" : "clone-head-sha\n"),
    }));
    const manager = new SandboxManager(baseConfig);

    const result = await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        access: "read",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "research candidate",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    // No expectedResearchBaseSha: the baseline is still whatever the clone head is.
    expect(result.workspaceManifest.repositories[0]).toMatchObject({
      access: "read",
      researchBaseSha: "clone-head-sha",
    });
  });

  it("durably registers the sandbox immediately after create and before setup", async () => {
    const order: string[] = [];
    const onCreated = vi.fn(async (sandboxId: string) => {
      order.push(`register:${sandboxId}`);
    });
    mockRunCommand.mockImplementation(async () => {
      order.push("setup");
      return { exitCode: 0, stdout: mockStdout };
    });
    const manager = new SandboxManager(baseConfig);

    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
      [],
      { onCreated },
    );

    expect(onCreated).toHaveBeenCalledWith("sbx-test-123");
    expect(order[0]).toBe("register:sbx-test-123");
    expect(order[1]).toBe("setup");
  });

  it("stops the external sandbox when immediate registration fails", async () => {
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/test-repo",
              defaultBranch: "main",
              selectedRationale: "only accessible repository",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
        [],
        {
          onCreated: async () => {
            throw new Error("registry write failed");
          },
        },
      ),
    ).rejects.toThrow("registry write failed");

    expect(mockStop).toHaveBeenCalledWith({ blocking: true });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it("fails closed when registration-race cleanup is not terminal", async () => {
    mockStop.mockResolvedValueOnce({ status: "stopping" });
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/test-repo",
              defaultBranch: "main",
              selectedRationale: "only accessible repository",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
        [],
        {
          onCreated: async () => {
            throw new Error("owner entered cancellation");
          },
        },
      ),
    ).rejects.toThrow(/cleanup unconfirmed.*stopping/i);

    expect(mockStop).toHaveBeenCalledWith({ blocking: true });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it("preserves exact-owner loss when registration cleanup is not terminal", async () => {
    mockStop.mockResolvedValueOnce({ status: "stopping" });
    const ownerError = new Error("Provider mutation requires the exact active run owner.");
    ownerError.name = "ActiveRunOwnerError";
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/test-repo",
              defaultBranch: "main",
              selectedRationale: "only accessible repository",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
        [],
        {
          onCreated: async () => {
            throw ownerError;
          },
        },
      ),
    ).rejects.toBe(ownerError);

    expect(mockStop).toHaveBeenCalledWith({ blocking: true });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it("sets git identity to commitAuthor / commitEmail", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );
    const idCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "git" && args[0] === "-C" && args.includes("user.name"),
    );
    expect(idCall).toBeDefined();
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "config",
      "user.name",
      "ai-workflow-blazity",
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "config",
      "user.email",
      "bot@blazity.com",
    ]);
  });

  it("captures pre-agent HEAD SHA for the push step", async () => {
    mockStdout.mockResolvedValue("sha-123\n");
    const manager = new SandboxManager(baseConfig);
    const provisioned = await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );
    const shaCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "git" && args[0] === "-C" && args.includes("rev-parse"),
    );
    expect(shaCall).toBeDefined();
    expect(provisioned).toMatchObject({
      sandbox: { sandboxId: "sbx-test-123" },
      workspaceManifest: {
          version: 2,
        repositories: [
          expect.objectContaining({
            provider: "github",
            repoPath: "test-org/test-repo",
            branchName: "feat/test-branch",
            preAgentSha: "sha-123",
          }),
        ],
      },
    });
  });

  it("calls agent.install then agent.configure with the supplied opts", async () => {
    const agent = makeFakeAgent();
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      agent,
      {
        anthropicApiKey: "sk-ant-test",
        model: "claude-opus-4-6",
      },
    );
    const ops = (agent as any).calls.map((c: any) => c.op);
    expect(ops).toEqual(["install", "configure"]);
    expect((agent as any).calls[1].opts).toEqual(
      expect.objectContaining({ anthropicApiKey: "sk-ant-test", model: "claude-opus-4-6" }),
    );
  });

  it("installs then configures each adapter in order for a mixed run", async () => {
    const primary = makeFakeAgent();
    const secondary = makeFakeAgent();
    (secondary as any).kind = "codex";
    const order: string[] = [];
    for (const [agent, label] of [
      [primary, "primary"],
      [secondary, "secondary"],
    ] as const) {
      (agent.install as any).mockImplementation(async () => order.push(`${label}:install`));
      (agent.configure as any).mockImplementation(async () => order.push(`${label}:configure`));
    }

    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      primary,
      { model: "claude-default", anthropicApiKey: "k" },
      [{ agent: secondary, configureOpts: { model: "codex-default", codexApiKey: "c" } }],
    );

    expect(order).toEqual([
      "primary:install",
      "primary:configure",
      "secondary:install",
      "secondary:configure",
    ]);
    expect((secondary.configure as any).mock.calls[0][1]).toEqual(
      expect.objectContaining({ model: "codex-default", codexApiKey: "c" }),
    );
  });

  it("leaves the single-adapter sequence unchanged (no additional agents)", async () => {
    const agent = makeFakeAgent();
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      agent,
      { model: "claude-default", anthropicApiKey: "k" },
    );
    expect((agent as any).calls.map((c: any) => c.op)).toEqual(["install", "configure"]);
  });

  it("fetches and merges only repositories with a repository mergeBase", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-45",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch for this ticket",
            mergeBase: "main",
          },
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "trunk",
            selectedRationale: "ticket mentions web",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    const mergeFetches = mockRunCommand.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args[0] === "-C" && args.includes("fetch"),
    );
    expect(mergeFetches).toHaveLength(1);
    expect(mergeFetches[0]![1]).toEqual([
      "-C",
      "/vercel/sandbox",
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "fetch",
      expect.stringContaining("github.com/acme/api.git"),
      "main",
    ]);
  });

  it("never merges a default branch into a read-only research checkout", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-45",
        access: "read",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch for this ticket",
            workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
            mergeBase: "main",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    const gitArgs = mockRunCommand.mock.calls
      .filter(([command]) => command === "git")
      .map(([, args]) => args);
    expect(gitArgs.some((args) => args.includes("merge"))).toBe(false);
    expect(gitArgs.some((args) => args.includes("fetch"))).toBe(false);
  });

  it("provisions a workflow-owned remediation repository as write on its owned branch and pre-merges its base", async () => {
    mockStdout.mockResolvedValue("owned-sha\n");
    const { Sandbox } = await import("@vercel/sandbox");
    const manager = new SandboxManager(baseConfig);

    const result = await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-200",
        // Manifest-wide default is read; the per-repository write access must win.
        access: "read",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch for this ticket",
            workflowOwnedBranch: { branchName: "blazebot/aiw-200" },
            mergeBase: "main",
            access: "write",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    // Checked out the owned branch as write, with both baselines recorded and no
    // read-only research baseline. mockStdout returns a non-empty string for every
    // command, so a read-only dirty check would have thrown here.
    expect(result.workspaceManifest.repositories[0]).toMatchObject({
      access: "write",
      branchName: "blazebot/aiw-200",
      expectedRemoteSha: "owned-sha",
      preAgentSha: "owned-sha",
    });
    expect(result.workspaceManifest.repositories[0]).not.toHaveProperty(
      "researchBaseSha",
    );
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ revision: "blazebot/aiw-200" }),
      }),
    );

    // The base is pre-merged for the write checkout (this is exactly what a
    // read-only remediation checkout would have skipped).
    const gitArgs = mockRunCommand.mock.calls
      .filter(([command]) => command === "git")
      .map(([, args]) => args);
    expect(gitArgs.some((args) => args.includes("fetch"))).toBe(true);
    expect(gitArgs.some((args) => args.includes("merge"))).toBe(true);
    // No new remote branch is created at provisioning time.
    expect(gitArgs.some((args) => args.includes("push"))).toBe(false);
  });

  it("passes merge base branch names as git arguments", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-45",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "release/2026.07",
            selectedRationale: "workflow-owned branch for this ticket",
            mergeBase: "release/2026.07",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "fetch",
      expect.stringContaining("github.com/acme/api.git"),
      "release/2026.07",
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "branch",
      "-f",
      "release/2026.07",
      "FETCH_HEAD",
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "merge",
      "FETCH_HEAD",
      "--no-edit",
    ]);
  });

  it("uses the sandbox root for the first selected repository and clones the rest", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-45",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(mockRunCommand).toHaveBeenCalledWith("mkdir", ["-p", WORKSPACE_REPOS_DIR]);
    expect(mockRunCommand).not.toHaveBeenCalledWith("git", expect.arrayContaining([
      "clone",
      expect.stringContaining("github.com/acme/api.git"),
    ]));
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "clone",
      "--branch",
      "blazebot/aiw-45",
      expect.stringContaining("github.com/acme/web.git"),
      "/vercel/sandbox/repos/github__acme__web",
    ]);
  });

  it("excludes sandbox-owned metadata, secondary clones, and agent memory", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-100",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "config",
      "--local",
      "core.excludesFile",
      "/tmp/aiw-primary-git-excludes",
    ]);
    expect(mockWriteFiles).toHaveBeenCalledWith([
      {
        path: "/tmp/aiw-primary-git-excludes",
        content: expect.any(Buffer),
      },
    ]);
    const excludeWrite = mockWriteFiles.mock.calls
      .flatMap(([files]) => files)
      .find((file) => file.path === "/tmp/aiw-primary-git-excludes");
    expect(excludeWrite?.content.toString("utf8")).toBe(
      "/aiw-repos.json\n/repos/\n/ai-workflow/memory/\n/blazebot/memory/\n",
    );
  });

  it("configures excludes for every checkout, not just the primary one", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-100",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    for (const localPath of [
      "/vercel/sandbox",
      "/vercel/sandbox/repos/github__acme__web",
    ]) {
      expect(mockRunCommand).toHaveBeenCalledWith("git", [
        "-C",
        localPath,
        "config",
        "--local",
        "core.excludesFile",
        "/tmp/aiw-primary-git-excludes",
      ]);
    }
    // One shared file, written once for the whole workspace.
    expect(
      mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .filter((file) => file.path === "/tmp/aiw-primary-git-excludes"),
    ).toHaveLength(1);
  });

  it("installs the executable memory pre-commit hook in every checkout", async () => {
    // A fresh checkout has no pre-commit hook, so the existence probe fails.
    mockRunCommand.mockImplementation(async (name: string) => ({
      exitCode: name === "test" ? 1 : 0,
      stdout: vi.fn().mockResolvedValue(""),
    }));
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-100",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    for (const localPath of [
      "/vercel/sandbox",
      "/vercel/sandbox/repos/github__acme__web",
    ]) {
      const hookPath = `${localPath}/.git/hooks/pre-commit`;
      const hookWrite = mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .find((file) => file.path === hookPath);
      expect(hookWrite?.content.toString("utf8")).toBe(MEMORY_PRE_COMMIT_HOOK);
      expect(mockRunCommand).toHaveBeenCalledWith("chmod", ["+x", hookPath]);
    }
    // The hook only rejects a memory path that HEAD does not already track, so a
    // legacy committed document keeps committing.
    expect(MEMORY_PRE_COMMIT_HOOK).toContain("git ls-tree --name-only HEAD");
  });

  it("installs the hook even when core.hooksPath shadows it", async () => {
    // husky and lefthook point core.hooksPath at their own directory during
    // install, which makes .git/hooks unreadable to git. Install anyway: the
    // repository may reset the setting, and the publication gate is the guarantee.
    mockRunCommand.mockImplementation(async (name: string, args: string[]) => ({
      exitCode: name === "test" ? 1 : 0,
      stdout: vi
        .fn()
        .mockResolvedValue(args.includes("core.hooksPath") ? ".husky\n" : ""),
    }));
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-100",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    const hookPath = "/vercel/sandbox/.git/hooks/pre-commit";
    expect(
      mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .some((file) => file.path === hookPath),
    ).toBe(true);
    expect(mockRunCommand).toHaveBeenCalledWith("chmod", ["+x", hookPath]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "config",
      "--get",
      "core.hooksPath",
    ]);
  });

  it("keeps provisioning and warns when the hook cannot be made executable", async () => {
    // The hook is defense in depth, not the authoritative guard, so a chmod that
    // fails must never wreck provisioning. Existence probe fails (fresh checkout),
    // chmod fails, everything else succeeds.
    mockRunCommand.mockImplementation(async (name: string) => ({
      exitCode: name === "test" || name === "chmod" ? 1 : 0,
      stdout: vi.fn().mockResolvedValue(""),
    }));
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const manager = new SandboxManager(baseConfig);

    const result = await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-100",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(result.workspaceManifest.repositories).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "acme/api",
        localPath: "/vercel/sandbox",
        reason: expect.stringContaining("chmod"),
      }),
      "memory_commit_hook_install_failed",
    );
    warnSpy.mockRestore();
  });

  it("leaves a repository-owned pre-commit hook in place", async () => {
    // Default mock: every command succeeds, so the existence probe reports a hook.
    const manager = new SandboxManager(baseConfig);
    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-100",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(
      mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .some((file) => file.path.endsWith("/.git/hooks/pre-commit")),
    ).toBe(false);
    expect(mockRunCommand).not.toHaveBeenCalledWith("chmod", [
      "+x",
      "/vercel/sandbox/.git/hooks/pre-commit",
    ]);
  });

  it("uses the selected repository provider credentials when cloning mixed providers", async () => {
    const manager = new SandboxManager({
      providers: [
        {
          kind: "github",
          getToken: () => Promise.resolve("ghs_test"),
          host: "https://github.com",
          commitAuthor: "github-bot",
          commitEmail: "github-bot@example.com",
        },
        {
          kind: "gitlab",
          getToken: () => Promise.resolve("glpat_test"),
          host: "https://gitlab.example.com",
          commitAuthor: "gitlab-bot",
          commitEmail: "gitlab-bot@example.com",
        },
      ],
      jobTimeoutMs: 1_800_000,
    });

    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-45",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
          {
            provider: "gitlab",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "clone",
      "--branch",
      "blazebot/aiw-45",
      "https://gitlab.example.com/acme/api.git",
      "/vercel/sandbox/repos/gitlab__acme__api",
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/gitlab__acme__api",
      "config",
      "user.name",
      "gitlab-bot",
    ]);
  });

  it("writes a workspace manifest with pre-agent SHA per repository", async () => {
    mockStdout.mockResolvedValue("sha-123\n");
    const manager = new SandboxManager(baseConfig);

    await manager.provisionMultiRepo(
      {
        branchName: "blazebot/aiw-45",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    const manifestWrite = mockWriteFiles.mock.calls
      .flatMap(([files]) => files)
      .find((file) => file.path === WORKSPACE_MANIFEST_PATH);
    expect(manifestWrite).toBeDefined();
    const manifest = JSON.parse(manifestWrite.content.toString("utf8"));
    expect(manifest.repositories[0]).toMatchObject({
      repoPath: "acme/api",
      localPath: "/vercel/sandbox",
      expectedRemoteSha: "sha-123",
      preAgentSha: "sha-123",
    });
  });

  it("stops a created sandbox when provisioning fails before returning it", async () => {
    mockRunCommand.mockRejectedValueOnce(new Error("mkdir failed"));
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/test-repo",
              defaultBranch: "main",
              selectedRationale: "only accessible repository",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
      ),
    ).rejects.toThrow("mkdir failed");
    expect(mockStop).toHaveBeenCalled();
  });

  it("reuses the first repository token instead of minting it twice", async () => {
    const getToken = vi.fn().mockResolvedValue("ghs_test");
    const manager = new SandboxManager({
      providers: [
        {
          ...baseConfig.providers[0],
          getToken,
        },
      ],
      jobTimeoutMs: 1_800_000,
    });

    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/test-repo",
            defaultBranch: "main",
            selectedRationale: "only accessible repository",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("reuses provider tokens for additional repositories in one provisioning call", async () => {
    const getToken = vi.fn().mockResolvedValue("ghs_test");
    const manager = new SandboxManager({
      providers: [
        {
          ...baseConfig.providers[0],
          getToken,
        },
      ],
      jobTimeoutMs: 1_800_000,
    });

    await manager.provisionMultiRepo(
      {
        branchName: "feat/test-branch",
        repositories: [
          {
            provider: "github",
            repoPath: "test-org/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "test-org/web",
            defaultBranch: "main",
            selectedRationale: "ticket mentions web",
          },
        ],
      },
      makeFakeAgent(),
      { model: "any", anthropicApiKey: "k" },
    );

    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("fails fast when cloning an additional repository fails", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "git" && args.includes("clone")) {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("clone failed"),
        };
      }
      return { exitCode: 0, stdout: mockStdout, stderr: vi.fn().mockResolvedValue("") };
    });
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/api",
              defaultBranch: "main",
              selectedRationale: "ticket mentions api",
            },
            {
              provider: "github",
              repoPath: "test-org/web",
              defaultBranch: "main",
              selectedRationale: "ticket mentions web",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
      ),
    ).rejects.toThrow("git clone failed for github:test-org/web: clone failed");
    expect(mockRunCommand).not.toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/github__test-org__web",
      "config",
      "user.name",
      "ai-workflow-blazity",
    ]);
    expect(mockStop).toHaveBeenCalled();
  });

  it("fails fast when the bootstrap repository checkout fails", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "git" && args[0] === "-C" && args.includes("checkout")) {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("checkout failed"),
        };
      }
      return { exitCode: 0, stdout: mockStdout, stderr: vi.fn().mockResolvedValue("") };
    });
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/api",
              defaultBranch: "main",
              selectedRationale: "ticket mentions api",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
      ),
    ).rejects.toThrow("git checkout failed for github:test-org/api: checkout failed");
    expect(mockStop).toHaveBeenCalled();
  });

  it("fails fast when remote-baseline SHA capture fails", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "git" && args[0] === "-C" && args.includes("rev-parse")) {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("rev-parse failed"),
        };
      }
      return { exitCode: 0, stdout: mockStdout, stderr: vi.fn().mockResolvedValue("") };
    });
    const manager = new SandboxManager(baseConfig);

    await expect(
      manager.provisionMultiRepo(
        {
          branchName: "feat/test-branch",
          repositories: [
            {
              provider: "github",
              repoPath: "test-org/api",
              defaultBranch: "main",
              selectedRationale: "ticket mentions api",
            },
          ],
        },
        makeFakeAgent(),
        { model: "any", anthropicApiKey: "k" },
      ),
    ).rejects.toThrow(
      "git rev-parse remote baseline failed for github:test-org/api: rev-parse failed",
    );
    expect(
      mockWriteFiles.mock.calls
        .flatMap(([files]) => files)
        .some((file) => file.path === WORKSPACE_MANIFEST_PATH),
    ).toBe(false);
    expect(mockStop).toHaveBeenCalled();
  });
});
