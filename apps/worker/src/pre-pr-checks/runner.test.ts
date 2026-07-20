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

    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(0);
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

  it("sends failed check logs back to the agent and retries", async () => {
    let checkRuns = 0;
    mockRunCommand.mockImplementation((cmd, args) => {
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
    expect(mockWriteFiles).toHaveBeenCalledWith([
      {
        path: "/tmp/pre-pr-checks-fix-prompt.txt",
        content: expect.any(Buffer),
      },
    ]);
    const prompt = mockWriteFiles.mock.calls[0][0][0].content.toString();
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
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "cat" && args[0] === "/tmp/pre-pr-checks-fix-stdout.txt") {
        return commandResult(0, claudeOutput);
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
    const fixerCall = mockRunCommand.mock.calls.find(
      ([command]) =>
        typeof command === "object" &&
        command !== null &&
        (command as { args?: string[] }).args?.some((arg) => arg.includes("claude --print")),
    );
    expect((fixerCall?.[0] as { args: string[] }).args.join(" ")).toContain(
      "--output-format json",
    );
  });

  it("returns null usage for a launched fix cycle whose CLI output has no usage", async () => {
    let checkRuns = 0;
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "cat" && args[0] === "/tmp/pre-pr-checks-fix-stdout.txt") {
        return commandResult(0, "");
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

  it("stops before another check or fixer when the first fix cycle exceeds the token cap", async () => {
    let checkRuns = 0;
    const oneRepoConfig: PrePrCheckConfig = { repositories: [config.repositories[0]!] };
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "cat" && args[0] === "/tmp/pre-pr-checks-fix-stdout.txt") {
        return commandResult(
          0,
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
          }),
        );
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
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return commandResult(0, JSON.stringify(manifest));
      }
      if (cmd === "cat" && args[0] === "/tmp/pre-pr-checks-fix-stdout.txt") {
        return commandResult(0, "");
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
