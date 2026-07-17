import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockReadFileToBuffer = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      readFileToBuffer: mockReadFileToBuffer,
      writeFiles: mockWriteFiles,
      stop: mockStop,
    })),
  },
}));

// Must mock the module before importing
vi.mock("./credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// VCS config is swapped per-test by reassigning currentVcsConfig before the
// step under test calls getVcsConfig(). Default is GitHub; GitLab tests set
// it to a GitLab config to exercise the oauth2 auth user and gitlab host.
// Shape mirrors the discriminated union in env.ts (GitHub uses App auth, not a PAT).
type TestVcsConfig =
  | {
      kind: "github";
      auth: { appId: number; privateKeyBase64: string; installationId: number };
      repoPath: string;
      baseBranch: string;
      host: string;
    }
  | {
      kind: "gitlab";
      token: string;
      repoPath: string;
      baseBranch: string;
      host: string;
    };

const githubVcsConfig: TestVcsConfig = {
  kind: "github",
  auth: { appId: 123, privateKeyBase64: "ZmFrZS1wZW0=", installationId: 456 },
  repoPath: "test-owner/test-repo",
  baseBranch: "main",
  host: "https://github.com",
};

const gitlabVcsConfig: TestVcsConfig = {
  kind: "gitlab",
  token: "glpat_test_token",
  repoPath: "test-group/test-repo",
  baseBranch: "main",
  host: "https://gitlab.example.com",
};

let currentVcsConfig: TestVcsConfig = githubVcsConfig;

vi.mock("../../env.js", () => ({
  env: {
    VCS_KIND: "github",
    GITHUB_OWNER: "test-owner",
    GITHUB_REPO: "test-repo",
    CLAUDE_MODEL: "claude-sonnet-4-20250514",
  },
  getVcsConfig: () => currentVcsConfig,
  getVcsProviderConfig: (provider: "github" | "gitlab") =>
    provider === "gitlab" ? gitlabVcsConfig : githubVcsConfig,
  getVcsToken: async (config: TestVcsConfig) =>
    config.kind === "gitlab" ? config.token : "ghs_test_minted_token",
}));

import {
  pushWorkspaceFromSandbox,
  fixAndRetryWorkspacePush,
  teardownSandbox,
  teardownSandboxes,
  checkPhaseDone,
  collectPhaseOutput,
  collectPhase,
} from "./poll-agent.js";
import { WORKSPACE_MANIFEST_PATH } from "./repo-workspace.js";

describe("pushWorkspaceFromSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentVcsConfig = githubVcsConfig;
  });

  it("returns no-commit error when no manifest repository changed", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          slug: "acme__api",
          localPath: "/vercel/sandbox/repos/github__acme__api",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions api",
          preAgentSha: "abc123",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "git" && args.includes("rev-parse")) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("abc123") };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(result.pushed).toBe(false);
    expect(result.error).toContain("no commits");
    expect(result.repositories).toEqual([
      expect.objectContaining({ repoPath: "acme/api", changed: false, pushed: false }),
    ]);
  });

  it("pushes changed repositories only", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          slug: "github__acme__api",
          localPath: "/vercel/sandbox/repos/github__acme__api",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions api",
          preAgentSha: "abc123",
        },
        {
          provider: "github",
          repoPath: "acme/web",
          slug: "github__acme__web",
          localPath: "/vercel/sandbox/repos/github__acme__web",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions web",
          preAgentSha: "same123",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        const head = args[1].includes("github__acme__api") ? "def456" : "same123";
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(head) };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(result.pushed).toBe(true);
    expect(result.repositories).toEqual([
      expect.objectContaining({ repoPath: "acme/api", changed: true, pushed: true }),
      expect.objectContaining({ repoPath: "acme/web", changed: false, pushed: false }),
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/github__acme__api",
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "push",
      "--force",
      "origin",
      "HEAD:refs/heads/blazebot/task-1",
    ]);
    expect(mockRunCommand).not.toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/github__acme__web",
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "push",
      "--force",
      "origin",
      "HEAD:refs/heads/blazebot/task-1",
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/github__acme__api",
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/api.git",
    ]);
  });

  it("pushes mixed-provider repositories with provider-specific auth headers", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          slug: "github__acme__web",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions web",
          preAgentSha: "web-base",
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          slug: "gitlab__acme__api",
          localPath: "/vercel/sandbox/repos/gitlab__acme__api",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions api",
          preAgentSha: "api-base",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return {
          exitCode: 0,
          stdout: vi.fn().mockResolvedValue(args[1].includes("gitlab__acme__api") ? "api-head" : "web-base"),
        };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(result.pushed).toBe(true);
    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/gitlab__acme__api",
      "-c",
      expect.stringContaining("http.extraHeader=AUTHORIZATION: Basic "),
      "push",
      "--force",
      "origin",
      "HEAD:refs/heads/blazebot/task-1",
    ]);
  });

  it("continues pushing later repositories after an earlier repository push fails", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          slug: "github__acme__web",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions web",
          preAgentSha: "web-base",
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          slug: "gitlab__acme__api",
          localPath: "/vercel/sandbox/repos/gitlab__acme__api",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions api",
          preAgentSha: "api-base",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return {
          exitCode: 0,
          stdout: vi.fn().mockResolvedValue(args[1].includes("gitlab__acme__api") ? "api-head" : "web-head"),
        };
      }
      if (cmd === "git" && args[0] === "-C" && args[1] === "/vercel/sandbox" && args.includes("push")) {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("pre-push hook declined"),
        };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(result.pushed).toBe(false);
    expect(result.repositories).toEqual([
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/web",
        changed: true,
        pushed: false,
        error: "pre-push hook declined",
      }),
      expect.objectContaining({
        provider: "gitlab",
        repoPath: "acme/api",
        changed: true,
        pushed: true,
      }),
    ]);
  });

  it("keeps the push successful when credential-free remote cleanup fails", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          slug: "github__acme__web",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions web",
          preAgentSha: "web-base",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("web-head") };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "remote") {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("remote cleanup failed"),
        };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await pushWorkspaceFromSandbox("sbx-test-123");

    expect(result.pushed).toBe(true);
    expect(result.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        changed: true,
        pushed: true,
        cleanupError: "failed to reset origin after push: remote cleanup failed",
      }),
    ]);
  });

  it("throws a clear error when the workspace manifest is missing", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("cat: not found"),
        };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    await expect(pushWorkspaceFromSandbox("sbx-test-123")).rejects.toThrow(
      /workspace manifest not found in sandbox/i,
    );
  });
});

