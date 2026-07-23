import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    CODEX_CHATGPT_OAUTH_TOKEN: undefined,
    JOB_TIMEOUT_MS: 120_000,
    GENAI_ENGINE_API_KEY: undefined,
    GENAI_ENGINE_TRACE_ENDPOINT: undefined,
    DASHBOARD_ORG_SLUG: "test-org",
  } as Record<string, unknown>,
  sandboxCreate: vi.fn(),
  sandboxGet: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  runCommand: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: vi.fn().mockResolvedValue(""),
    stderr: vi.fn().mockResolvedValue(""),
  }),
  writeFiles: vi.fn().mockResolvedValue(undefined),
  install: vi.fn().mockResolvedValue(undefined),
  configure: vi.fn().mockResolvedValue(undefined),
  createAgentAdapter: vi.fn(),
  registerSandbox: vi.fn().mockResolvedValue(undefined),
  dashboardOrganizationId: vi.fn().mockResolvedValue("org-1"),
  resolveHarnessProfileVersion: vi.fn(),
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: mocks.sandboxCreate, get: mocks.sandboxGet },
}));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../workflow-definition/harness-profile-runtime.js", () => ({
  dashboardOrganizationId: mocks.dashboardOrganizationId,
}));
vi.mock("../../harness-profiles/store.js", () => ({
  resolveHarnessProfileVersion: mocks.resolveHarnessProfileVersion,
}));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
vi.mock("../../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));

import {
  ensureAgentSandbox,
  prepareHarnessAgentInvocationStep,
} from "./agent-sandbox.js";
import { teardownSandboxes } from "../../sandbox/poll-agent.js";
import {
  makeCtx,
  makeHarnessRuntime,
  runControlErrorCases,
} from "./test-support.js";

describe("ensureAgentSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stop.mockResolvedValue({ status: "stopped" });
    mocks.sandboxCreate.mockResolvedValue({
      sandboxId: "scratch-1",
      status: "running",
      stop: mocks.stop,
      runCommand: mocks.runCommand,
      writeFiles: mocks.writeFiles,
    });
    mocks.sandboxGet.mockResolvedValue({
      sandboxId: "scratch-1",
      status: "running",
      runCommand: mocks.runCommand,
      writeFiles: mocks.writeFiles,
    });
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
    expect(ctx.agentSandboxIds["legacy:claude"]).toBe("scratch-1");
    expect([...ctx.sandboxIds]).toEqual(["scratch-1"]);
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "scratch-1",
    );
  });

  it("provisions distinct sandboxes for isolated same-manifest invocations", async () => {
    mocks.sandboxCreate
      .mockResolvedValueOnce({
        sandboxId: "scratch-1",
        status: "running",
        stop: mocks.stop,
      })
      .mockResolvedValueOnce({
        sandboxId: "scratch-2",
        status: "running",
        stop: mocks.stop,
      });
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: {},
      sandboxIds: new Set(),
      arthur: { taskId: "task-1" },
    });
    const runtime = makeHarnessRuntime(
      "generic",
      "generic_agent",
      { workspaceMode: "none" },
    );

    const sandboxes = [
      await ensureAgentSandbox(ctx, "claude", "claude-model", {
        reuse: false,
        runtime,
      }),
      await ensureAgentSandbox(ctx, "claude", "claude-model", {
        reuse: false,
        runtime,
      }),
    ];

    expect(sandboxes).toEqual(["scratch-1", "scratch-2"]);
    expect(mocks.sandboxCreate).toHaveBeenCalledTimes(2);
    expect(ctx.agentSandboxIds.claude).toBeUndefined();
    expect([...ctx.sandboxIds].sort()).toEqual(["scratch-1", "scratch-2"]);
  });

  it("isolates reusable sandboxes by exact manifest hash", async () => {
    mocks.sandboxCreate
      .mockResolvedValueOnce({
        sandboxId: "scratch-1",
        status: "running",
        stop: mocks.stop,
        runCommand: mocks.runCommand,
        writeFiles: mocks.writeFiles,
      })
      .mockResolvedValueOnce({
        sandboxId: "scratch-2",
        status: "running",
        stop: mocks.stop,
        runCommand: mocks.runCommand,
        writeFiles: mocks.writeFiles,
      });
    const firstRuntime = makeHarnessRuntime(
      "first",
      "generic_agent",
      { model: "claude-model-a", workspaceMode: "none" },
    );
    const secondRuntime = makeHarnessRuntime(
      "second",
      "generic_agent",
      { model: "claude-model-b", workspaceMode: "none" },
    );
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: {},
      sandboxIds: new Set(),
    });

    const first = await ensureAgentSandbox(
      ctx,
      "claude",
      firstRuntime.manifest.model.id,
      { runtime: firstRuntime },
    );
    const firstAgain = await ensureAgentSandbox(
      ctx,
      "claude",
      firstRuntime.manifest.model.id,
      { runtime: firstRuntime },
    );
    const second = await ensureAgentSandbox(
      ctx,
      "claude",
      secondRuntime.manifest.model.id,
      { runtime: secondRuntime },
    );

    expect([first, firstAgain, second]).toEqual([
      "scratch-1",
      "scratch-1",
      "scratch-2",
    ]);
    expect(mocks.sandboxCreate).toHaveBeenCalledTimes(2);
    expect(ctx.agentSandboxIds).toEqual({
      [firstRuntime.manifestHash]: "scratch-1",
      [secondRuntime.manifestHash]: "scratch-2",
    });
    // Provisioning stores no executable/profile bytes. The exact pinned CLI
    // is reinstalled together with the selected home at invocation time.
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("rebuilds and configures only the selected profile at invocation time", async () => {
    const runtime = makeHarnessRuntime(
      "generic",
      "generic_agent",
      { workspaceMode: "none" },
    );
    mocks.resolveHarnessProfileVersion.mockResolvedValue({
      manifest: runtime.manifest,
      manifestHash: runtime.manifestHash,
      skillArtifacts: [],
    });

    await expect(
      prepareHarnessAgentInvocationStep(
        "scratch-1",
        "claude",
        runtime.manifest.model.id,
        null,
        runtime,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });

    expect(mocks.runCommand).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "-c",
        expect.stringContaining("find /tmp/aiw-harness"),
      ]),
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.anything(),
      runtime.paths,
    );
    expect(mocks.configure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        anthropicApiKey: "anthropic-key",
        model: runtime.manifest.model.id,
        runtime: runtime.paths,
        legacyDynamicSkills: false,
      }),
    );
  });

  it("never reuses a profile sandbox when preservation is disabled", async () => {
    mocks.sandboxCreate
      .mockResolvedValueOnce({
        sandboxId: "scratch-1",
        status: "running",
        stop: mocks.stop,
        runCommand: mocks.runCommand,
        writeFiles: mocks.writeFiles,
      })
      .mockResolvedValueOnce({
        sandboxId: "scratch-2",
        status: "running",
        stop: mocks.stop,
        runCommand: mocks.runCommand,
        writeFiles: mocks.writeFiles,
      });
    const runtime = makeHarnessRuntime(
      "isolated",
      "generic_agent",
      {
        preserveAcrossBlocks: false,
        workspaceMode: "none",
      },
    );
    const ctx = makeCtx({
      sandboxId: null,
      agentSandboxIds: {},
      sandboxIds: new Set(),
    });

    const first = await ensureAgentSandbox(
      ctx,
      "claude",
      runtime.manifest.model.id,
      { runtime },
    );
    const second = await ensureAgentSandbox(
      ctx,
      "claude",
      runtime.manifest.model.id,
      { runtime },
    );

    expect([first, second]).toEqual(["scratch-1", "scratch-2"]);
    expect(ctx.agentSandboxIds).toEqual({});
  });

  it("tracks a created sandbox before a registry failure", async () => {
    mocks.registerSandbox.mockRejectedValueOnce(new Error("registry unavailable"));
    const ctx = makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() });

    await expect(ensureAgentSandbox(ctx, "claude", "claude-model")).rejects.toThrow(
      "registry unavailable",
    );

    expect(ctx.agentSandboxIds.claude).toBeUndefined();
    expect([...ctx.sandboxIds]).toEqual([]);
    expect(mocks.stop).toHaveBeenCalledWith({ blocking: true });
  });

  it("fails closed when scratch-sandbox registration cleanup is not terminal", async () => {
    mocks.registerSandbox.mockRejectedValueOnce(new Error("owner entered cancellation"));
    mocks.stop.mockResolvedValueOnce({ status: "stopping" });
    const ctx = makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() });

    await expect(ensureAgentSandbox(ctx, "claude", "claude-model")).rejects.toThrow(
      /cleanup unconfirmed.*stopping/i,
    );

    expect(mocks.stop).toHaveBeenCalledWith({ blocking: true });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it.each(runControlErrorCases())(
    "preserves %s when scratch-sandbox cleanup also fails",
    async (_label, error) => {
      mocks.registerSandbox.mockRejectedValueOnce(error);
      mocks.stop.mockResolvedValueOnce({ status: "stopping" });

      await expect(
        ensureAgentSandbox(
          makeCtx({ sandboxId: null, agentSandboxIds: {}, sandboxIds: new Set() }),
          "claude",
          "claude-model",
        ),
      ).rejects.toBe(error);
    },
  );

  it("durably registers a scratch sandbox even when a code workspace already exists", async () => {
    const ctx = makeCtx({
      sandboxId: "code-1",
      agentSandboxIds: {},
      sandboxIds: new Set(["code-1"]),
    });

    await expect(ensureAgentSandbox(ctx, "claude", "claude-model")).resolves.toBe(
      "scratch-1",
    );

    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AWT-1",
      "owner:test",
      "scratch-1",
    );
    expect([...ctx.sandboxIds]).toEqual(["code-1", "scratch-1"]);

    const teardown = vi.fn().mockResolvedValue(undefined);
    await teardownSandboxes(ctx.sandboxIds, teardown);
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledWith("code-1");
    expect(teardown).toHaveBeenCalledWith("scratch-1");
  });
});
