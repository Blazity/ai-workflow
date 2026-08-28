import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "@vercel/sandbox";

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

const mockSandboxGet = Sandbox.get as unknown as ReturnType<typeof vi.fn>;

function resetSandboxMocks() {
  vi.clearAllMocks();
  mockRunCommand.mockReset();
  mockStop.mockReset();
  mockSandboxGet.mockReset().mockImplementation(() => ({
    sandboxId: "sbx-test-123",
    status: "running",
    runCommand: mockRunCommand,
    stop: mockStop,
  }));
}

import {
  checkPhaseDone,
  collectPhase,
  collectPhaseReplayDiagnostics,
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
  beforeEach(resetSandboxMocks);

  it("stops the sandbox", async () => {
    await teardownSandbox("sbx-test-123");
    expect(mockStop).toHaveBeenCalled();
  });

  it("does not throw on error", async () => {
    mockSandboxGet.mockRejectedValueOnce(new Error("gone"));
    await expect(teardownSandbox("sbx-test-123")).resolves.not.toThrow();
  });

  it("gives up on a sandbox that never answers the stop", async () => {
    mockStop.mockImplementationOnce(() => new Promise(() => {}));
    await expect(teardownSandbox("sbx-test-123", 25)).resolves.toBeUndefined();
  });
});

