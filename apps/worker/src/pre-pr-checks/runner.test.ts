import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrePrCheckConfig } from "./config.js";
import { WORKSPACE_MANIFEST_PATH } from "../sandbox/repo-workspace.js";

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
