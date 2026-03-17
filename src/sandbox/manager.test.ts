import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let mockContainer: {
  id: string;
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};
let createContainerSpy: ReturnType<typeof vi.fn>;

vi.mock("dockerode", () => {
  mockContainer = {
    id: "container-abc123",
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    logs: vi.fn(),
    remove: vi.fn(),
    kill: vi.fn(),
  };
  createContainerSpy = vi.fn().mockResolvedValue(mockContainer);
  class MockDocker {
    createContainer = createContainerSpy;
    getContainer = vi.fn().mockReturnValue(mockContainer);
  }
  return { default: MockDocker };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/blazebot-abc"),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("runSandbox", () => {
  beforeAll(async () => {
    await import("dockerode");
  });

  const defaultOptions = {
    image: "blazebot-sandbox",
    branchName: "blazebot/PROJ-42",
    requirementsMd: "# Requirements\n\n## Ticket\nDo the thing\n\n---\nYou are an agent...",
    githubToken: "ghp_test",
    repoUrl: "owner/repo",
    oauthToken: "sk-ant-oat01-test",
    model: "claude-sonnet-4-20250514",
    timeoutMs: 30000,
    memoryLimitMb: 4096,
  };

  const makeAgentOutput = (result: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ result, ...extra });

  function mockLogs(stdout: string, stderr = "") {
    mockContainer.logs.mockImplementation((opts: { stdout?: boolean; stderr?: boolean }) => {
      if (opts.stdout) return Promise.resolve(stdout);
      if (opts.stderr) return Promise.resolve(stderr);
      return Promise.resolve("");
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await import("dockerode");
    createContainerSpy?.mockResolvedValue(mockContainer);
    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockLogs(makeAgentOutput("implemented", { summary: "" }));
  });

  it("creates container with correct env and memory limit", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

    await runSandbox(defaultOptions);

    expect(createContainerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: "blazebot-sandbox",
        Env: expect.arrayContaining([
          "BLAZEBOT_BRANCH=blazebot/PROJ-42",
          "GITHUB_TOKEN=ghp_test",
          "REPO_URL=owner/repo",
          "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test",
          "CLAUDE_MODEL=claude-sonnet-4-20250514",
        ]),
        HostConfig: expect.objectContaining({
          Memory: 4096 * 1024 * 1024,
        }),
      }),
    );
  });

  it("returns complete when agent output has result 'implemented'", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("implemented", { summary: "Implemented dark mode" }));

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual(
      expect.objectContaining({
        status: "complete",
        summary: "Implemented dark mode",
      }),
    );
  });

  it("returns clarification_needed when agent output has result 'clarification_needed'", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("clarification_needed", { questions: ["What color scheme?"] }));

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual(
      expect.objectContaining({
        status: "clarification_needed",
        questions: ["What color scheme?"],
      }),
    );
  });

  it("returns failed when agent output has result 'failed'", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockLogs(makeAgentOutput("failed", { error: "Tests failed" }));

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Tests failed",
      }),
    );
  });

  it("returns failed when no structured output in logs", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockLogs("some random output without JSON", "fatal: repository not found");

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("repository not found"),
      }),
    );
  });

  it("includes stderr in error message when agent fails without JSON output", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockLogs("", "bash: claude: command not found");

    const result = await runSandbox(defaultOptions);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("claude: command not found");
  });

  it("returns failed on timeout and kills container", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockReturnValue(new Promise(() => {}));

    const result = await runSandbox({ ...defaultOptions, timeoutMs: 50 });

    expect(result).toEqual(
      expect.objectContaining({
        exitCode: -1,
        status: "failed",
        error: expect.stringContaining("timeout"),
      }),
    );
    expect(mockContainer.kill).toHaveBeenCalled();
  });

  it("removes container after execution", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

    await runSandbox(defaultOptions);

    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
  });

  it("cleans up container even when start fails", async () => {
    const fs = await import("node:fs/promises");
    const { runSandbox } = await import("./manager.js");

    mockContainer.start.mockRejectedValue(new Error("Docker daemon error"));

    const result = await runSandbox(defaultOptions);

    expect(result.status).toBe("failed");
    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(fs.rm).toHaveBeenCalled();
  });

  it("includes containerId in result", async () => {
    const { runSandbox } = await import("./manager.js");

    mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

    const result = await runSandbox(defaultOptions);

    expect(result.containerId).toBe("container-abc123");
  });
});

describe("teardownContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills and removes a container by ID", async () => {
    const { teardownContainer } = await import("./manager.js");

    await teardownContainer("container-abc123");

    expect(mockContainer.kill).toHaveBeenCalled();
    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
  });
});