describe("fixAndRetryWorkspacePush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentVcsConfig = githubVcsConfig;
  });

  it("strips credentials, runs a fix agent, and retries the workspace push", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          slug: "github__acme__web",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions web",
          preAgentSha: "web-base",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "cat" && args[0] === "/tmp/fix-stdout.txt") {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("fixed") };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("web-head") };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await fixAndRetryWorkspacePush(
      "sbx-test-123",
      {
        pushed: false,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            branchName: "blazebot/task-1",
            changed: true,
            pushed: false,
            error: "pre-push hook declined",
          },
        ],
        error: "pre-push hook declined",
      },
      "codex",
      "gpt-5",
    );

    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/web.git",
    ]);
    expect(mockWriteFiles).toHaveBeenCalledWith([
      {
        path: "/tmp/fix-prompt.txt",
        content: expect.any(Buffer),
      },
    ]);
    const prompt = mockWriteFiles.mock.calls[0][0][0].content.toString();
    expect(prompt).toContain("github:acme/web");
    expect(prompt).toContain("pre-push hook declined");
    expect(result.pushed).toBe(true);
  });

  it("retries only failed repositories and preserves earlier successful pushes", async () => {
    const manifest = {
      version: 1,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          slug: "github__acme__web",
          localPath: "/vercel/sandbox",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions web",
          preAgentSha: "web-base",
        },
        {
          provider: "gitlab",
          repoPath: "acme/api",
          slug: "gitlab__acme__api",
          localPath: "/vercel/sandbox/repos/gitlab__acme__api",
          defaultBranch: "main",
          branchName: "blazebot/task-1",
          selectedRationale: "ticket mentions api",
          preAgentSha: "api-base",
        },
      ],
    };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify(manifest)) };
      }
      if (cmd === "cat" && args[0] === "/tmp/fix-stdout.txt") {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("fixed") };
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("api-head") };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await fixAndRetryWorkspacePush(
      "sbx-test-123",
      {
        pushed: false,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            branchName: "blazebot/task-1",
            changed: true,
            pushed: true,
          },
          {
            provider: "gitlab",
            repoPath: "acme/api",
            branchName: "blazebot/task-1",
            changed: true,
            pushed: false,
            error: "protected branch",
          },
        ],
        error: "protected branch",
      },
      "codex",
      "gpt-5",
    );

    expect(mockRunCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/gitlab__acme__api",
      "remote",
      "set-url",
      "origin",
      "https://gitlab.example.com/acme/api.git",
    ]);
    expect(mockRunCommand).not.toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/web.git",
    ]);
    const prompt = mockWriteFiles.mock.calls[0][0][0].content.toString();
    expect(prompt).toContain("gitlab:acme/api");
    expect(prompt).not.toContain("github:acme/web");
    expect(result).toEqual({
      pushed: true,
      repositories: [
        expect.objectContaining({
          provider: "github",
          repoPath: "acme/web",
          changed: true,
          pushed: true,
        }),
        expect.objectContaining({
          provider: "gitlab",
          repoPath: "acme/api",
          changed: true,
          pushed: true,
        }),
      ],
    });
  });
});

describe("teardownSandbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops the sandbox", async () => {
    await teardownSandbox("sbx-test-123");
    expect(mockStop).toHaveBeenCalled();
  });

  it("does not throw on error", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));

    await expect(teardownSandbox("sbx-test-123")).resolves.not.toThrow();
  });
});

