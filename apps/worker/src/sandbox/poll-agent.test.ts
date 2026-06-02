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
  getVcsToken: async (config: TestVcsConfig) =>
    config.kind === "gitlab" ? config.token : "ghs_test_minted_token",
}));

import { pushFromSandbox, fixAndRetryPush, teardownSandbox, checkPhaseDone, collectPhaseOutput, collectPhase } from "./poll-agent.js";

describe("pushFromSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentVcsConfig = githubVcsConfig;
  });

  it("returns error when agent made no commits", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation(() => ({
      exitCode: 0,
      stdout: mockStdout,
    }));

    // baseSha and headSha are the same
    mockStdout
      .mockResolvedValueOnce("abc123") // cat /tmp/.pre-agent-sha
      .mockResolvedValueOnce("abc123"); // git rev-parse HEAD

    const result = await pushFromSandbox("sbx-test-123", "blazebot/task-1");

    expect(result.pushed).toBe(false);
    expect(result.error).toContain("no commits");
  });

  it("pushes successfully", async () => {
    const callIndex = { value: 0 };
    mockRunCommand.mockImplementation((..._args: unknown[]) => {
      const i = callIndex.value++;
      if (i === 0) {
        // cat /tmp/.pre-agent-sha
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("abc123") };
      } else if (i === 1) {
        // git rev-parse HEAD
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("def456") };
      } else if (i === 2) {
        // git remote set-url
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("") };
      } else {
        // git push
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
      }
    });

    const result = await pushFromSandbox("sbx-test-123", "blazebot/task-1");

    expect(result.pushed).toBe(true);
    expect(mockRunCommand).toHaveBeenCalledWith("git", ["push", "--force", "origin", "HEAD:refs/heads/blazebot/task-1"]);
  });

  it("returns error when push fails", async () => {
    const callIndex = { value: 0 };
    mockRunCommand.mockImplementation(() => {
      const i = callIndex.value++;
      if (i === 0) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("abc123") };
      } else if (i === 1) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("def456") };
      } else if (i === 2) {
        // git remote set-url
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("") };
      } else {
        // git push fails
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("pre-push hook declined"),
        };
      }
    });

    const result = await pushFromSandbox("sbx-test-123", "blazebot/task-1");

    expect(result.pushed).toBe(false);
    expect(result.error).toBe("pre-push hook declined");
  });

  it("uses GitLab oauth2 auth user and host when VCS_KIND=gitlab", async () => {
    currentVcsConfig = gitlabVcsConfig;
    const callIndex = { value: 0 };
    mockRunCommand.mockImplementation(() => {
      const i = callIndex.value++;
      if (i === 0) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("abc123") };
      } else if (i === 1) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("def456") };
      } else {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
      }
    });

    const result = await pushFromSandbox("sbx-test-123", "blazebot/task-1");

    expect(result.pushed).toBe(true);
    // Auth URL should use oauth2 + GitLab host (not x-access-token + github.com).
    expect(mockRunCommand).toHaveBeenCalledWith(
      "git",
      [
        "remote",
        "set-url",
        "origin",
        "https://oauth2:glpat_test_token@gitlab.example.com/test-group/test-repo.git",
      ],
    );
    expect(mockRunCommand).toHaveBeenCalledWith("git", ["push", "--force", "origin", "HEAD:refs/heads/blazebot/task-1"]);
  });

  it("pushes anyway when sentinel file is missing", async () => {
    const callIndex = { value: 0 };
    mockRunCommand.mockImplementation(() => {
      const i = callIndex.value++;
      if (i === 0) {
        // cat /tmp/.pre-agent-sha — missing, returns empty
        return { exitCode: 1, stdout: vi.fn().mockResolvedValue("") };
      } else if (i === 1) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("def456") };
      } else if (i === 2) {
        // git remote set-url
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("") };
      } else {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
      }
    });

    const result = await pushFromSandbox("sbx-test-123", "blazebot/task-1");

    expect(result.pushed).toBe(true);
  });
});

describe("fixAndRetryPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentVcsConfig = githubVcsConfig;
  });

  it("writes prompt to file and retries push successfully", async () => {
    const callIndex = { value: 0 };
    mockRunCommand.mockImplementation(() => {
      const i = callIndex.value++;
      if (i === 0) {
        // claude fix agent
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("") };
      } else if (i === 1) {
        // cat /tmp/fix-stdout.txt
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("Fixed lint errors") };
      } else {
        // git push retry
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
      }
    });
    mockWriteFiles.mockResolvedValue(undefined);

    const result = await fixAndRetryPush(
      "sbx-test-123", "blazebot/task-1", "lint failed", "claude", "claude-sonnet-4-20250514",
    );

    expect(result.pushed).toBe(true);
    // Verify prompt was written to file (not echoed into shell)
    expect(mockWriteFiles).toHaveBeenCalledWith([
      expect.objectContaining({ path: "/tmp/fix-prompt.txt" }),
    ]);
    // Verify push uses args array
    expect(mockRunCommand).toHaveBeenCalledWith("git", ["push", "--force", "origin", "HEAD:refs/heads/blazebot/task-1"]);
  });

  it("invokes codex CLI when agentKind=codex", async () => {
    mockRunCommand.mockImplementation(() => ({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(""),
      stderr: vi.fn().mockResolvedValue(""),
    }));
    mockWriteFiles.mockResolvedValue(undefined);

    await fixAndRetryPush(
      "sbx-test-123", "blazebot/task-1", "lint failed", "codex", "gpt-5-codex",
    );

    const fixCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args?.[1] === "string" && args[1].includes("/tmp/fix-prompt.txt"),
    );
    expect(fixCall).toBeDefined();
    expect(fixCall![1][1]).toContain("codex exec");
    expect(fixCall![1][1]).toContain("gpt-5-codex");
    expect(fixCall![1][1]).not.toContain("claude --print");
  });

  it("returns error when retry push also fails", async () => {
    const callIndex = { value: 0 };
    mockRunCommand.mockImplementation(() => {
      const i = callIndex.value++;
      if (i === 0) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("") };
      } else if (i === 1) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("") };
      } else {
        return {
          exitCode: 1,
          stdout: vi.fn().mockResolvedValue(""),
          stderr: vi.fn().mockResolvedValue("still failing"),
        };
      }
    });
    mockWriteFiles.mockResolvedValue(undefined);

    const result = await fixAndRetryPush(
      "sbx-test-123", "blazebot/task-1", "lint failed", "claude", "claude-sonnet-4-20250514",
    );

    expect(result.pushed).toBe(false);
    expect(result.error).toBe("still failing");
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
