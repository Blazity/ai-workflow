import { Readable } from "node:stream";
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
  sourceReadStream: vi.fn(),
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
    mocks.sourceReadStream.mockResolvedValue(null);

    mocks.sandboxGet.mockResolvedValue({
      sandboxId: "source-1",
      runCommand: mocks.sourceCommand,
      readFileToBuffer: mocks.sourceReadFile,
      readFile: mocks.sourceReadStream,
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
      sourceFingerprint:
        "9b61a1f46b417353381ac12935b99eef4023fec57990a2b0984072e54bdc52fb",
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

  it("ignores restored memory and harness scratch links in the review checkout", async () => {
    await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
    });

    const excludeWrite = mocks.reviewWriteFiles.mock.calls
      .flatMap(([files]) => files as Array<{ path: string; content: Buffer }>)
      .find((file) => file.path === "/tmp/aiw-review-primary-git-excludes");
    expect(excludeWrite?.content.toString("utf8")).toBe(
      "/aiw-repos.json\n/repos/\n/blazebot/memory/\n/.codex\n/.claude\n",
    );
  });

  it("rejects setup artifacts before starting a reviewer", async () => {
    let scratchLinksCreated = false;
    mocks.reviewCommand.mockImplementation(
      async (name: string, args: string[]) => {
        if (name === "ln") scratchLinksCreated = true;
        if (args.includes("rev-parse")) return command(headForArgs(args));
        if (scratchLinksCreated && args.includes("status")) {
          return command("?? .codex");
        }
        return command();
      },
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
    ).rejects.toThrow(/not clean after setup/i);

    expect(mocks.stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "review-1" }),
    );
  });

  it("restores the session memory document before the trees are sealed", async () => {
    const order: string[] = [];
    mocks.sourceReadStream.mockImplementation(async ({ path }: { path: string }) =>
      path === "/vercel/sandbox/blazebot/memory/AIW-120.md"
        ? Readable.from([Buffer.from("# Session Memory: AIW-120\n")])
        : null,
    );
    mocks.reviewCommand.mockImplementation(
      async (name: string, args: string[]) => {
        order.push(`command:${name} ${args.join(" ")}`);
        // Nothing at that path: the checkout does not track a legacy copy.
        if (name === "test" && args[0] === "-e") return command("", "", 1);
        return args.includes("rev-parse") ? command(headForArgs(args)) : command();
      },
    );
    mocks.reviewWriteFiles.mockImplementation(
      async (files: Array<{ path: string }>) => {
        order.push(`write:${files.map((file) => file.path).join(",")}`);
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
      memoryTaskId: "AIW-120",
    });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.reviewCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/blazebot/memory",
    ]);
    const memoryWrite = order.findIndex((entry) =>
      entry === "write:/vercel/sandbox/blazebot/memory/AIW-120.md",
    );
    const excludesConfigured = order.findIndex((entry) =>
      entry.includes("core.excludesFile"),
    );
    const firstSeal = order.findIndex((entry) => entry.startsWith("command:chmod"));
    expect(excludesConfigured).toBeGreaterThanOrEqual(0);
    expect(memoryWrite).toBeGreaterThan(excludesConfigured);
    expect(memoryWrite).toBeLessThan(firstSeal);

    // The restored document is invisible to the post-review integrity check.
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

  it("truncates an oversized memory document at the store size cap", async () => {
    const oversized = Buffer.alloc(300 * 1024, 0x61);
    // Two chunks, so the read has to stop part way instead of relying on a
    // single-chunk slice.
    mocks.sourceReadStream.mockImplementation(async () =>
      Readable.from([oversized.subarray(0, 200 * 1024), oversized]),
    );
    mocks.reviewCommand.mockImplementation(async (name: string, args: string[]) => {
      if (name === "test" && args[0] === "-e") return command("", "", 1);
      return args.includes("rev-parse") ? command(headForArgs(args)) : command();
    });

    await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
      memoryTaskId: "AIW-120",
    });

    const restored = mocks.reviewWriteFiles.mock.calls
      .flatMap(([files]) => files as Array<{ path: string; content: Buffer }>)
      .find((file) => file.path === "/vercel/sandbox/blazebot/memory/AIW-120.md");
    expect(restored?.content.byteLength).toBe(256 * 1024);
  });

  it("never provisions a memory path that escapes the memory directory", async () => {
    mocks.sourceReadStream.mockResolvedValue(
      Readable.from([Buffer.from("escaped")]),
    );

    await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
      memoryTaskId: "../../etc/AIW-120",
    });

    expect(mocks.sourceReadStream).not.toHaveBeenCalled();
    expect(
      mocks.reviewWriteFiles.mock.calls
        .flatMap(([files]) => files as Array<{ path: string }>)
        .some((file) => file.path.includes("blazebot/memory")),
    ).toBe(false);
  });

  it("still provisions the review workspace when the memory restore fails", async () => {
    mocks.sourceReadStream.mockResolvedValue(
      Readable.from([Buffer.from("# Session Memory: AIW-120\n")]),
    );
    mocks.reviewCommand.mockImplementation(async (name: string, args: string[]) => {
      if (name === "test" && args[0] === "-e") return command("", "", 1);
      return args.includes("rev-parse") ? command(headForArgs(args)) : command();
    });
    mocks.reviewWriteFiles.mockImplementation(async (files: Array<{ path: string }>) => {
      if (files.some((file) => file.path.includes("blazebot/memory"))) {
        throw new Error("disk full");
      }
    });

    const result = await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
      memoryTaskId: "AIW-120",
    });

    expect(result).toMatchObject({ ok: true, sandboxId: "review-1" });
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
  });

  it("keeps a checked-out legacy memory copy instead of overwriting it", async () => {
    mocks.sourceReadStream.mockResolvedValue(
      Readable.from([Buffer.from("# Session Memory: AIW-120\n")]),
    );

    await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
      memoryTaskId: "AIW-120",
    });

    expect(
      mocks.reviewWriteFiles.mock.calls
        .flatMap(([files]) => files as Array<{ path: string }>)
        .some((file) => file.path.startsWith("/vercel/sandbox/blazebot/")),
    ).toBe(false);
  });

  it("provisions exactly as before when no memory document is requested", async () => {
    await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: manifest,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
    });

    expect(mocks.sourceReadStream).not.toHaveBeenCalled();
    expect(
      mocks.reviewWriteFiles.mock.calls
        .flatMap(([files]) => files as Array<{ path: string }>)
        .some((file) => file.path.includes("blazebot/memory")),
    ).toBe(false);
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

  it("provisions a discovery-promoted layout with every repository under repos/", async () => {
    const discovered = structuredClone(manifest);
    discovered.repositories[0]!.localPath =
      "/vercel/sandbox/repos/github__acme__api";
    mocks.sourceReadFile.mockImplementation(async ({ path }: { path: string }) =>
      path === WORKSPACE_MANIFEST_PATH
        ? Buffer.from(JSON.stringify(discovered))
        : Buffer.from(`bundle:${path}`),
    );

    const result = await provisionDisposableReviewWorkspaceStep({
      sourceSandboxId: "source-1",
      workspaceManifest: discovered,
      subjectKey: "ticket:jira:AIW-120",
      ownerToken: "owner-1",
      agentKind: "codex",
      model: "gpt-5",
      arthurTaskId: null,
    });

    expect(result).toMatchObject({ ok: true, sandboxId: "review-1" });
    if (result.ok) {
      expect(result.repositories).toEqual([
        {
          repoPath: "acme/api",
          localPath: "/vercel/sandbox/repos/github__acme__api",
          headSha: "head-api",
        },
        {
          repoPath: "acme/web",
          localPath: "/vercel/sandbox/repos/gitlab__acme__web",
          headSha: "head-web",
        },
      ]);
    }
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

  it("rejects a manifest path nested below its repos directory", async () => {
    const invalid = structuredClone(manifest);
    invalid.repositories[1]!.localPath =
      "/vercel/sandbox/repos/gitlab__acme__web/nested";

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

  it("rejects duplicate manifest paths across repositories", async () => {
    const invalid = structuredClone(manifest);
    invalid.repositories[0]!.localPath = "/vercel/sandbox";
    invalid.repositories[1]!.localPath = "/vercel/sandbox";

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
    ).rejects.toThrow(/path is duplicated/i);
    expect(mocks.sandboxGet).not.toHaveBeenCalled();
  });
});
