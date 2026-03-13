import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

let mockContainer: {
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  getArchive: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};
let createContainerSpy: ReturnType<typeof vi.fn>;

vi.mock("dockerode", () => {
  mockContainer = {
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    getArchive: vi.fn(),
    remove: vi.fn(),
    kill: vi.fn(),
  };
  createContainerSpy = vi.fn().mockResolvedValue(mockContainer);
  class MockDocker {
    createContainer = createContainerSpy;
  }
  return { default: MockDocker };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/blazebot-abc"),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

function createMockTarStream(content: string) {
  const { Readable } = require("node:stream");
  const header = Buffer.alloc(512, 0);
  const contentBuf = Buffer.from(content, "utf-8");
  const stream = new Readable({
    read() {
      this.push(Buffer.concat([header, contentBuf]));
      this.push(null);
    },
  });
  return stream;
}

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

  beforeEach(async () => {
    vi.clearAllMocks();
    await import("dockerode"); // Ensure mock is initialized
    createContainerSpy?.mockResolvedValue(mockContainer);
    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "", questions: [], error: "" }),
      ),
    );
  });

  it("creates container with correct env and memory limit", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "Done", questions: [], error: "" }),
      ),
    );

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

  it("returns complete on exit code 0", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({
          summary: "Implemented dark mode",
          questions: [],
          error: "",
        }),
      ),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 0,
      status: "complete",
      summary: "Implemented dark mode",
    });
  });

  it("returns clarification_needed on exit code 2", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 2 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({
          summary: "",
          questions: ["What color scheme?"],
          error: "",
        }),
      ),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 2,
      status: "clarification_needed",
      questions: ["What color scheme?"],
    });
  });

  it("returns failed on exit code 1", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "", questions: [], error: "Tests failed" }),
      ),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 1,
      status: "failed",
      error: "Tests failed",
    });
  });

  it("returns failed when marker file is missing", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockContainer.getArchive.mockRejectedValue(new Error("file not found"));

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 1,
      status: "failed",
      error: expect.stringContaining(".blazebot/output.json"),
    });
  });

  it("returns failed on timeout and kills container", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockReturnValue(new Promise(() => {}));

    const result = await runSandbox({ ...defaultOptions, timeoutMs: 50 });

    expect(result).toEqual({
      exitCode: -1,
      status: "failed",
      error: expect.stringContaining("timeout"),
    });
    expect(mockContainer.kill).toHaveBeenCalled();
  });

  it("removes container after execution", async () => {
    const { runSandbox } = await import("./manager.js");

    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "Done", questions: [], error: "" }),
      ),
    );

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
});
