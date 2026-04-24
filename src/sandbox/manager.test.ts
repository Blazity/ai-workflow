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
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
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

  it("writes agent-env.sh with auth credentials during provision", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    await manager.provision("feat/test-branch");

    // writeFiles should be called once — to persist auth env vars to /tmp/agent-env.sh
    expect(mockWriteFiles).toHaveBeenCalledTimes(1);
    const [[files]] = mockWriteFiles.mock.calls;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/tmp/agent-env.sh");
    const content = Buffer.from(files[0].content).toString();
    expect(content).toContain("ANTHROPIC_API_KEY");
    expect(content).toContain("sk-ant-test");
    expect(content).not.toContain("CLAUDE_MODEL");
  });

  it("writes CLAUDE_CODE_OAUTH_TOKEN when OAuth token is provided", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      claudeCodeOauthToken: "oauth-token-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    await manager.provision("feat/test-branch");

    const [[files]] = mockWriteFiles.mock.calls;
    const content = Buffer.from(files[0].content).toString();
    expect(content).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(content).toContain("oauth-token-test");
    expect(content).not.toContain("ANTHROPIC_API_KEY");
  });

  it("enabling the stop hook runs a node merge script that adds commit-guard", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });
    const sandbox = await manager.provision("feat/test-branch");
    mockRunCommand.mockClear();

    await manager.configureStopHook(sandbox, true);

    const mergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes("commit-guard.sh") &&
        c[1][2].includes('"commitGuard":"enable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("disabling the stop hook runs a node merge script with commitGuard=disable", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });
    const sandbox = await manager.provision("feat/test-branch");
    mockRunCommand.mockClear();

    await manager.configureStopHook(sandbox, false);

    const mergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes('"commitGuard":"disable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("configureStopHookInSandbox works with any sandbox-like object", async () => {
    const fakeSandbox = { runCommand: mockRunCommand };
    mockRunCommand.mockClear();

    await configureStopHookInSandbox(fakeSandbox as any, true);

    const mergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes('"commitGuard":"enable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("installs Arthur tracer when config.arthur is set", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
      arthur: {
        apiKey: "test-key",
        taskId: "00000000-0000-4000-8000-000000000000",
        endpoint: "https://example.ngrok.app/api/v1/traces",
      },
    });

    await manager.provision("feat/test-branch");

    const pipCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "bash" &&
        typeof c[1]?.[1] === "string" &&
        c[1][1].includes("ensurepip") &&
        c[1][1].includes("python3 -m pip install") &&
        c[1][1].includes("opentelemetry-sdk") &&
        c[1][1].includes("opentelemetry-exporter-otlp-proto-http"),
    );
    expect(pipCall).toBeDefined();

    const arthurMergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes('"arthur":"install"') &&
        c[1][2].includes("user_prompt_submit") &&
        c[1][2].includes("pre_tool") &&
        c[1][2].includes("post_tool") &&
        c[1][2].includes("post_tool_failure"),
    );
    expect(arthurMergeCall).toBeDefined();
  });

  it("skips Arthur install when config.arthur is undefined", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    await manager.provision("feat/test-branch");

    const pipCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "bash" &&
        typeof c[1]?.[1] === "string" &&
        c[1][1].includes("python3 -m pip install"),
    );
    expect(pipCall).toBeUndefined();
  });

  it("Arthur install writes arthur_config.json and the tracer script", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
      arthur: {
        apiKey: "test-key",
        taskId: "00000000-0000-4000-8000-000000000000",
        endpoint: "https://example.ngrok.app/api/v1/traces",
      },
    });

    await manager.provision("feat/test-branch");

    // Every writeFiles call passes an array of { path, content }. Flatten them.
    const written = mockWriteFiles.mock.calls.flatMap(([files]: any[]) => files);
    const tracerFile = written.find((f: any) => f.path.endsWith("arthur-tracer.py"));
    expect(tracerFile).toBeDefined();
    expect(Buffer.isBuffer(tracerFile.content)).toBe(true);
    expect(tracerFile.content.length).toBeGreaterThan(1000);

    const configFile = written.find((f: any) => f.path.endsWith("arthur_config.json"));
    expect(configFile).toBeDefined();
    const cfg = JSON.parse(Buffer.from(configFile.content).toString());
    expect(cfg).toEqual({
      api_key: "test-key",
      task_id: "00000000-0000-4000-8000-000000000000",
      endpoint: "https://example.ngrok.app/api/v1/traces",
    });
  });

});
