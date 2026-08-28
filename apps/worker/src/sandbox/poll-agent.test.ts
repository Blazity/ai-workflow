import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sandbox } from "@vercel/sandbox";

const mockRunCommand = vi.fn();
const mockStop = vi.fn();
const trackedFixturePromises = new Set<Promise<void>>();
const fixtureCleanups = new Set<() => void>();

function trackFixturePromise<T>(promise: Promise<T>): Promise<T> {
  trackedFixturePromises.add(promise.then(() => undefined, () => undefined));
  return promise;
}

function captureFailure<T>(promise: Promise<T>) {
  return trackFixturePromise(promise).catch((error) => error);
}

function createDeferred<T>() {
  let done = false;
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = trackFixturePromise(
    new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    }),
  );
  let cleanup!: () => void;
  const settle = (action: () => void) => {
    if (done) return;
    done = true;
    fixtureCleanups.delete(cleanup);
    action();
  };
  cleanup = () => settle(() => reject(new Error("test cleanup")));
  fixtureCleanups.add(cleanup);
  return {
    promise,
    resolve: (value: T) => settle(() => resolve(value)),
    reject: (reason: unknown) => settle(() => reject(reason)),
  };
}

function rejectOnAbort<T>(signal: AbortSignal): Promise<T> {
  const pending = createDeferred<T>();
  if (signal.aborted) pending.reject(signal.reason);
  else signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
  return pending.promise;
}

function abortableStdout() {
  const reads: Promise<string>[] = [];
  const stdout = vi.fn(({ signal }: { signal: AbortSignal }) => {
    const read = rejectOnAbort<string>(signal);
    reads.push(read);
    return read;
  });
  return { stdout, results: () => Promise.allSettled(reads) };
}

async function drainFixturePromises() {
  for (;;) {
    const tracked = [...trackedFixturePromises];
    await Promise.all(tracked);
    await Promise.resolve();
    if (tracked.length === trackedFixturePromises.size) return;
  }
}

async function cleanupFixtures() {
  for (const cleanup of [...fixtureCleanups]) cleanup();
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await drainFixturePromises();
  trackedFixturePromises.clear();
  fixtureCleanups.clear();
}

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

function expectCurrentSandboxGet(sandboxId = "sbx-test-123") {
  expect(mockSandboxGet).toHaveBeenCalledTimes(1);
  const signal = mockSandboxGet.mock.calls[0]?.[0].signal as AbortSignal;
  expect(mockSandboxGet).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxId, signal }),
  );
  return signal;
}

function expectCurrentArtifactRead(stdout?: ReturnType<typeof vi.fn>) {
  expect(mockRunCommand).toHaveBeenCalledTimes(1);
  const signal = mockRunCommand.mock.calls[0]?.[2].signal as AbortSignal;
  expect(expectCurrentSandboxGet()).toBe(signal);
  expect(mockRunCommand).toHaveBeenCalledWith(
    "cat",
    ["/tmp/stdout"],
    { signal },
  );
  if (stdout) {
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith({ signal });
  }
  return signal;
}

