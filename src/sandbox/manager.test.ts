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

import { SandboxManager, configureStopHookInSandbox } from "./manager.js";

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
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test-branch");

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
    expect(sandbox.sandboxId).toBe("sbx-test-123");
  });

  it("does not write wrapper script or requirements during provision", async () => {
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

    await manager.provision("feat/test-branch");

    // writeFiles should not be called during provision (no wrapper script or requirements)
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it("configures stop hook when enabled", async () => {
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

    const sandbox = await manager.provision("feat/test-branch");
    await manager.configureStopHook(sandbox, true);

    // Should have called runCommand with the commit-guard script
    const calls = mockRunCommand.mock.calls.map((c: any[]) => c[0] === "bash" ? c[1]?.[1] ?? c[1]?.[0] : "");
    const hookCall = calls.find((c: string) => typeof c === "string" && c.includes("commit-guard"));
    expect(hookCall).toBeDefined();
  });

  it("clears stop hook when disabled", async () => {
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

    const sandbox = await manager.provision("feat/test-branch");
    mockRunCommand.mockClear();
    await manager.configureStopHook(sandbox, false);

    // Should write empty settings
    const calls = mockRunCommand.mock.calls;
    const clearCall = calls.find((c: any[]) =>
      c[0] === "bash" && typeof c[1]?.[1] === "string" && c[1][1].includes("'{}' > ~/.claude/settings.json"),
    );
    expect(clearCall).toBeDefined();
  });

  it("configureStopHookInSandbox works with any sandbox-like object", async () => {
    const fakeSandbox = { runCommand: mockRunCommand };

    mockRunCommand.mockClear();
    await configureStopHookInSandbox(fakeSandbox as any, true);

    const hookCall = mockRunCommand.mock.calls.find(
      (c: any[]) => c[0] === "bash" && typeof c[1]?.[1] === "string" && c[1][1].includes("commit-guard"),
    );
    expect(hookCall).toBeDefined();
  });

});
