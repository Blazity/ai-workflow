import { describe, it, expect, vi } from "vitest";

vi.mock("dockerode", () => {
  const mockContainer = {
    id: "test",
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    logs: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    remove: vi.fn(),
    kill: vi.fn(),
  };
  class MockDocker {
    createContainer = vi.fn().mockResolvedValue(mockContainer);
    getContainer = vi.fn().mockReturnValue(mockContainer);
    listContainers = vi.fn().mockResolvedValue([]);
  }
  return { default: MockDocker };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/blazebot-abc"),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  },
}));

vi.mock("@blazebot/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

describe("createSandboxProvider", () => {
  it("returns DockerSandboxProvider when provider is docker", async () => {
    const { createSandboxProvider } = await import("./index.js");
    const provider = createSandboxProvider({
      provider: "docker",
      docker: { image: "test", memoryLimitMb: 4096 },
    });
    expect(provider.constructor.name).toBe("DockerSandboxProvider");
  });

  it("returns VercelSandboxProvider when provider is vercel", async () => {
    const { createSandboxProvider } = await import("./index.js");
    const provider = createSandboxProvider({ provider: "vercel", vercel: { vcpus: 2 } });
    expect(provider.constructor.name).toBe("VercelSandboxProvider");
  });

  it("throws on unknown provider", async () => {
    const { createSandboxProvider } = await import("./index.js");
    expect(() =>
      createSandboxProvider({ provider: "unknown" as any } as any),
    ).toThrow("Unknown sandbox provider");
  });
});
