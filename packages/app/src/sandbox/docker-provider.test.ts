import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { SandboxProvider, SandboxOptions } from "./types.js";

let mockContainer: {
  id: string;
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
};
let createContainerSpy: ReturnType<typeof vi.fn>;
let getContainerSpy: ReturnType<typeof vi.fn>;
let listContainersSpy: ReturnType<typeof vi.fn>;

vi.mock("dockerode", () => {
  mockContainer = {
    id: "container-abc123",
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    logs: vi.fn(),
    remove: vi.fn(),
    kill: vi.fn(),
    commit: vi.fn().mockResolvedValue({ Id: "sha256:abc" }),
  };
  createContainerSpy = vi.fn().mockResolvedValue(mockContainer);
  getContainerSpy = vi.fn().mockReturnValue(mockContainer);
  listContainersSpy = vi.fn().mockResolvedValue([]);
  class MockDocker {
    createContainer = createContainerSpy;
    getContainer = getContainerSpy;
    listContainers = listContainersSpy;
  }
  return { default: MockDocker };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/blazebot-abc"),
  writeFile: vi.fn(),
  rm: vi.fn(),
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

function mockLogs(stdout: string, stderr = "") {
  mockContainer.logs.mockImplementation(() => {
    const frames: Buffer[] = [];
    if (stdout) {
      const payload = Buffer.from(stdout, "utf-8");
      const header = Buffer.alloc(8);
      header[0] = 1; // stdout
      header.writeUInt32BE(payload.length, 4);
      frames.push(header, payload);
    }
    if (stderr) {
      const payload = Buffer.from(stderr, "utf-8");
      const header = Buffer.alloc(8);
      header[0] = 2; // stderr
      header.writeUInt32BE(payload.length, 4);
      frames.push(header, payload);
    }
    return Promise.resolve(
      frames.length > 0 ? Buffer.concat(frames) : Buffer.alloc(0),
    );
  });
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

const dockerConfig = {
  image: "blazebot-sandbox:latest",
  memoryLimitMb: 4096,
};

describe("DockerSandboxProvider", () => {
  beforeAll(async () => {
    await import("dockerode");
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await import("dockerode");
    createContainerSpy?.mockResolvedValue(mockContainer);
    mockContainer.start.mockResolvedValue(undefined);
    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockLogs(makeAgentOutput("implemented", { summary: "" }));
  });

  it("implements the SandboxProvider interface", async () => {
    const { DockerSandboxProvider } = await import("./docker-provider.js");
    const provider: SandboxProvider = new DockerSandboxProvider(dockerConfig);
    expect(provider).toBeDefined();
    expect(typeof provider.runSandbox).toBe("function");
    expect(typeof provider.pushBranch).toBe("function");
    expect(typeof provider.teardown).toBe("function");
    expect(typeof provider.cleanupOrphans).toBe("function");
  });

  describe("runSandbox", () => {
    it("delegates to the Docker manager with merged config", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

      await provider.runSandbox(defaultSandboxOptions);

      expect(createContainerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "blazebot-sandbox:latest",
          HostConfig: expect.objectContaining({
            Memory: 4096 * 1024 * 1024,
          }),
        }),
      );
    });

    it("returns complete when agent output has result 'implemented'", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      mockLogs(
        makeAgentOutput("implemented", { summary: "Implemented dark mode" }),
      );

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "complete",
          summary: "Implemented dark mode",
          containerId: "container-abc123",
        }),
      );
    });

    it("returns clarification_needed when agent requests clarification", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      mockLogs(
        makeAgentOutput("clarification_needed", {
          questions: ["What color scheme?", "Which framework?"],
        }),
      );

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "clarification_needed",
          questions: ["What color scheme?", "Which framework?"],
        }),
      );
    });

    it("returns failed when agent output has result 'failed'", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
      mockLogs(makeAgentOutput("failed", { error: "Tests failed" }));

      const result = await provider.runSandbox(defaultSandboxOptions);

      expect(result).toEqual(
        expect.objectContaining({
          status: "failed",
          error: "Tests failed",
        }),
      );
    });

    it("passes SandboxOptions fields through to the manager", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

      await provider.runSandbox(defaultSandboxOptions);

      expect(createContainerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: expect.arrayContaining([
            "BLAZEBOT_BRANCH=blazebot/PROJ-42",
            "GITHUB_TOKEN=ghp_test",
            "REPO_URL=owner/repo",
            "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test",
            "CLAUDE_MODEL=claude-opus-4-20250514",
            "DEVELOPER_MODE=false",
          ]),
        }),
      );
    });

    it("uses the image and memoryLimitMb from the config, not from options", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const customConfig = { image: "custom-image:v2", memoryLimitMb: 2048 };
      const provider = new DockerSandboxProvider(customConfig);

      mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

      await provider.runSandbox(defaultSandboxOptions);

      expect(createContainerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "custom-image:v2",
          HostConfig: expect.objectContaining({
            Memory: 2048 * 1024 * 1024,
          }),
        }),
      );
    });
  });

  describe("pushBranch", () => {
    it("delegates to pushBranchFromContainer", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      // The push container mock: commit + create + start + wait + logs + remove
      const pushContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      createContainerSpy.mockResolvedValue(pushContainer);

      const result = await provider.pushBranch("container-abc123", "blazebot/feat-1");

      expect(result).toEqual(
        expect.objectContaining({
          pushed: true,
        }),
      );
      expect(mockContainer.commit).toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("delegates to teardownContainer", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      await provider.teardown("container-abc123");

      expect(mockContainer.kill).toHaveBeenCalled();
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });
  });

  describe("cleanupOrphans", () => {
    it("delegates to cleanupOrphanContainers", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      listContainersSpy.mockResolvedValue([
        { Id: "orphan-1", Labels: { blazebot: "true" }, State: "running" },
      ]);

      await provider.cleanupOrphans();

      expect(listContainersSpy).toHaveBeenCalledWith({
        all: true,
        filters: { label: ["blazebot=true"] },
      });
      expect(mockContainer.kill).toHaveBeenCalled();
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("does nothing when no orphan containers exist", async () => {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      const provider = new DockerSandboxProvider(dockerConfig);

      listContainersSpy.mockResolvedValue([]);

      await provider.cleanupOrphans();

      expect(mockContainer.kill).not.toHaveBeenCalled();
      expect(mockContainer.remove).not.toHaveBeenCalled();
    });
  });
});