describe("teardownSandboxes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tears down every distinct id once, de-duplicated", async () => {
    const teardown = vi.fn().mockResolvedValue(undefined);

    await teardownSandboxes(["sbx-a", "sbx-b", "sbx-a"], teardown);

    expect(teardown).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledWith("sbx-a");
    expect(teardown).toHaveBeenCalledWith("sbx-b");
  });

  it("keeps tearing down the rest when one teardown fails (best-effort)", async () => {
    const teardown = vi
      .fn()
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValue(undefined);

    await expect(teardownSandboxes(["sbx-a", "sbx-b", "sbx-c"], teardown)).resolves.not.toThrow();

    expect(teardown).toHaveBeenCalledTimes(3);
    expect(teardown).toHaveBeenCalledWith("sbx-a");
    expect(teardown).toHaveBeenCalledWith("sbx-b");
    expect(teardown).toHaveBeenCalledWith("sbx-c");
  });

  it("defaults to the real teardownSandbox when no teardown is injected", async () => {
    await teardownSandboxes(["sbx-test-123"]);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});

describe("checkPhaseDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });

    const result = await checkPhaseDone("sbx-test-123", "/tmp/phase-1-done");
    expect(result).toBe(true);
    expect(mockRunCommand).toHaveBeenCalledWith("test", ["-f", "/tmp/phase-1-done"]);
  });

  it("returns false when sentinel file is missing", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });

    const result = await checkPhaseDone("sbx-test-123", "/tmp/phase-1-done");
    expect(result).toBe(false);
  });

  it("returns 'stopped' when sandbox is not running", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sandboxId: "sbx-test-123",
      status: "stopped",
      runCommand: mockRunCommand,
    });

    const result = await checkPhaseDone("sbx-test-123", "/tmp/phase-1-done");
    expect(result).toBe("stopped");
  });

  it("returns 'stopped' when sandbox is unreachable", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));

    const result = await checkPhaseDone("sbx-test-123", "/tmp/phase-1-done");
    expect(result).toBe("stopped");
  });
});

describe("collectPhaseOutput", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads from custom output file paths", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation(() => ({
      exitCode: 0,
      stdout: mockStdout,
    }));

    mockStdout
      .mockResolvedValueOnce("phase output content") // stdout file
      .mockResolvedValueOnce(""); // stderr file

    const result = await collectPhaseOutput(
      "sbx-test-123",
      "/tmp/phase-1-stdout.txt",
      "/tmp/phase-1-stderr.txt",
    );

    expect(result).toBe("phase output content");
    expect(mockRunCommand).toHaveBeenCalledWith("cat", ["/tmp/phase-1-stdout.txt"]);
    expect(mockRunCommand).toHaveBeenCalledWith("cat", ["/tmp/phase-1-stderr.txt"]);
  });

  it("returns stderr when stdout is empty", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation(() => ({
      exitCode: 0,
      stdout: mockStdout,
    }));

    mockStdout
      .mockResolvedValueOnce("") // stdout file empty
      .mockResolvedValueOnce("error details from phase"); // stderr file

    const result = await collectPhaseOutput(
      "sbx-test-123",
      "/tmp/phase-1-stdout.txt",
      "/tmp/phase-1-stderr.txt",
    );

    expect(result).toBe("error details from phase");
  });
});

describe("collectPhase", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns raw + structured when structuredOutput is set", async () => {
    mockRunCommand.mockImplementation((_cmd: string, args: string[]) => {
      const file = args[0];
      const text =
        file.includes("stdout") ? "ndjson body" :
        file.includes("stderr") ? "" :
        file.includes("result") ? '{"result":"implemented"}' :
        "";
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(text) };
    });

    const result = await collectPhase("sbx-test-123", {
      stdout: "/tmp/impl-stdout.txt",
      stderr: "/tmp/impl-stderr.txt",
      structuredOutput: "/tmp/impl-result.json",
    });

    expect(result.raw).toBe("ndjson body");
    expect(result.structured).toBe('{"result":"implemented"}');
  });

  it("returns structured=null when paths.structuredOutput is null", async () => {
    mockRunCommand.mockImplementation((_cmd: string, args: string[]) => {
      const file = args[0];
      const text = file.includes("stdout") ? "raw text" : "";
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(text) };
    });

    const r = await collectPhase("sbx-test-123", {
      stdout: "/tmp/impl-stdout.txt",
      stderr: "/tmp/impl-stderr.txt",
      structuredOutput: null,
    });
    expect(r.structured).toBeNull();
    expect(r.raw).toBe("raw text");
  });

  it("falls back to stderr when stdout is empty", async () => {
    mockRunCommand.mockImplementation((_cmd: string, args: string[]) => {
      const file = args[0];
      const text =
        file.includes("stdout") ? "" :
        file.includes("stderr") ? "stderr text" :
        "";
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(text) };
    });

    const r = await collectPhase("sbx-test-123", {
      stdout: "/tmp/impl-stdout.txt",
      stderr: "/tmp/impl-stderr.txt",
      structuredOutput: null,
    });
    expect(r.raw).toBe("stderr text");
  });
});
