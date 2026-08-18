import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrePrCheckConfig } from "./config.js";
import { WORKSPACE_MANIFEST_PATH } from "../sandbox/repo-workspace.js";
import { createRunBudgetState } from "../workflows/run-budget.js";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
    })),
  },
}));

vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { runPrePrChecksWithFixes } from "./runner.js";

const config: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      commands: ["pnpm typecheck"],
    },
    {
      provider: "gitlab",
      repoPath: "acme/api",
      commands: ["pnpm test"],
    },
  ],
};

const manifest = {
  version: 1,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      slug: "github__acme__web",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "blazebot/aiw-52",
      selectedRationale: "ticket mentions web",
      preAgentSha: "web-base",
    },
    {
      provider: "gitlab",
      repoPath: "acme/api",
      slug: "gitlab__acme__api",
      localPath: "/vercel/sandbox/repos/gitlab__acme__api",
      defaultBranch: "main",
      branchName: "blazebot/aiw-52",
      selectedRationale: "ticket mentions api",
      preAgentSha: "api-base",
    },
  ],
};

describe("runPrePrChecksWithFixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs configured checks only for changed repositories", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, args[1] === "/vercel/sandbox" ? "web-head" : "api-base");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes("sbx-test-123", config, "codex", "gpt-5");

    expect(result.outcome).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(0);
    expect(result.results).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm typecheck",
        exitCode: 0,
      },
    ]);
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-lc", "pnpm typecheck"],
      cwd: "/vercel/sandbox",
    });
    expect(mockRunCommand).not.toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-lc", "pnpm test"],
      cwd: "/vercel/sandbox/repos/gitlab__acme__api",
    });
  });

  it("reports missing configuration without changing legacy pass behavior", async () => {
    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      { repositories: [] },
      "codex",
      "gpt-5",
    );

    expect(result).toMatchObject({
      outcome: "missing_configuration",
      passed: true,
      results: [],
      failures: [],
      summary: "No pre-PR checks configured.",
    });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it("retains every ordered command result after an ordinary command failure", async () => {
    const commands = ["pnpm lint", "pnpm test"];
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      const command = (cmd as { args?: string[] })?.args?.[1];
      if (command === "pnpm lint") return commandResult(1, "", "lint failed");
      if (command === "pnpm test") return commandResult(0, "tests passed");
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      {
        repositories: [{
          provider: "github",
          repoPath: "acme/web",
          commands,
        }],
      },
      "codex",
      "gpt-5",
      0,
    );

    expect(result.outcome).toBe("failed");
    expect(result.results).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm lint",
        exitCode: 1,
      },
      {
        provider: "github",
        repoPath: "acme/web",
        command: "pnpm test",
        exitCode: 0,
      },
    ]);
    expect(result.failures).toHaveLength(1);
  });

  it("runs a repository's setup commands before its checks, in authored order", async () => {
    const shellCommands: string[] = [];
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      const shell = shellCommand(cmd);
      if (shell) shellCommands.push(shell);
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            setup: ["make bootstrap", "make deps"],
            commands: ["pnpm typecheck"],
          },
        ],
      },
      "codex",
      "gpt-5",
      0,
    );

    expect(result.passed).toBe(true);
    expect(result.setupFailed).toBe(false);
    expect(shellCommands).toEqual(["make bootstrap", "make deps", "pnpm typecheck"]);
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-lc", "make bootstrap"],
      cwd: "/vercel/sandbox",
    });
  });

  it("stops a repository's checks and runs no fix cycles when its setup fails", async () => {
    const shellCommands: string[] = [];
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex");
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      const shell = shellCommand(cmd);
      if (shell) {
        shellCommands.push(shell);
        if (shell === "make bootstrap") {
          return commandResult(127, "", "bash: line 1: toolchain: command not found");
        }
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            setup: ["make bootstrap"],
            commands: ["pnpm typecheck"],
          },
        ],
      },
      "codex",
      "gpt-5",
    );

    expect(result.passed).toBe(false);
    expect(result.setupFailed).toBe(true);
    expect(result.fixCycles).toBe(0);
    expect(result.results).toEqual([]);
    expect(shellCommands).toEqual(["make bootstrap"]);
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it("reports a setup failure distinctly from a check failure", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "changed-head");
      }
      const shell = shellCommand(cmd);
      if (shell === "make bootstrap") {
        return commandResult(127, "", "bash: line 1: toolchain: command not found");
      }
      if (shell === "pnpm test") return commandResult(1, "", "2 tests failed");
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            setup: ["make bootstrap"],
            commands: ["pnpm typecheck"],
          },
          { provider: "gitlab", repoPath: "acme/api", commands: ["pnpm test"] },
        ],
      },
      "codex",
      "gpt-5",
      0,
    );

    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
      provider: "github",
      repoPath: "acme/web",
      command: "make bootstrap",
      exitCode: 127,
      phase: "setup",
    });
    expect(result.failures[1]).toMatchObject({
      provider: "gitlab",
      repoPath: "acme/api",
      command: "pnpm test",
    });
    expect(result.failures[1]!.phase).toBeUndefined();
    expect(result.summary).toContain("SETUP FAILED for github:acme/web");
    expect(result.summary).toContain("toolchain: command not found");
    expect(result.summary).toContain("no agent fix cycles were run");
    expect(result.summary).toContain("gitlab:acme/api");
    expect(result.summary).not.toContain("SETUP FAILED for gitlab:acme/api");
  });

  it("fails a check that exits 0 while reporting its dependencies are not installed", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      // The check tool self-skips on missing deps and exits 0.
      return commandResult(
        0,
        "Yarn checks were blocked because dependencies are not installed",
      );
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      { repositories: [config.repositories[0]!] },
      "codex",
      "gpt-5",
      0,
    );

    expect(result.outcome).toBe("failed");
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      provider: "github",
      repoPath: "acme/web",
      command: "pnpm typecheck",
    });
    expect(result.summary.toLowerCase()).toContain("did not actually run");
  });

  it("treats inability to inspect a repository as an execution failure", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(128, "", "repository disappeared");
      }
      return commandResult(0, "");
    });

    await expect(
      runPrePrChecksWithFixes("sbx-test-123", config, "codex", "gpt-5"),
    ).rejects.toThrow("Could not inspect workspace HEAD for github:acme/web");
  });

  it("sends failed check logs back to the agent and retries", async () => {
    let checkRuns = 0;
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "claude");
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return checkRuns === 1
          ? commandResult(1, "", "Type error on line 12")
          : commandResult(0, "ok");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes("sbx-test-123", config, "claude", "claude-opus-4-6");

    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(1);
    expect(mockWriteFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          path: "/tmp/pre-pr-fix-1-requirements.md",
          content: expect.any(Buffer),
        },
        {
          path: "/tmp/pre-pr-fix-1-wrapper.sh",
          content: expect.any(Buffer),
        },
      ]),
    );
    const prompt = mockWriteFiles.mock.calls[0][0]
      .find((file: { path: string; content: Buffer }) => file.path.endsWith("requirements.md"))
      .content.toString();
    expect(prompt).toContain("github:acme/web");
    expect(prompt).toContain("Type error on line 12");
  });

  it("returns authoritative Claude usage for every launched fix cycle", async () => {
    let checkRuns = 0;
    const claudeOutput = JSON.stringify({
      type: "result",
      cost_usd: 0.42,
      duration_ms: 12_000,
      duration_api_ms: 10_000,
      num_turns: 2,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
      },
    });
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "claude", claudeOutput);
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return checkRuns === 1
          ? commandResult(1, "", "Type error")
          : commandResult(0, "ok");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      config,
      "claude",
      "claude-opus-4-6",
    );

    expect(result.fixCycleUsages).toEqual([
      {
        cost_usd: 0.42,
        tokens: { input: 120, cached_input: 30, output: 40 },
        duration_ms: 12_000,
        duration_api_ms: 10_000,
        num_turns: 2,
      },
    ]);
    const wrapper = mockWriteFiles.mock.calls[0][0]
      .find((file: { path: string; content: Buffer }) => file.path.endsWith("wrapper.sh"))
      .content.toString();
    expect(wrapper).toContain("claude");
    expect(wrapper).toContain("--output-format json");
  });

  it("returns null usage for a launched fix cycle whose CLI output has no usage", async () => {
    let checkRuns = 0;
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex");
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return checkRuns === 1
          ? commandResult(1, "", "Type error")
          : commandResult(0, "ok");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      config,
      "codex",
      "gpt-5",
    );

    expect(result.fixCycles).toBe(1);
    expect(result.fixCycleUsages).toEqual([null]);
  });

  it("returns an execution failure when the repair process exits nonzero", async () => {
    let checkRuns = 0;
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex", undefined, 7);
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      { repositories: [config.repositories[0]!] },
      "codex",
      "gpt-5",
    );

    expect(result.passed).toBe(false);
    expect(result.fixCycles).toBe(1);
    expect(result.agentFailure).toMatchObject({
      category: "provider",
      diagnostic: {
        failureKind: "cli_exit",
        exitCode: 7,
        detail: "The CLI exited with code 7.",
      },
    });
    expect(checkRuns).toBe(1);
  });

  it("names the cause when the repair process cannot be launched at all", async () => {
    // Production runs died here with a failure that named only the boundary:
    // no exit code, no captured bytes, and the thrown error destroyed at the
    // catch. Every distinct launch cause has to reach the run record instead.
    const launchWith = (thrown: unknown) => {
      mockRunCommand.mockImplementation((cmd, args) => {
        if (isWrapperLaunch(cmd)) throw thrown;
        if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
          return commandResult(0, JSON.stringify(manifest));
        }
        if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
          return commandResult(0, "web-head");
        }
        if (isConfiguredCheck(cmd)) return commandResult(1, "", "still failing");
        return commandResult(0, "");
      });
      return runPrePrChecksWithFixes(
        "sbx-test-123",
        { repositories: [config.repositories[0]!] },
        "codex",
        "gpt-5",
      );
    };

    const reset = await launchWith(new Error("sandbox connection reset"));
    expect(reset.agentFailure).toMatchObject({
      diagnostic: {
        failureKind: "setup_failed",
        detail: expect.stringContaining("sandbox connection reset"),
      },
    });

    const refused = await launchWith(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    );
    expect(refused.agentFailure?.diagnostic.detail).toContain(
      "ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443",
    );
  });

  it("bounds a very long launch failure cause instead of embedding it whole", async () => {
    const thrownMessage = "sandbox refused the launch. ".repeat(200);
    mockRunCommand.mockImplementation((cmd, args) => {
      if (isWrapperLaunch(cmd)) throw new Error(thrownMessage);
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) return commandResult(1, "", "still failing");
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      { repositories: [config.repositories[0]!] },
      "codex",
      "gpt-5",
    );

    const detail = result.agentFailure?.diagnostic.detail ?? "";
    expect(detail).toContain("The Pre-PR repair process could not be launched:");
    expect(detail).not.toContain(thrownMessage);
    // Sentence plus the bound the repair cause is clamped to, and nothing more,
    // so a runaway error text cannot become the run status.
    expect(detail.length).toBeLessThanOrEqual(
      "The Pre-PR repair process could not be launched: ".length + 200,
    );
  });

  it("keeps valid repair usage when malformed protocol output becomes an execution failure", async () => {
    let checkRuns = 0;
    const malformedWithUsage = [
      JSON.stringify({ type: "thread.started", thread_id: "normalized" }),
      "{malformed",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
      }),
    ].join("\n");
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex", malformedWithUsage);
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      { repositories: [config.repositories[0]!] },
      "codex",
      "gpt-5",
    );

    expect(result.agentFailure).toMatchObject({
      category: "parsing",
      diagnostic: { failureKind: "invalid_json" },
    });
    expect(result.fixCycleUsages).toEqual([
      {
        cost_usd: null,
        tokens: { input: 8, cached_input: 2, output: 3 },
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
      },
    ]);
    expect(checkRuns).toBe(1);
  });

  it("stops before another check or fixer when the first fix cycle exceeds the token cap", async () => {
    let checkRuns = 0;
    const oneRepoConfig: PrePrCheckConfig = { repositories: [config.repositories[0]!] };
    const codexOutput = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
    });
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex", codexOutput);
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      oneRepoConfig,
      "codex",
      "gpt-5",
      3,
      undefined,
      {
        state: createRunBudgetState(),
        limits: { maxDurationMs: 60_000, maxTokens: 12 },
        price: { input: 0.001, cached_input: 0.0001, output: 0.002 },
      },
    );

    expect(result.fixCycles).toBe(1);
    expect(result.fixCycleUsages).toHaveLength(1);
    expect(result.budgetFailure).toMatchObject({
      status: "budget_exceeded",
      metric: "tokens",
      limit: 12,
      consumed: 13,
    });
    expect(checkRuns).toBe(1);
    expect(mockWriteFiles).toHaveBeenCalledTimes(1);
  });

  it("stops before cycle two when the first fix cycle has unknown capped usage", async () => {
    let checkRuns = 0;
    const oneRepoConfig: PrePrCheckConfig = { repositories: [config.repositories[0]!] };
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex");
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        checkRuns++;
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes(
      "sbx-test-123",
      oneRepoConfig,
      "codex",
      "gpt-5",
      3,
      undefined,
      {
        state: createRunBudgetState(),
        limits: { maxDurationMs: 60_000, maxTokens: 100 },
        price: { input: 0.001, cached_input: 0.0001, output: 0.002 },
      },
    );

    expect(result.fixCycleUsages).toEqual([null]);
    expect(result.budgetFailure).toMatchObject({
      status: "budget_unverifiable",
      metric: "tokens",
      limit: 100,
    });
    expect(checkRuns).toBe(1);
    expect(mockWriteFiles).toHaveBeenCalledTimes(1);
  });

  it("fails after three unsuccessful fix cycles", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex");
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes("sbx-test-123", config, "codex", "gpt-5");

    expect(result.passed).toBe(false);
    expect(result.fixCycles).toBe(3);
    expect(result.summary).toContain("still failing");
  });

  it("caps fix cycles at a caller-supplied maxFixCycles", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      const artifact = phaseArtifactCommand(cmd, args, "codex");
      if (artifact) return artifact;
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes("sbx-test-123", config, "codex", "gpt-5", 1);

    expect(result.passed).toBe(false);
    expect(result.fixCycles).toBe(1);
  });

  it("runs no fix cycles when maxFixCycles is 0", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        return commandResult(1, "", "still failing");
      }
      return commandResult(0, "");
    });

    const result = await runPrePrChecksWithFixes("sbx-test-123", config, "codex", "gpt-5", 0);

    expect(result.passed).toBe(false);
    expect(result.fixCycles).toBe(0);
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it("passes one deadline signal to long checks and starts no later command or fix cycle", async () => {
    let startedChecks = 0;
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (isHeadInspection(cmd)) {
        return commandResult(0, "web-head");
      }
      if (cmd === "git" && args[0] === "-C" && args[2] === "rev-parse") {
        return commandResult(0, "web-head");
      }
      if (isConfiguredCheck(cmd)) {
        expect((cmd as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
        startedChecks += 1;
        throw new DOMException("duration expired", "TimeoutError");
      }
      return commandResult(0, "");
    });

    await expect(
      runPrePrChecksWithFixes("sbx-test-123", config, "codex", "gpt-5", 3, 25),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(startedChecks).toBe(1);
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });
});

