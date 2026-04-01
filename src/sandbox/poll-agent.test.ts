import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockReadFileToBuffer = vi.fn();
const mockStop = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      readFileToBuffer: mockReadFileToBuffer,
      stop: mockStop,
    })),
  },
}));

// Must mock the module before importing
vi.mock("./credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

import { checkAgentDone, collectAgentResults, teardownSandbox } from "./poll-agent.js";

describe("checkAgentDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns false when sentinel file does not exist", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe(false);
  });

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe(true);
  });

  it("returns 'stopped' when sandbox is not running", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sandboxId: "sbx-test-123",
      status: "stopped",
      runCommand: mockRunCommand,
    });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe("stopped");
  });
});

describe("collectAgentResults", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns failure when sandbox is unreachable", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));

    const result = await collectAgentResults("sbx-test-123");

    expect(result.output.result).toBe("failed");
    expect(result.output.error).toContain("unreachable");
    expect(result.files).toHaveLength(0);
  });

  it("reads stdout, stderr and extracts changed files", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation(() => ({
      exitCode: 0,
      stdout: mockStdout,
    }));

    mockStdout
      .mockResolvedValueOnce(JSON.stringify({ result: "implemented", summary: "Done" })) // stdout
      .mockResolvedValueOnce("") // stderr
      .mockResolvedValueOnce("abc123") // pre-agent sha
      .mockResolvedValueOnce("src/index.ts"); // git diff --name-only

    mockReadFileToBuffer.mockResolvedValue(Buffer.from("console.log('hello')"));

    const result = await collectAgentResults("sbx-test-123");

    expect(result.output.result).toBe("implemented");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/index.ts");
    expect(result.files[0].content).toBe("console.log('hello')");
  });
});

describe("teardownSandbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops the sandbox", async () => {
    await teardownSandbox("sbx-test-123");
    expect(mockStop).toHaveBeenCalled();
  });

  it("does not throw on error", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));

    await expect(teardownSandbox("sbx-test-123")).resolves.not.toThrow();
  });
});
