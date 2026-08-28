import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: (...args: any[]) => mockGet(...args),
  },
}));

vi.mock("./credentials.js", () => ({
  getSandboxCredentials: vi.fn(() => ({})),
}));

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

describe("stopSandboxesByIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops every explicitly owned sandbox id without branch discovery", async () => {
    const first = makeSandbox();
    const second = makeSandbox();
    mockGet.mockImplementation(async ({ sandboxId }: { sandboxId: string }) =>
      sandboxId === "sbx-child-1" ? first : second,
    );

    const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
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

      const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
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

      const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
      await expect(stopSandboxesByIds([`sbx-${status}`])).resolves.toBe(0);
      expect(sandbox.stop).not.toHaveBeenCalled();
    },
  );

  it("rejects when a blocking stop does not confirm a terminal result", async () => {
    const sandbox = makeSandbox("running", "stopping");
    mockGet.mockResolvedValue(sandbox);

    const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
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

    const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
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
    const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
    await import("@vercel/sandbox");
    vi.useFakeTimers();
    mockGet.mockImplementation(() => new Promise(() => {}));
    const pending = stopSandboxesByIds(["sbx-never-gets"]);
    const outcome = pending.then(() => null, (error) => error);

    for (let tick = 0; tick < 100 && mockGet.mock.calls.length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(mockGet).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("sbx-never-gets"),
    });
  });

  it("bounds a blocking stop that never settles instead of hanging cleanup", async () => {
    const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
    await import("@vercel/sandbox");
    vi.useFakeTimers();
    const sandbox = makeSandbox();
    sandbox.stop.mockImplementation(() => new Promise(() => {}));
    mockGet.mockResolvedValue(sandbox);
    const pending = stopSandboxesByIds(["sbx-never-stops"]);
    const outcome = pending.then(() => null, (error) => error);

    for (let tick = 0; tick < 100 && sandbox.stop.mock.calls.length === 0; tick += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(sandbox.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("sbx-never-stops"),
    });
  });
});
