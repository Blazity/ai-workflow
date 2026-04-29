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

describe("SandboxManager.provision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCommand.mockResolvedValue({ exitCode: 0, stdout: mockStdout });
    mockStdout.mockResolvedValue("");
    mockWriteFiles.mockResolvedValue(undefined);
  });

  const baseConfig = {
    kind: "github" as const,
    token: "ghp_test",
    repoPath: "test-org/test-repo",
    host: "https://github.com",
    jobTimeoutMs: 1_800_000,
    commitAuthor: "ai-workflow-blazity",
    commitEmail: "bot@blazity.com",
  };

  it("creates the sandbox with a git source pointed at the branch", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" });
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ type: "git", revision: "feat/test-branch" }),
        runtime: "node24",
      }),
    );
  });

  it("sets git identity to commitAuthor / commitEmail", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" });
    const idCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args[1] === "string" && args[1].includes("git config user.name"),
    );
    expect(idCall).toBeDefined();
    expect(idCall![1][1]).toContain("ai-workflow-blazity");
    expect(idCall![1][1]).toContain("bot@blazity.com");
  });

  it("captures pre-agent HEAD SHA for the push step", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" });
    const shaCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args[1] === "string" && args[1].includes("/tmp/.pre-agent-sha"),
    );
    expect(shaCall).toBeDefined();
  });

  it("calls agent.install then agent.configure with the supplied opts", async () => {
    const agent = makeFakeAgent();
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", agent, {
      anthropicApiKey: "sk-ant-test",
      model: "claude-opus-4-6",
    });
    const ops = (agent as any).calls.map((c: any) => c.op);
    expect(ops).toEqual(["install", "configure"]);
    expect((agent as any).calls[1].opts).toEqual(
      expect.objectContaining({ anthropicApiKey: "sk-ant-test", model: "claude-opus-4-6" }),
    );
  });

  it("fetches and merges mergeBase when supplied", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" }, "main");
    const fetchCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args[1] === "string" && args[1].includes("git fetch"),
    );
    expect(fetchCall).toBeDefined();
    expect(fetchCall![1][1]).toContain("main");
  });
});
