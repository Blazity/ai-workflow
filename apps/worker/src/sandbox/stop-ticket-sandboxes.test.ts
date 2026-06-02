import { beforeEach, describe, expect, it, vi } from "vitest";

const mockList = vi.fn();
const mockGet = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    list: (...args: any[]) => mockList(...args),
    get: (...args: any[]) => mockGet(...args),
  },
}));

vi.mock("./credentials.js", () => ({
  getSandboxCredentials: vi.fn(() => ({})),
}));

function makeSandbox(branch: string, status: "running" | "stopped" = "running") {
  return {
    status,
    runCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: async () => branch,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("stopTicketSandboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops running sandboxes on the ticket branch", async () => {
    const matching = makeSandbox("blazebot/proj-42");
    const other = makeSandbox("blazebot/proj-99");

    mockList.mockResolvedValue({
      json: {
        sandboxes: [
          { id: "sbx-1", status: "running" },
          { id: "sbx-2", status: "running" },
        ],
      },
    });

    mockGet.mockImplementation(async ({ sandboxId }: { sandboxId: string }) => {
      if (sandboxId === "sbx-1") return matching;
      if (sandboxId === "sbx-2") return other;
      throw new Error(`unexpected sandbox id: ${sandboxId}`);
    });

    const { stopTicketSandboxes } = await import("./stop-ticket-sandboxes.js");
    const stopped = await stopTicketSandboxes("PROJ-42");

    expect(stopped).toBe(1);
    expect(matching.stop).toHaveBeenCalledTimes(1);
    expect(other.stop).not.toHaveBeenCalled();
  });

  it("returns 0 when sandbox listing fails", async () => {
    mockList.mockRejectedValue(new Error("sandbox api down"));

    const { stopTicketSandboxes } = await import("./stop-ticket-sandboxes.js");
    const stopped = await stopTicketSandboxes("PROJ-42");

    expect(stopped).toBe(0);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