function commandResult(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

function phaseArtifactCommand(
  cmd: unknown,
  args: unknown,
  provider: "claude" | "codex",
  stdout = provider === "claude"
    ? JSON.stringify({ type: "result", subtype: "success", is_error: false })
    : JSON.stringify({ type: "turn.completed" }),
  phaseExitCode = 0,
) {
  if (cmd !== "cat" || !Array.isArray(args) || typeof args[0] !== "string") return null;
  const path = args[0];
  if (!path.startsWith("/tmp/pre-pr-fix-")) return null;
  if (path.endsWith("-stdout.txt")) return commandResult(0, stdout);
  if (path.endsWith("-stderr.txt")) return commandResult(0, "");
  if (path.endsWith("-exit-code")) return commandResult(0, String(phaseExitCode));
  if (path.endsWith("-result.json")) return commandResult(0, "repair complete");
  return null;
}

/** The shell command text of a `bash -lc` invocation, or null for anything else. */
function shellCommand(cmd: unknown): string | null {
  const objectCommand = cmd as { cmd?: unknown; args?: unknown };
  if (
    typeof cmd === "object" &&
    cmd !== null &&
    objectCommand.cmd === "bash" &&
    Array.isArray(objectCommand.args) &&
    objectCommand.args[0] === "-lc" &&
    typeof objectCommand.args[1] === "string"
  ) {
    return objectCommand.args[1];
  }
  return null;
}

function isConfiguredCheck(cmd: unknown): boolean {
  const objectCommand = cmd as { cmd?: unknown; args?: unknown };
  return (
    typeof cmd === "object" &&
    cmd !== null &&
    "cmd" in cmd &&
    objectCommand.cmd === "bash" &&
    Array.isArray(objectCommand.args) &&
    objectCommand.args.includes("pnpm typecheck")
  );
}

function isWrapperLaunch(cmd: unknown): boolean {
  const objectCommand = cmd as { cmd?: unknown; args?: unknown };
  return (
    typeof cmd === "object" &&
    cmd !== null &&
    objectCommand.cmd === "bash" &&
    Array.isArray(objectCommand.args) &&
    typeof objectCommand.args[0] === "string" &&
    objectCommand.args[0].endsWith("-wrapper.sh")
  );
}

function isHeadInspection(cmd: unknown): boolean {
  const objectCommand = cmd as { cmd?: unknown; args?: unknown };
  return (
    typeof cmd === "object" &&
    cmd !== null &&
    objectCommand.cmd === "git" &&
    Array.isArray(objectCommand.args) &&
    objectCommand.args.includes("rev-parse")
  );
}
