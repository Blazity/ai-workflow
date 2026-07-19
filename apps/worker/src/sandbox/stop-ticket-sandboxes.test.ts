import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(first.stop).toHaveBeenCalledWith({ blocking: true });
    expect(second.stop).toHaveBeenCalledWith({ blocking: true });
  });

  it.each(["pending", "stopping", "snapshotting"] as const)(
    "blocks until a %s sandbox reaches a terminal state",
    async (status) => {
      const sandbox = makeSandbox(status);
      mockGet.mockResolvedValue(sandbox);

      const { stopSandboxesByIds } = await import("./stop-ticket-sandboxes.js");
      await expect(stopSandboxesByIds([`sbx-${status}`])).resolves.toBe(1);
      expect(sandbox.stop).toHaveBeenCalledWith({ blocking: true });
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
    expect(first.stop).toHaveBeenCalledWith({ blocking: true });
    expect(second.stop).toHaveBeenCalledWith({ blocking: true });
  });
});
