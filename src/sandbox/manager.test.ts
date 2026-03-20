import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockStdout = vi.fn();
const mockReadFileToBuffer = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
      readFileToBuffer: mockReadFileToBuffer,
      stop: mockStop,
    })),
  },
}));

import { SandboxManager } from "./manager.js";

describe("SandboxManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCommand.mockResolvedValue({
      exitCode: 0,
      stdout: mockStdout,
    });
    mockStdout.mockResolvedValue("");
    mockWriteFiles.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  it("provisions sandbox with git source and env vars", async () => {
    const { Sandbox } = await import("@vercel/sandbox");

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-sonnet-4-20250514",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test-branch", "# Requirements\n...");

    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          type: "git",
          revision: "feat/test-branch",
        }),
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-ant-test",
        }),
      }),
    );
    expect(mockWriteFiles).toHaveBeenCalled();
    expect(sandbox.sandboxId).toBe("sbx-test-123");
  });

  it("runs end hook and detects clean state", async () => {
    mockStdout.mockResolvedValueOnce("");

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-sonnet-4-20250514",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test", "# Req");
    const result = await manager.runEndHook(sandbox);

    expect(result).toBe("clean");
  });

  it("commits uncommitted changes in end hook", async () => {
    const endHookStdout = vi.fn()
      .mockResolvedValueOnce(" M src/index.ts"); // git status --porcelain
    mockRunCommand
      // provision calls (git config + npm install)
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      // runEndHook calls
      .mockResolvedValueOnce({ exitCode: 0, stdout: endHookStdout }) // git status
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }) // git add
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }); // git commit

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-sonnet-4-20250514",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test", "# Req");
    const result = await manager.runEndHook(sandbox);

    expect(result).toBe("committed");
  });
});
