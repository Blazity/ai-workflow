import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
} from "./repo-workspace.js";

const mocks = vi.hoisted(() => ({
  sandboxGet: vi.fn(),
  sandboxCreate: vi.fn(),
  sourceCommand: vi.fn(),
  sourceReadFile: vi.fn(),
  reviewCommand: vi.fn(),
  reviewReadFile: vi.fn(),
  reviewWriteFiles: vi.fn(),
  registerSandbox: vi.fn(),
  unregisterSandbox: vi.fn(),
  stopSandbox: vi.fn(),
  installAgent: vi.fn(),
  configureAgent: vi.fn(),
  setCommitGuard: vi.fn(),
  isAgentRuntimeError: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: mocks.sandboxGet,
    create: mocks.sandboxCreate,
  },
}));
vi.mock("../../env.js", () => ({
  env: {
    JOB_TIMEOUT_MS: 120_000,
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    CODEX_CHATGPT_OAUTH_TOKEN: undefined,
    GENAI_ENGINE_API_KEY: undefined,
    GENAI_ENGINE_TRACE_ENDPOINT: undefined,
  },
}));
vi.mock("./credentials.js", () => ({
  getSandboxCredentials: () => ({ teamId: "team" }),
}));
vi.mock("./agents/index.js", () => ({
  createAgentAdapter: () => ({
    install: mocks.installAgent,
    configure: mocks.configureAgent,
    setCommitGuard: mocks.setCommitGuard,
  }),
}));
vi.mock("./agents/protocol.js", () => ({
  isAgentRuntimeError: mocks.isAgentRuntimeError,
}));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    runRegistry: {
      registerSandbox: mocks.registerSandbox,
      unregisterSandbox: mocks.unregisterSandbox,
    },
  }),
}));
vi.mock("./stop-ticket-sandboxes.js", () => ({
  stopSandboxAndConfirm: mocks.stopSandbox,
}));

import {
  provisionDisposableReviewWorkspaceStep,
  verifyDisposableReviewWorkspaceStep,
} from "./disposable-review-workspace.js";

function command(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

const manifest: WorkspaceManifest = {
  version: 1,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/api",
      slug: "acme__api",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "ai-workflow/AIW-120",
      selectedRationale: "ticket repository",
      expectedRemoteSha: "base-api",
      preAgentSha: "base-api",
    },
    {
      provider: "gitlab",
      repoPath: "acme/web",
      slug: "gitlab__acme__web",
      localPath: "/vercel/sandbox/repos/gitlab__acme__web",
      defaultBranch: "main",
      branchName: "ai-workflow/AIW-120",
      selectedRationale: "related repository",
      expectedRemoteSha: "base-web",
      preAgentSha: "base-web",
    },
  ],
};

function headForArgs(args: string[]): string {
  return args.includes("/vercel/sandbox/repos/gitlab__acme__web")
    ? "head-web"
    : "head-api";
}

