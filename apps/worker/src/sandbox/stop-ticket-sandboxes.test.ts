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

function makeSandbox(status: "running" | "stopped" = "running") {
  return {
    status,
    stop: vi.fn().mockResolvedValue(undefined),
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
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });
});
