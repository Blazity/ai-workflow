import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProvider, SandboxOptions } from "./types.js";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockSandboxId = "sbx-abc123";

const mockSandbox = {
  sandboxId: mockSandboxId,
  runCommand: mockRunCommand,
  writeFiles: mockWriteFiles,
  stop: mockStop,
  status: "running" as const,
};

const mockCreate = vi.fn().mockResolvedValue(mockSandbox);
const mockGet = vi.fn().mockResolvedValue(mockSandbox);
const mockList = vi.fn().mockResolvedValue({ json: { sandboxes: [], pagination: {} } });

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: (...args: unknown[]) => mockCreate(...args),
    get: (...args: unknown[]) => mockGet(...args),
    list: (...args: unknown[]) => mockList(...args),
  },
}));

vi.mock("@blazebot/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

const makeAgentOutput = (
  result: string,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Full text response from Claude...",
    structured_output: { result, ...extra },
    session_id: "test-session",
  });

function makeCommandResult(exitCode: number, stdout: string, stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

const defaultSandboxOptions: SandboxOptions = {
  branchName: "blazebot/PROJ-42",
  requirementsMd:
    "# Requirements\n\n## Ticket\nDo the thing\n\n---\nYou are an agent...",
  githubToken: "ghp_test",
  repoUrl: "owner/repo",
  oauthToken: "sk-ant-oat01-test",
  model: "claude-opus-4-20250514",
  timeoutMs: 30000,
  developerMode: false,
};

describe("VercelSandboxProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(mockSandbox);
    mockGet.mockResolvedValue(mockSandbox);
    mockList.mockResolvedValue({ json: { sandboxes: [], pagination: {} } });
    mockWriteFiles.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
    // Default: install succeeds, agent returns "implemented"
    mockRunCommand
      .mockResolvedValueOnce(makeCommandResult(0, "", ""))                                             // npm install
      .mockResolvedValueOnce(makeCommandResult(0, makeAgentOutput("implemented", { summary: "Done" }), "")); // claude agent
  });

  it("implements the SandboxProvider interface", async () => {
    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider: SandboxProvider = new VercelSandboxProvider({ vcpus: 2 });
    expect(provider).toBeDefined();
    expect(typeof provider.runSandbox).toBe("function");
    expect(typeof provider.pushBranch).toBe("function");
    expect(typeof provider.teardown).toBe("function");
    expect(typeof provider.cleanupOrphans).toBe("function");
  });

  describe("runSandbox", () => {
    it("creates sandbox with correct git source and runtime", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({ vcpus: 4 });

      await provider.runSandbox(defaultSandboxOptions);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            type: "git",
            url: "https://github.com/owner/repo.git",
            password: "ghp_test",
            revision: "blazebot/PROJ-42",
            depth: 1,
          },
          runtime: "node22",
          resources: { vcpus: 4 },
          env: expect.objectContaining({
            CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test",
            CLAUDE_MODEL: "claude-opus-4-20250514",
            GITHUB_TOKEN: "ghp_test",
          }),
          timeout: 30000,
        }),
      );
    });

    it("writes requirements.md into sandbox", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      await provider.runSandbox(defaultSandboxOptions);

      expect(mockWriteFiles).toHaveBeenCalledWith([
        {
          path: "requirements.md",
          content: Buffer.from(defaultSandboxOptions.requirementsMd),
        },
      ]);
    });

    it("installs claude-code CLI", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      await provider.runSandbox(defaultSandboxOptions);

      expect(mockRunCommand).toHaveBeenCalledWith(
        "npm",
        ["install", "-g", "@anthropic-ai/claude-code"],
      );
    });

    it("returns complete on 'implemented' result", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))
        .mockResolvedValueOnce(
          makeCommandResult(0, makeAgentOutput("implemented", { summary: "Implemented dark mode" }), ""),
        );

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "complete",
          summary: "Implemented dark mode",
          containerId: mockSandboxId,
        }),
      );
    });

    it("returns clarification_needed when agent requests clarification", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))
        .mockResolvedValueOnce(
          makeCommandResult(
            0,
            makeAgentOutput("clarification_needed", {
              questions: ["What color scheme?", "Which framework?"],
            }),
            "",
          ),
        );

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "clarification_needed",
          questions: ["What color scheme?", "Which framework?"],
          containerId: mockSandboxId,
        }),
      );
    });

    it("returns failed on agent failure", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))
        .mockResolvedValueOnce(
          makeCommandResult(1, makeAgentOutput("failed", { error: "Tests failed" }), ""),
        );

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          error: "Tests failed",
          containerId: mockSandboxId,
        }),
      );
    });

    it("returns failed when no structured output", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))
        .mockResolvedValueOnce(makeCommandResult(1, "some random text", "some error text"));

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Agent did not return valid structured JSON output");
      expect(result.containerId).toBe(mockSandboxId);
    });

    it("returns failed when claude-code install fails", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand.mockResolvedValueOnce(
        makeCommandResult(1, "", "npm ERR! install failed"),
      );

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Failed to install Claude Code");
      expect(result.exitCode).toBe(-1);
      expect(result.containerId).toBe(mockSandboxId);
    });

    it("handles exceptions gracefully", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockCreate.mockRejectedValueOnce(new Error("Network timeout"));

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          exitCode: -1,
          status: "failed",
          error: "Network timeout",
        }),
      );
    });

    it("defaults vcpus to 2 when not specified", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      await provider.runSandbox(defaultSandboxOptions);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          resources: { vcpus: 2 },
        }),
      );
    });
  });

  describe("pushBranch", () => {
    it("runs git push and returns pushed=true on success", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand.mockResolvedValueOnce(
        makeCommandResult(0, "Everything up-to-date", ""),
      );

      const result = await provider.pushBranch(mockSandboxId, "blazebot/feat-1");

      expect(mockGet).toHaveBeenCalledWith({ sandboxId: mockSandboxId });
      expect(mockRunCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: "git",
          args: ["push", "origin", "HEAD:blazebot/feat-1"],
          cwd: "/vercel/sandbox",
        }),
      );
      expect(result.pushed).toBe(true);
      expect(result.output).toContain("Everything up-to-date");
    });

    it("returns pushed=false on non-zero exit code", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand.mockResolvedValueOnce(
        makeCommandResult(128, "", "fatal: remote rejected"),
      );

      const result = await provider.pushBranch(mockSandboxId, "blazebot/feat-1");

      expect(result.pushed).toBe(false);
      expect(result.output).toContain("fatal: remote rejected");
    });

    it("handles exceptions and returns pushed=false", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockGet.mockRejectedValueOnce(new Error("Sandbox not found"));

      const result = await provider.pushBranch(mockSandboxId, "blazebot/feat-1");

      expect(result.pushed).toBe(false);
      expect(result.output).toBe("Sandbox not found");
    });
  });

  describe("teardown", () => {
    it("calls sandbox.stop()", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      await provider.teardown(mockSandboxId);

      expect(mockGet).toHaveBeenCalledWith({ sandboxId: mockSandboxId });
      expect(mockStop).toHaveBeenCalled();
    });

    it("does not throw if sandbox already stopped", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockGet.mockRejectedValueOnce(new Error("Sandbox already stopped"));

      await expect(provider.teardown(mockSandboxId)).resolves.toBeUndefined();
    });
  });

  describe("cleanupOrphans", () => {
    it("stops running sandboxes", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockList.mockResolvedValueOnce({
        json: {
          sandboxes: [
            { id: "sbx-orphan-1", status: "running" },
            { id: "sbx-orphan-2", status: "running" },
            { id: "sbx-stopped", status: "stopped" },
          ],
          pagination: {},
        },
      });

      await provider.cleanupOrphans();

      // Should only try to stop running sandboxes (2 of 3)
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenCalledWith({ sandboxId: "sbx-orphan-1" });
      expect(mockGet).toHaveBeenCalledWith({ sandboxId: "sbx-orphan-2" });
      expect(mockStop).toHaveBeenCalledTimes(2);
    });

    it("does nothing when no running sandboxes", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockList.mockResolvedValueOnce({
        json: { sandboxes: [], pagination: {} },
      });

      await provider.cleanupOrphans();

      expect(mockGet).not.toHaveBeenCalled();
      expect(mockStop).not.toHaveBeenCalled();
    });

    it("continues cleanup when individual sandbox stop fails", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      const failingSandbox = {
        ...mockSandbox,
        stop: vi.fn().mockRejectedValue(new Error("Already stopped")),
      };

      mockList.mockResolvedValueOnce({
        json: {
          sandboxes: [
            { id: "sbx-fail", status: "running" },
            { id: "sbx-ok", status: "running" },
          ],
          pagination: {},
        },
      });

      mockGet
        .mockResolvedValueOnce(failingSandbox)
        .mockResolvedValueOnce(mockSandbox);

      // Should not throw even though the first sandbox stop fails
      await expect(provider.cleanupOrphans()).resolves.toBeUndefined();
      expect(mockStop).toHaveBeenCalledTimes(1); // Only the second sandbox's stop
    });

    it("handles list API failure gracefully", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockList.mockRejectedValueOnce(new Error("API error"));

      await expect(provider.cleanupOrphans()).resolves.toBeUndefined();
    });
  });
});