describe("disposable review workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAgentRuntimeError.mockReturnValue(false);
    mocks.registerSandbox.mockResolvedValue(undefined);
    mocks.unregisterSandbox.mockResolvedValue(true);
    mocks.stopSandbox.mockResolvedValue(undefined);
    mocks.installAgent.mockResolvedValue(undefined);
    mocks.configureAgent.mockResolvedValue(undefined);
    mocks.setCommitGuard.mockResolvedValue(undefined);
    mocks.reviewWriteFiles.mockResolvedValue(undefined);

    mocks.sourceCommand.mockImplementation(
      async (_name: string, args: string[]) =>
        args.includes("rev-parse") ? command(headForArgs(args)) : command(),
    );
    mocks.sourceReadFile.mockImplementation(async ({ path }: { path: string }) =>
      path === WORKSPACE_MANIFEST_PATH
        ? Buffer.from(JSON.stringify(manifest))
        : Buffer.from(`bundle:${path}`),
    );
    mocks.reviewCommand.mockImplementation(
      async (_name: string, args: string[]) =>
        args.includes("rev-parse") ? command(headForArgs(args)) : command(),
    );
    mocks.reviewReadFile.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));

    mocks.sandboxGet.mockResolvedValue({
      sandboxId: "source-1",
      runCommand: mocks.sourceCommand,
      readFileToBuffer: mocks.sourceReadFile,
    });
    mocks.sandboxCreate.mockResolvedValue({
      sandboxId: "review-1",
      runCommand: mocks.reviewCommand,
      readFileToBuffer: mocks.reviewReadFile,
      writeFiles: mocks.reviewWriteFiles,
    });
  });

  it("imports exact detached heads without remotes and seals every repository", async () => {
    const order: string[] = [];
    mocks.registerSandbox.mockImplementation(async () => {
      order.push("register");
    });
    mocks.reviewCommand.mockImplementation(
      async (_name: string, args: string[]) => {
        order.push(`command:${args.join(" ")}`);
        return args.includes("rev-parse") ? command(headForArgs(args)) : command();
      },
    );

    const result = await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
    });

    expect(result).toEqual({
      ok: true,
      sandboxId: "review-1",
      repositories: [
        {
          repoPath: "acme/api",
          localPath: "/vercel/sandbox",
          headSha: "head-api",
        },
        {
          repoPath: "acme/web",
          localPath: "/vercel/sandbox/repos/gitlab__acme__web",
          headSha: "head-web",
        },
      ],
    });
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      teamId: "team",
      runtime: "node24",
      timeout: 120_000,
    });
    expect(order[0]).toBe("register");
    expect(
      mocks.reviewCommand.mock.calls.filter(
        ([name, args]) => name === "git" && (args as string[]).includes("fetch"),
      ),
    ).toHaveLength(2);
    expect(
      mocks.reviewCommand.mock.calls.some(
        ([name, args]) =>
          name === "git" &&
          ((args as string[]).includes("clone") || (args as string[]).includes("push")),
      ),
    ).toBe(false);
    expect(mocks.setCommitGuard).toHaveBeenCalledWith(
      expect.anything(),
      false,
      undefined,
    );
    expect(mocks.reviewCommand).toHaveBeenCalledWith(
      "chmod",
      ["-R", "a-w", "/vercel/sandbox/repos/gitlab__acme__web"],
    );
    expect(mocks.reviewCommand).toHaveBeenCalledWith(
      "chmod",
      ["-R", "a-w", "/vercel/sandbox"],
    );
    expect(mocks.reviewCommand).toHaveBeenCalledWith(
      "ln",
      [
        "-s",
        "/tmp/aiw-review-codex-cwd",
        "/vercel/sandbox/.codex",
      ],
    );
    expect(mocks.reviewCommand).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "-c",
        expect.stringContaining('rm -rf "$HOME/.config/gh" "$HOME/.config/glab"'),
      ]),
    );
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AIW-120",
      "owner-1",
      "review-1",
    );
  });

  it("blocks a dirty source before creating or registering a review sandbox", async () => {
    mocks.sourceCommand.mockImplementation(
      async (_name: string, args: string[]) =>
        args.includes("status") ? command(" M src/index.ts") : command("head-api"),
    );

    await expect(
      provisionDisposableReviewWorkspaceStep({
        sourceSandboxId: "source-1",
        workspaceManifest: manifest,
        subjectKey: "ticket:jira:AIW-120",
        ownerToken: "owner-1",
        agentKind: "codex",
        model: "gpt-5",
        arthurTaskId: null,
      }),
    ).rejects.toThrow(/uncommitted changes/i);

    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
    expect(mocks.registerSandbox).not.toHaveBeenCalled();
  });

  it("stops and unregisters a review sandbox when setup fails", async () => {
    mocks.installAgent.mockRejectedValueOnce(new Error("install failed"));

    await expect(
      provisionDisposableReviewWorkspaceStep({
        sourceSandboxId: "source-1",
        workspaceManifest: manifest,
        subjectKey: "ticket:jira:AIW-120",
        ownerToken: "owner-1",
        agentKind: "claude",
        model: "claude",
        arthurTaskId: null,
      }),
    ).rejects.toThrow("install failed");

    expect(mocks.stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "review-1" }),
    );
    expect(mocks.unregisterSandbox).toHaveBeenCalledWith(
      "ticket:jira:AIW-120",
      "owner-1",
      "review-1",
    );
  });

  it("verifies immutable heads, clean content, no remotes, and read-only roots", async () => {
    mocks.sandboxGet.mockResolvedValueOnce({
      sandboxId: "review-1",
      runCommand: mocks.reviewCommand,
      readFileToBuffer: mocks.reviewReadFile,
    });

    await expect(
      verifyDisposableReviewWorkspaceStep("review-1", manifest, [
        {
          repoPath: "acme/api",
          localPath: "/vercel/sandbox",
          headSha: "head-api",
        },
        {
          repoPath: "acme/web",
          localPath: "/vercel/sandbox/repos/gitlab__acme__web",
          headSha: "head-web",
        },
      ]),
    ).resolves.toEqual({ ok: true });
  });

  it("fails verification when a reviewer changes a repository head", async () => {
    mocks.reviewCommand.mockImplementation(
      async (_name: string, args: string[]) =>
        args.includes("rev-parse") ? command("changed-head") : command(),
    );
    mocks.sandboxGet.mockResolvedValueOnce({
      sandboxId: "review-1",
      runCommand: mocks.reviewCommand,
      readFileToBuffer: mocks.reviewReadFile,
    });

    await expect(
      verifyDisposableReviewWorkspaceStep("review-1", manifest, [
        {
          repoPath: "acme/api",
          localPath: "/vercel/sandbox",
          headSha: "head-api",
        },
        {
          repoPath: "acme/web",
          localPath: "/vercel/sandbox/repos/gitlab__acme__web",
          headSha: "head-web",
        },
      ]),
    ).resolves.toEqual({
      ok: false,
      error: "review workspace head changed for acme/api",
    });
  });

  it("rejects a manifest path that could escape the disposable workspace", async () => {
    const invalid = structuredClone(manifest);
    invalid.repositories[1]!.localPath = "/tmp/outside";

    await expect(
      provisionDisposableReviewWorkspaceStep({
        sourceSandboxId: "source-1",
        workspaceManifest: invalid,
        subjectKey: "ticket:jira:AIW-120",
        ownerToken: "owner-1",
        agentKind: "codex",
        model: "gpt-5",
        arthurTaskId: null,
      }),
    ).rejects.toThrow(/path is invalid/i);
    expect(mocks.sandboxGet).not.toHaveBeenCalled();
  });
});
