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

vi.mock("../../env.js", () => ({
  env: {
    GITHUB_TOKEN: "ghp_test_token",
    GITHUB_OWNER: "test-owner",
    GITHUB_REPO: "test-repo",
    CLAUDE_MODEL: "claude-sonnet-4-20250514",
  },
}));

import { checkAgentDone, collectAgentOutput, pushFromSandbox, fixAndRetryPush, teardownSandbox } from "./poll-agent.js";

describe("checkAgentDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns false when sentinel file does not exist", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe(false);
  });

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe(true);
  });

  it("returns 'stopped' when sandbox is not running", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sandboxId: "sbx-test-123",
      status: "stopped",
      runCommand: mockRunCommand,
    });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe("stopped");
  });
});

describe("collectAgentOutput", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns failure when sandbox is unreachable", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));

    const result = await collectAgentOutput("sbx-test-123");

    expect(result.output.result).toBe("failed");
    expect(result.output.error).toContain("unreachable");
  });

  it("reads stdout and stderr and parses agent output", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation(() => ({
      exitCode: 0,
      stdout: mockStdout,
    }));

    mockStdout
      .mockResolvedValueOnce(JSON.stringify({ result: "implemented", summary: "Done" })) // stdout
      .mockResolvedValueOnce(""); // stderr

    const result = await collectAgentOutput("sbx-test-123");

    expect(result.output.result).toBe("implemented");
  });
});

describe("pushFromSandbox", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("pushes successfully when agent made commits", async () => {
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
    // Verify git push was called with args array (no shell injection)
    expect(mockRunCommand).toHaveBeenCalledWith("git", ["push", "origin", "HEAD:refs/heads/blazebot/task-1"]);
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
  beforeEach(() => vi.clearAllMocks());

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

    const result = await fixAndRetryPush("sbx-test-123", "blazebot/task-1", "lint failed");

    expect(result.pushed).toBe(true);
    // Verify prompt was written to file (not echoed into shell)
    expect(mockWriteFiles).toHaveBeenCalledWith([
      expect.objectContaining({ path: "/tmp/fix-prompt.txt" }),
    ]);
    // Verify push uses args array
    expect(mockRunCommand).toHaveBeenCalledWith("git", ["push", "origin", "HEAD:refs/heads/blazebot/task-1"]);
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

    const result = await fixAndRetryPush("sbx-test-123", "blazebot/task-1", "lint failed");

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
