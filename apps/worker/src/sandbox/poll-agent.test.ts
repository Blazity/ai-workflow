import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.fn();
const mockStop = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      stop: mockStop,
    })),
  },
}));

vi.mock("./credentials.js", () => ({ getSandboxCredentials: () => ({}) }));

import {
  checkPhaseDone,
  collectPhase,
  collectPhaseOutput,
  teardownSandbox,
  teardownSandboxes,
} from "./poll-agent.js";

function result(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

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

describe("teardownSandboxes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tears down every distinct id once, de-duplicated", async () => {
    const teardown = vi.fn().mockResolvedValue(undefined);
    await teardownSandboxes(["sbx-a", "sbx-b", "sbx-a"], teardown);
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledWith("sbx-a");
    expect(teardown).toHaveBeenCalledWith("sbx-b");
  });

  it("keeps tearing down the rest when one teardown fails (best-effort)", async () => {
    const teardown = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue(undefined);
    await expect(teardownSandboxes(["sbx-a", "sbx-b", "sbx-c"], teardown)).resolves.not.toThrow();
    expect(teardown).toHaveBeenCalledTimes(3);
  });

  it("defaults to the real teardownSandbox when no teardown is injected", async () => {
    await teardownSandboxes(["sbx-test-123"]);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});

describe("checkPhaseDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe(true);
  });

  it("returns false when sentinel file is missing", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe(false);
  });

  it("returns stopped when the sandbox is unavailable", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe("stopped");
  });
});

describe("collectPhaseOutput", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers stdout and falls back to stderr", async () => {
    mockRunCommand
      .mockResolvedValueOnce(result(""))
      .mockResolvedValueOnce(result("error details"));
    await expect(
      collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr"),
    ).resolves.toBe("error details");
  });
});

describe("collectPhase", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns stdout, stderr, structured output, and exit code independently", async () => {
    mockRunCommand.mockImplementation((_cmd: string, args: string[]) => {
      const file = args[0];
      const text = file.includes("stdout")
        ? "ndjson body"
        : file.includes("stderr")
          ? "warning"
          : file.includes("exit-code")
            ? "17"
        : file.includes("result")
          ? '{"result":"implemented"}'
          : "";
      return result(text);
    });
    await expect(
      collectPhase("sbx-test-123", {
        stdout: "/tmp/stdout",
        stderr: "/tmp/stderr",
        structuredOutput: "/tmp/result",
        exitCode: "/tmp/exit-code",
      }),
    ).resolves.toEqual({
      stdout: "ndjson body",
      stderr: "warning",
      structuredOutput: '{"result":"implemented"}',
      exitCode: 17,
    });
  });
});
