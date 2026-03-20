import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProvider, SandboxOptions } from "./types.js";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockReadFileToBuffer = vi.fn();
const mockStop = vi.fn();
const mockSandboxId = "sbx-abc123";

const mockSandbox = {
  sandboxId: mockSandboxId,
  runCommand: mockRunCommand,
  writeFiles: mockWriteFiles,
  readFileToBuffer: mockReadFileToBuffer,
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
    // Default: git config, rev-parse, install, agent, post-agent commit, diag
    mockRunCommand
      .mockResolvedValueOnce(makeCommandResult(0, "", ""))                                             // git config
      .mockResolvedValueOnce(makeCommandResult(0, "abc123\n", ""))                                     // git rev-parse HEAD
      .mockResolvedValueOnce(makeCommandResult(0, "", ""))                                             // npm install
      .mockResolvedValueOnce(makeCommandResult(0, makeAgentOutput("implemented", { summary: "Done" }), "")) // claude agent
      .mockResolvedValueOnce(makeCommandResult(0, "", ""))                                             // post-agent commit
      .mockResolvedValueOnce(makeCommandResult(0, "=== git status ===\n", ""));                        // diagnostic
  });

  it("implements the SandboxProvider interface", async () => {
    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider: SandboxProvider = new VercelSandboxProvider({ vcpus: 2 });
    expect(provider).toBeDefined();
    expect(typeof provider.runSandbox).toBe("function");
    expect(typeof provider.extractChanges).toBe("function");
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

    it("writes requirements.md and claude settings into sandbox", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      await provider.runSandbox(defaultSandboxOptions);

      expect(mockWriteFiles).toHaveBeenCalledWith([
        {
          path: "requirements.md",
          content: Buffer.from(defaultSandboxOptions.requirementsMd),
        },
        {
          path: ".claude/settings.json",
          content: expect.any(Buffer),
        },
      ]);

      // Verify settings contain SessionEnd hook
      const settingsBuffer = mockWriteFiles.mock.calls[0][0][1].content;
      const settings = JSON.parse(settingsBuffer.toString());
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.Stop[0].hooks[0].type).toBe("command");
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
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git config
        .mockResolvedValueOnce(makeCommandResult(0, "abc123\n", ""))  // git rev-parse
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // npm install
        .mockResolvedValueOnce(makeCommandResult(0, makeAgentOutput("implemented", { summary: "Implemented dark mode" }), ""))
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // post-agent commit
        .mockResolvedValueOnce(makeCommandResult(0, "", ""));  // diagnostic

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "complete",
          summary: "Implemented dark mode",
          containerId: mockSandboxId,
          initialSha: "abc123",
        }),
      );
    });

    it("returns clarification_needed when agent requests clarification", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git config
        .mockResolvedValueOnce(makeCommandResult(0, "abc123\n", ""))  // git rev-parse
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // npm install
        .mockResolvedValueOnce(makeCommandResult(0, makeAgentOutput("clarification_needed", { questions: ["What color scheme?", "Which framework?"] }), ""))
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // post-agent commit
        .mockResolvedValueOnce(makeCommandResult(0, "", ""));  // diagnostic

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
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git config
        .mockResolvedValueOnce(makeCommandResult(0, "abc123\n", ""))  // git rev-parse
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // npm install
        .mockResolvedValueOnce(makeCommandResult(1, makeAgentOutput("failed", { error: "Tests failed" }), ""))
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // post-agent commit
        .mockResolvedValueOnce(makeCommandResult(0, "", ""));  // diagnostic

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
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git config
        .mockResolvedValueOnce(makeCommandResult(0, "abc123\n", ""))  // git rev-parse
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // npm install
        .mockResolvedValueOnce(makeCommandResult(1, "some random text", "some error text"))
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // post-agent commit
        .mockResolvedValueOnce(makeCommandResult(0, "", ""));  // diagnostic

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Agent did not return valid structured JSON output");
      expect(result.containerId).toBe(mockSandboxId);
    });

    it("returns failed when claude-code install fails", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git config
        .mockResolvedValueOnce(makeCommandResult(0, "abc123\n", ""))  // git rev-parse
        .mockResolvedValueOnce(
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

  describe("extractChanges", () => {
    it("extracts changed files from sandbox", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))           // git add -A
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))           // git status --porcelain (clean)
        .mockResolvedValueOnce(makeCommandResult(0, "A\tsrc/index.ts\nM\tREADME.md\n", "")) // git diff --name-status
        .mockResolvedValueOnce(makeCommandResult(0, "feat: add feature", ""));               // git log

      mockReadFileToBuffer
        .mockResolvedValueOnce(Buffer.from("console.log('hello');"))
        .mockResolvedValueOnce(Buffer.from("# Updated"));

      const result = await provider.extractChanges(mockSandboxId, "abc123");

      expect(mockGet).toHaveBeenCalledWith({ sandboxId: mockSandboxId });
      expect(result.hasChanges).toBe(true);
      expect(result.files).toHaveLength(2);
      expect(result.files[0]!.path).toBe("src/index.ts");
      expect(result.files[0]!.content).toBe(Buffer.from("console.log('hello');").toString("base64"));
      expect(result.commitMessage).toBe("feat: add feature");
    });

    it("returns hasChanges=false when no diff", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git add -A
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))  // git status --porcelain
        .mockResolvedValueOnce(makeCommandResult(0, "", "")); // git diff --name-status (empty)

      const result = await provider.extractChanges(mockSandboxId, "abc123");

      expect(result.hasChanges).toBe(false);
      expect(result.files).toHaveLength(0);
    });

    it("handles deleted files with null content", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))
        .mockResolvedValueOnce(makeCommandResult(0, "D\told-file.ts\n", ""))
        .mockResolvedValueOnce(makeCommandResult(0, "chore: remove old file", ""));

      const result = await provider.extractChanges(mockSandboxId, "abc123");

      expect(result.hasChanges).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe("old-file.ts");
      expect(result.files[0]!.content).toBeNull();
    });

    it("commits uncommitted changes before extracting", async () => {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      const provider = new VercelSandboxProvider({});

      mockRunCommand.mockReset();
      mockRunCommand
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))                    // git add -A
        .mockResolvedValueOnce(makeCommandResult(0, "M src/app.ts\n", ""))      // git status --porcelain (dirty)
        .mockResolvedValueOnce(makeCommandResult(0, "", ""))                    // git commit
        .mockResolvedValueOnce(makeCommandResult(0, "M\tsrc/app.ts\n", ""))    // git diff --name-status
        .mockResolvedValueOnce(makeCommandResult(0, "Apply agent changes", "")); // git log

      mockReadFileToBuffer.mockResolvedValueOnce(Buffer.from("updated"));

      const result = await provider.extractChanges(mockSandboxId, "abc123");

      // Verify git commit was called
      expect(mockRunCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: "git",
          args: ["commit", "-m", "Apply agent changes"],
        }),
      );
      expect(result.hasChanges).toBe(true);
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