function resetSandboxMocks() {
  if (trackedFixturePromises.size !== 0 || fixtureCleanups.size !== 0) {
    throw new Error("sandbox fixtures must be drained before mock reset");
  }
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

afterEach(async () => {
  try {
    await cleanupFixtures();
  } finally {
    vi.useRealTimers();
  }
});

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

const phasePaths = {
  stdout: "/tmp/stdout",
  stderr: "/tmp/stderr",
  structuredOutput: null,
  exitCode: "/tmp/exit-code",
} as const;

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
    const pendingStop = createDeferred<void>();
    mockStop.mockImplementationOnce(() => pendingStop.promise);
    await expect(
      trackFixturePromise(teardownSandbox("sbx-test-123", 25)),
    ).resolves.toBeUndefined();
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
        rejectOnAbort(opts.signal),
    );
    await expect(
      checkPhaseDone("sbx-test-123", "/tmp/phase-done", 25),
    ).resolves.toBe("stopped");
  });

  it("reports stopped even when the sandbox client ignores the abort signal", async () => {
    const pendingRunCommand = createDeferred<never>();
    mockRunCommand.mockImplementation(() => pendingRunCommand.promise);
    await expect(
      trackFixturePromise(checkPhaseDone("sbx-test-123", "/tmp/phase-done", 25)),
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
    const pendingRunCommand = createDeferred<ReturnType<typeof result>>();
    mockRunCommand.mockImplementation(() => pendingRunCommand.promise);
    const failure = captureFailure(
      collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr"),
    );

    for (let i = 0; i < 100 && mockRunCommand.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expectCurrentArtifactRead();
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await failure;
    expect(error).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });

  it("aborts a stdout stream that never settles when the artifact deadline expires", async () => {
    vi.useFakeTimers();
    const { stdout } = abortableStdout();
    mockRunCommand.mockImplementation(() =>
      Promise.resolve({ ...result(), stdout }),
    );
    const failure = captureFailure(
      collectPhaseOutput("sbx-test-123", "/tmp/stdout", "/tmp/stderr"),
    );

    for (let i = 0; i < 100 && stdout.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    const deadlineSignal = expectCurrentArtifactRead(stdout);
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await failure;
    expect(deadlineSignal.aborted).toBe(true);
    expect(error).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });
});

describe("collectPhase", () => {
  beforeEach(resetSandboxMocks);

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
    const pendingSandboxGet = createDeferred<never>();
    mockSandboxGet.mockImplementationOnce(() => pendingSandboxGet.promise);
    const failure = captureFailure(
      collectPhase("sbx-test-123", phasePaths),
    );

    for (let i = 0; i < 100 && mockSandboxGet.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expectCurrentSandboxGet();
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await failure;
    expect(error).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });

  it("bounds an artifact read that never settles with the deterministic deadline error", async () => {
    vi.useFakeTimers();
    const pendingRunCommand = createDeferred<ReturnType<typeof result>>();
    mockRunCommand.mockImplementation(() => pendingRunCommand.promise);
    const failure = captureFailure(
      collectPhase("sbx-test-123", phasePaths),
    );

    for (let i = 0; i < 100 && mockRunCommand.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expectCurrentArtifactRead();
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await failure;
    expect(error).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });

  it("aborts a stdout stream that never settles when the artifact deadline expires", async () => {
    vi.useFakeTimers();
    const { stdout } = abortableStdout();
    mockRunCommand.mockImplementation(() =>
      Promise.resolve({ ...result(), stdout }),
    );
    const failure = captureFailure(
      collectPhase("sbx-test-123", phasePaths),
    );

    for (let i = 0; i < 100 && stdout.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    const deadlineSignal = expectCurrentArtifactRead(stdout);
    await vi.advanceTimersByTimeAsync(60_000);

    const error = await failure;
    expect(deadlineSignal.aborted).toBe(true);
    expect(error).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
  });

  it("drains a late stdout abort before the next poll uses the sandbox mocks", async () => {
    vi.useFakeTimers();
    const { stdout, results } = abortableStdout();
    const delayedSandbox = {
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      stop: mockStop,
    };
    const pendingSandboxGet = createDeferred<typeof delayedSandbox>();
    mockSandboxGet.mockImplementationOnce(() => pendingSandboxGet.promise);
    mockRunCommand.mockImplementation(() => Promise.resolve({ ...result(), stdout }));

    const failure = captureFailure(
      collectPhase("sbx-test-123", phasePaths),
    );

    for (let i = 0; i < 100 && mockSandboxGet.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    const deadlineSignal = expectCurrentSandboxGet();

    await vi.advanceTimersByTimeAsync(60_000);
    const error = await failure;

    pendingSandboxGet.resolve(delayedSandbox);
    for (let i = 0; i < 100 && stdout.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(expectCurrentArtifactRead(stdout)).toBe(deadlineSignal);
    await drainFixturePromises();
    expect(await results()).toMatchObject([{
      status: "rejected",
      reason: { name: "SandboxDeadlineError", deadlineMs: 60_000 },
    }]);
    expect(error).toMatchObject({ name: "SandboxDeadlineError", deadlineMs: 60_000 });
    expect(deadlineSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    mockSandboxGet.mockClear();
    mockRunCommand.mockReset().mockResolvedValue({ exitCode: 0 });

    await expect(
      checkPhaseDone("sbx-next", "/tmp/next-phase-done"),
    ).resolves.toBe(true);
    expect(mockSandboxGet).toHaveBeenCalledTimes(1);
    expect(mockSandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx-next", signal: expect.any(AbortSignal) }),
    );
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
    expect(mockRunCommand).toHaveBeenCalledWith(
      "test",
      ["-f", "/tmp/next-phase-done"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds replay-only partial artifact reads", async () => {
    const pendingStdout = createDeferred<string>();
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      stdout: vi.fn(() => pendingStdout.promise),
      stderr: vi.fn().mockResolvedValue(""),
    });

    const failure = captureFailure(
      collectPhaseReplayDiagnostics(
        "sbx-test-123",
        phasePaths,
        5,
      ),
    );
    const error = await failure;
    expect(error).toMatchObject({ message: expect.stringContaining("Replay capture timed out") });
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
