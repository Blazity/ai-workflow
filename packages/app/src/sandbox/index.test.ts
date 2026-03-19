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
  it("returns VercelSandboxProvider when provider is vercel", async () => {
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_TEAM_ID = "team";
    process.env.VERCEL_PROJECT_ID = "proj";
    const { createSandboxProvider } = await import("./index.js");
    const provider = await createSandboxProvider({ provider: "vercel", vercel: { vcpus: 2 } });
    expect(provider.constructor.name).toBe("VercelSandboxProvider");
  });

  it("throws on unknown provider", async () => {
    const { createSandboxProvider } = await import("./index.js");
    await expect(
      createSandboxProvider({ provider: "unknown" as any } as any),
    ).rejects.toThrow("Unknown sandbox provider");
  });

  it("throws when Vercel env vars are missing", async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    const { createSandboxProvider } = await import("./index.js");
    await expect(
      createSandboxProvider({ provider: "vercel", vercel: { vcpus: 2 } }),
    ).rejects.toThrow("VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID");
  });
});
