import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    CODEX_CHATGPT_OAUTH_TOKEN: undefined,
    JOB_TIMEOUT_MS: 120_000,
    GENAI_ENGINE_API_KEY: undefined,
    GENAI_ENGINE_TRACE_ENDPOINT: undefined,
  } as Record<string, unknown>,
  sandboxCreate: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined),
  configure: vi.fn().mockResolvedValue(undefined),
  createAgentAdapter: vi.fn(),
  registerSandbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: mocks.sandboxCreate } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));

import { ensureAgentSandbox } from "./agent-sandbox.js";
import { teardownSandboxes } from "../../sandbox/poll-agent.js";
import { makeCtx } from "./test-support.js";

describe("ensureAgentSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxCreate.mockResolvedValue({ sandboxId: "scratch-1", stop: mocks.stop });
    mocks.createAgentAdapter.mockReturnValue({
      install: mocks.install,
      configure: mocks.configure,
    });
  });

  it("provisions and reuses a repository-free sandbox for one agent kind", async () => {
    const ctx = makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() });

    const first = await ensureAgentSandbox(ctx, "claude", "claude-model");
    const second = await ensureAgentSandbox(ctx, "claude", "claude-model");

    expect(first).toBe("scratch-1");
    expect(second).toBe("scratch-1");
    expect(mocks.sandboxCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      runtime: "node24",
      timeout: 120_000,
    });
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.configure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: "claude-model", anthropicApiKey: "anthropic-key" }),
    );
    expect(ctx.agentSandboxIds.claude).toBe("scratch-1");
    expect([...ctx.sandboxIds]).toEqual(["scratch-1"]);
    expect(mocks.registerSandbox).toHaveBeenCalledWith("AWT-1", "scratch-1");
  });

  it("tracks a created sandbox before a registry failure", async () => {
    mocks.registerSandbox.mockRejectedValueOnce(new Error("registry unavailable"));
    const ctx = makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() });

    await expect(ensureAgentSandbox(ctx, "claude", "claude-model")).rejects.toThrow(
      "registry unavailable",
    );

    expect(ctx.agentSandboxIds.claude).toBe("scratch-1");
    expect([...ctx.sandboxIds]).toEqual(["scratch-1"]);
  });

  it("keeps code and scratch sandboxes in terminal cleanup without replacing the registry slot", async () => {
    const ctx = makeCtx({
      sandboxId: "code-1",
      agentSandboxIds: {},
      sandboxIds: new Set(["code-1"]),
    });

    await expect(ensureAgentSandbox(ctx, "claude", "claude-model")).resolves.toBe(
      "scratch-1",
    );

    expect(mocks.registerSandbox).not.toHaveBeenCalled();
    expect([...ctx.sandboxIds]).toEqual(["code-1", "scratch-1"]);

    const teardown = vi.fn().mockResolvedValue(undefined);
    await teardownSandboxes(ctx.sandboxIds, teardown);
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledWith("code-1");
    expect(teardown).toHaveBeenCalledWith("scratch-1");
  });
});