describe("teardownSandboxes", () => {
  beforeEach(resetSandboxMocks);

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
  beforeEach(resetSandboxMocks);

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe(true);
  });

  it("returns false when sentinel file is missing", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe(false);
  });

  it("returns stopped when the sandbox is unavailable", async () => {
    mockSandboxGet.mockRejectedValueOnce(new Error("gone"));
    await expect(checkPhaseDone("sbx-test-123", "/tmp/phase-done")).resolves.toBe("stopped");
  });

  it("reports stopped when the sandbox API never answers, instead of hanging the step", async () => {
    // Before the deadline existed this promise never settled: the step's
    // invocation lived until the platform killed it at maxDuration (800 s)
    // and the queue redelivered the same message into the same hang, three
    // times over, while the run sat in RUNNING (UP-4765, 2026-08-21).
    mockRunCommand.mockImplementation(
      (_cmd: string, _args: string[], opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
        }),
    );
    await expect(
      checkPhaseDone("sbx-test-123", "/tmp/phase-done", 25),
    ).resolves.toBe("stopped");
  });

  it("reports stopped even when the sandbox client ignores the abort signal", async () => {
    mockRunCommand.mockImplementation(() => new Promise(() => {}));
    await expect(
      checkPhaseDone("sbx-test-123", "/tmp/phase-done", 25),
    ).resolves.toBe("stopped");
  });

  it("hands the deadline signal to the sandbox lookup and the sentinel probe", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });

    await checkPhaseDone("sbx-test-123", "/tmp/phase-done");

    expect(mockSandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx-test-123", signal: expect.any(AbortSignal) }),
    );
    expect(mockRunCommand).toHaveBeenCalledWith(
      "test",
      ["-f", "/tmp/phase-done"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("collectPhaseOutput", () => {
  beforeEach(resetSandboxMocks);
  afterEach(() => vi.useRealTimers());

  it("prefers stdout and falls back to stderr", async () => {
    mockRunCommand
      .mockResolvedValueOnce(result(""))
      .mockResolvedValueOnce(result("error details"));
    await expect(
      collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr"),
    ).resolves.toBe("error details");
  });

  it("bounds an artifact read that never settles with the deterministic deadline error", async () => {
    vi.useFakeTimers();
    let rejectRunCommand!: (reason: Error) => void;
    const pendingRunCommand = new Promise<ReturnType<typeof result>>((_resolve, reject) => {
      rejectRunCommand = reject;
    });
    const pendingRunCommandSettled = pendingRunCommand.catch(() => undefined);
    mockRunCommand.mockImplementation(() => pendingRunCommand);
    let failure: unknown;
    void collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr").catch(
      (error) => {
        failure = error;
      },
    );

    for (let i = 0; i < 100 && mockRunCommand.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(failure).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
    rejectRunCommand(new Error("test cleanup"));
    await pendingRunCommandSettled;
  });

  it("aborts a stdout stream that never settles when the artifact deadline expires", async () => {
    vi.useFakeTimers();
    const stdout = vi.fn(({ signal }: { signal: AbortSignal }) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    );
    mockRunCommand.mockImplementation(() => Promise.resolve({ ...result(), stdout }));

    let failure: unknown;
    void collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr").catch(
      (error) => {
        failure = error;
      },
    );

    for (let i = 0; i < 100 && stdout.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(stdout).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stdout.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(failure).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });
});

describe("collectPhase", () => {
  beforeEach(resetSandboxMocks);
  afterEach(() => vi.useRealTimers());

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

  it("bounds a Sandbox.get that never settles with the deterministic deadline error", async () => {
    vi.useFakeTimers();
    mockSandboxGet.mockImplementationOnce(() => new Promise(() => {}));
    let failure: unknown;
    void collectPhase("sbx-test-123", {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      structuredOutput: null,
      exitCode: "/tmp/exit-code",
    }).catch((error) => { failure = error; });

    for (let i = 0; i < 100 && mockSandboxGet.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(failure).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });

  it("bounds an artifact read that never settles with the deterministic deadline error", async () => {
    vi.useFakeTimers();
    let rejectRunCommand!: (reason: Error) => void;
    const pendingRunCommand = new Promise<ReturnType<typeof result>>((_resolve, reject) => {
      rejectRunCommand = reject;
    });
    const pendingRunCommandSettled = pendingRunCommand.catch(() => undefined);
    mockRunCommand.mockImplementation(() => pendingRunCommand);
    let failure: unknown;
    void collectPhase("sbx-test-123", {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      structuredOutput: null,
      exitCode: "/tmp/exit-code",
    }).catch((error) => { failure = error; });

    for (let i = 0; i < 100 && mockRunCommand.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(failure).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
    rejectRunCommand(new Error("test cleanup"));
    await pendingRunCommandSettled;
  });

  it("aborts a stdout stream that never settles when the artifact deadline expires", async () => {
    vi.useFakeTimers();
    const stdout = vi.fn(({ signal }: { signal: AbortSignal }) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    );
    mockRunCommand.mockImplementation(() => Promise.resolve({ ...result(), stdout }));

    let failure: unknown;
    void collectPhase("sbx-test-123", {
      stdout: "/tmp/stdout",
      stderr: "/tmp/stderr",
      structuredOutput: null,
      exitCode: "/tmp/exit-code",
    }).catch((error) => { failure = error; });

    for (let i = 0; i < 100 && stdout.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(stdout).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stdout.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(failure).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });

  it("bounds replay-only partial artifact reads", async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      stdout: vi.fn(() => new Promise<string>(() => {})),
      stderr: vi.fn().mockResolvedValue(""),
    });

    await expect(
      collectPhaseReplayDiagnostics(
        "sbx-test-123",
        {
          stdout: "/tmp/stdout",
          stderr: "/tmp/stderr",
          structuredOutput: null,
          exitCode: "/tmp/exit-code",
        },
        5,
      ),
    ).rejects.toThrow("Replay capture timed out");
  });

  it("sanitizes replay-only diagnostics before returning the step result", async () => {
    const structuredOutput = '{"result":"private output"}';
    mockRunCommand.mockImplementation((cmd: string, args: string[]) => {
      const file = args.at(-1) ?? "";
      if (cmd === "wc") {
        return result(file.includes("stdout") ? "40" : "48");
      }
      const text = file.includes("stdout")
        ? "contact person@example.com"
        : file.includes("stderr")
          ? "Authorization: Bearer must-not-survive"
          : file.includes("exit-code")
            ? "124"
            : file.includes("result")
              ? structuredOutput
              : "";
      return result(text);
    });

    const diagnostics = await collectPhaseReplayDiagnostics(
      "sbx-test-123",
      {
        stdout: "/tmp/stdout",
        stderr: "/tmp/stderr",
        structuredOutput: "/tmp/result",
        exitCode: "/tmp/exit-code",
      },
    );
    const durableStepResult = JSON.stringify(diagnostics);

    expect(durableStepResult).not.toContain("private output");
    expect(durableStepResult).not.toContain("person@example.com");
    expect(durableStepResult).not.toContain("must-not-survive");
    expect(diagnostics.structuredOutput).toBeNull();
    expect(diagnostics.stdout).toContain("[REDACTED:email]");
    expect(diagnostics.stderr).toContain("[REDACTED:hard_exclusion]");
    expect(
      diagnostics.diagnosticSanitization.stdout.redactions.email,
    ).toBe(1);
    expect(
      mockRunCommand.mock.calls.some(([command]) => command === "cat"),
    ).toBe(false);
    expect(
      mockRunCommand.mock.calls.some(([, args]) =>
        (args as string[]).includes("/tmp/result"),
      ),
    ).toBe(false);
    expect(
      mockRunCommand.mock.calls.filter(
        ([command, args]) =>
          command === "tail" &&
          (args as string[])[0] === "-c" &&
          (args as string[])[1] === String(128 * 1024),
      ),
    ).toHaveLength(2);
  });
});
