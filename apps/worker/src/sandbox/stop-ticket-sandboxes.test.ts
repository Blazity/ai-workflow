import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
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
  };
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
    get: (...args: any[]) => mockGet(...args),
  },
}));

vi.mock("./credentials.js", () => ({
  getSandboxCredentials: vi.fn(() => ({})),
}));

import { stopSandboxesByIds } from "./stop-ticket-sandboxes.js";

type SandboxStatus =
  | "aborted"
  | "failed"
  | "pending"
  | "running"
  | "snapshotting"
  | "stopped"
  | "stopping";

function makeSandbox(
  status: SandboxStatus = "running",
  stoppedStatus: SandboxStatus = "stopped",
) {
  return {
    status,
    stop: vi.fn().mockResolvedValue({ status: stoppedStatus }),
  };
}

async function expectStalledGetDeadline(sandboxId: string) {
  const stalledGet = createDeferred<ReturnType<typeof makeSandbox>>();
  const getStarted = createDeferred<{ signal: AbortSignal }>();
  mockGet.mockClear();
  mockGet.mockImplementation((options: { signal: AbortSignal }) => {
    getStarted.resolve(options);
    return stalledGet.promise;
  });

  const failure = captureFailure(stopSandboxesByIds([sandboxId]));
  const { signal } = await getStarted.promise;

  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(mockGet).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxId, signal }),
  );

  await vi.advanceTimersByTimeAsync(60_000);
  const error = await failure;

  expect(signal.aborted).toBe(true);
  expect(error).toMatchObject({
    message: expect.stringContaining(sandboxId),
  });

  const terminalSandbox = makeSandbox("stopped");
  stalledGet.resolve(terminalSandbox);
  await drainFixturePromises();
  expect(terminalSandbox.stop).not.toHaveBeenCalled();
}

async function expectStalledStopDeadline(sandboxId: string) {
  const stalledStop = createDeferred<{ status: SandboxStatus }>();
  const stopStarted = createDeferred<{
    blocking: boolean;
    signal: AbortSignal;
  }>();
  const sandbox = makeSandbox();
  sandbox.stop.mockImplementation((options) => {
    stopStarted.resolve(options);
    return stalledStop.promise;
  });
  mockGet.mockClear();
  mockGet.mockResolvedValue(sandbox);

  const failure = captureFailure(stopSandboxesByIds([sandboxId]));
  const options = await stopStarted.promise;

  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(mockGet).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxId, signal: options.signal }),
  );
  expect(sandbox.stop).toHaveBeenCalledTimes(1);
  expect(sandbox.stop).toHaveBeenCalledWith({
    blocking: true,
    signal: options.signal,
  });

  await vi.advanceTimersByTimeAsync(60_000);
  const error = await failure;

  expect(options.signal.aborted).toBe(true);
  expect(error).toMatchObject({
    message: expect.stringContaining(sandboxId),
  });

  stalledStop.resolve({ status: "stopped" });
  await drainFixturePromises();
}

describe("stopSandboxesByIds", () => {
  beforeEach(() => {
    if (trackedFixturePromises.size !== 0 || fixtureCleanups.size !== 0) {
      throw new Error("sandbox fixtures must be drained before mock reset");
    }
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await cleanupFixtures();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops every explicitly owned sandbox id without branch discovery", async () => {
    const first = makeSandbox();
    const second = makeSandbox();
    mockGet.mockImplementation(async ({ sandboxId }: { sandboxId: string }) =>
      sandboxId === "sbx-child-1" ? first : second,
    );

    const stopped = await stopSandboxesByIds(["sbx-child-1", "sbx-child-2"]);

    expect(stopped).toBe(2);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(first.stop).toHaveBeenCalledWith(
      expect.objectContaining({ blocking: true, signal: expect.any(AbortSignal) }),
    );
    expect(second.stop).toHaveBeenCalledWith(
      expect.objectContaining({ blocking: true, signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["pending", "stopping", "snapshotting"] as const)(
    "blocks until a %s sandbox reaches a terminal state",
    async (status) => {
      const sandbox = makeSandbox(status);
      mockGet.mockResolvedValue(sandbox);

      await expect(stopSandboxesByIds([`sbx-${status}`])).resolves.toBe(1);
      expect(sandbox.stop).toHaveBeenCalledWith(
        expect.objectContaining({ blocking: true, signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.each(["stopped", "failed", "aborted"] as const)(
    "accepts an already terminal %s sandbox without another stop request",
    async (status) => {
      const sandbox = makeSandbox(status);
      mockGet.mockResolvedValue(sandbox);

      await expect(stopSandboxesByIds([`sbx-${status}`])).resolves.toBe(0);
      expect(sandbox.stop).not.toHaveBeenCalled();
    },
  );

  it("rejects when a blocking stop does not confirm a terminal result", async () => {
    const sandbox = makeSandbox("running", "stopping");
    mockGet.mockResolvedValue(sandbox);

    await expect(stopSandboxesByIds(["sbx-unconfirmed"])).rejects.toThrow(
      "sbx-unconfirmed",
    );
  });

  it("tries every sandbox but rejects while any stop outcome is unconfirmed", async () => {
    const first = makeSandbox();
    const second = makeSandbox();
    first.stop.mockRejectedValue(new Error("provider unavailable"));
    mockGet.mockImplementation(async ({ sandboxId }: { sandboxId: string }) =>
      sandboxId === "sbx-child-1" ? first : second,
    );

    await expect(
      stopSandboxesByIds(["sbx-child-1", "sbx-child-2"]),
    ).rejects.toThrow("sbx-child-1");
    expect(first.stop).toHaveBeenCalledWith(
      expect.objectContaining({ blocking: true, signal: expect.any(AbortSignal) }),
    );
    expect(second.stop).toHaveBeenCalledWith(
      expect.objectContaining({ blocking: true, signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds a Sandbox.get call that never settles instead of hanging cleanup", async () => {
    vi.useFakeTimers();
    await expectStalledGetDeadline("sbx-never-gets");
  });

  it("bounds a blocking stop that never settles instead of hanging cleanup", async () => {
    vi.useFakeTimers();
    await expectStalledStopDeadline("sbx-never-stops");
  });

  it("drains both deadline branches before the next cleanup uses fresh mocks", async () => {
    vi.useFakeTimers();
    await expectStalledGetDeadline("sbx-sequential-get");
    await expectStalledStopDeadline("sbx-sequential-stop");

    const sandbox = makeSandbox();
    mockGet.mockClear();
    mockGet.mockResolvedValue(sandbox);

    await expect(stopSandboxesByIds(["sbx-next-cleanup"])).resolves.toBe(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx-next-cleanup",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });
});
