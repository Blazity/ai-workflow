import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockStdout = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
      stop: mockStop,
    })),
  },
}));

import { SandboxManager } from "./manager.js";
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

    expect(mockStop).toHaveBeenCalledOnce();
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
    const shaCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "git" && args[0] === "-C" && args.includes("rev-parse"),
    );
    expect(shaCall).toBeDefined();
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

  it("fails fast when pre-agent SHA capture fails", async () => {
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
    ).rejects.toThrow("git rev-parse failed for github:test-org/api: rev-parse failed");
    expect(mockWriteFiles).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
  });
});
