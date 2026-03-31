import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockStdout = vi.fn();
const mockReadFileToBuffer = vi.fn();

const mockGet = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
      readFileToBuffer: mockReadFileToBuffer,
      stop: mockStop,
    })),
    get: mockGet,
  },
}));

import { SandboxManager } from "./manager.js";

describe("SandboxManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({
      sandboxId: "sbx-reconnect-456",
      runCommand: mockRunCommand,
      getCommand: vi.fn(),
      stop: mockStop,
    });
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
      claudeModel: "claude-opus-4-6",
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
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test", "# Req");
    const result = await manager.runEndHook(sandbox);

    expect(result).toBe("clean");
  });

  it("reconnects to an existing sandbox by ID", async () => {
    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.reconnect("sbx-reconnect-456");

    expect(mockGet).toHaveBeenCalledWith({ sandboxId: "sbx-reconnect-456" });
    expect(sandbox.sandboxId).toBe("sbx-reconnect-456");
  });

  it("reconnects with explicit credentials when provided", async () => {
    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
      vercelToken: "tok_123",
      vercelTeamId: "team_456",
      vercelProjectId: "prj_789",
    });

    await manager.reconnect("sbx-reconnect-456");

    expect(mockGet).toHaveBeenCalledWith({
      sandboxId: "sbx-reconnect-456",
      token: "tok_123",
      teamId: "team_456",
      projectId: "prj_789",
    });
  });

  it("commits uncommitted changes in end hook", async () => {
    const endHookStdout = vi.fn()
      .mockResolvedValueOnce(" M src/index.ts"); // git status --porcelain
    mockRunCommand
      // provision calls (git config + pre-agent-sha + npm install + stop hook + 3 skill installs)
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") })
      // runEndHook calls
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }) // rm -rf .claude/ requirements.md
      .mockResolvedValueOnce({ exitCode: 0, stdout: endHookStdout }) // git status
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }) // git add
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }); // git commit

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test", "# Req");
    const result = await manager.runEndHook(sandbox);

    expect(result).toBe("committed");
  });
});
