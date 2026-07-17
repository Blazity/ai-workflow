import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  snapshotGet: vi.fn(),
  registerSandbox: vi.fn(),
  unregisterSandbox: vi.fn(),
  configure: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: mocks.get, create: mocks.create },
  Snapshot: { get: mocks.snapshotGet },
}));
vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({ token: "vercel-token", teamId: "team", projectId: "project" }),
}));
vi.mock("../lib/step-adapters.js", () => ({
  createStepAdapters: () => ({
    runRegistry: {
      registerSandbox: mocks.registerSandbox,
      unregisterSandbox: mocks.unregisterSandbox,
    },
  }),
}));
vi.mock("../sandbox/agents/index.js", () => ({
  createAgentAdapter: (kind: string) => ({ kind, configure: mocks.configure }),
}));
vi.mock("../../env.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "anthropic-fresh",
    CODEX_API_KEY: "codex-fresh",
    CODEX_CHATGPT_OAUTH_TOKEN: undefined,
    GENAI_ENGINE_API_KEY: "arthur-fresh",
    GENAI_ENGINE_TRACE_ENDPOINT: "https://arthur.example/api/v1/traces",
  },
}));

import {
  CLARIFICATION_SNAPSHOT_RETENTION_MS,
  deleteClarificationSnapshotStep,
  restoreClarificationSandboxStep,
  snapshotClarificationSandboxStep,
} from "./clarification-snapshot-steps.js";

describe("clarification sandbox snapshot Workflow steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrubs credentials, snapshots for seven days, and polls until the source stopped", async () => {
    const events: string[] = [];
    const runCommand = vi.fn(async () => {
      events.push("scrub");
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    });
    const snapshot = vi.fn(async (opts: { expiration: number }) => {
      events.push("snapshot");
      expect(opts.expiration).toBe(CLARIFICATION_SNAPSHOT_RETENTION_MS);
      return {
        snapshotId: "snap-1",
        sourceSandboxId: "sbx-source",
        expiresAt: new Date("2026-07-24T00:00:00.000Z"),
        status: "created",
      };
    });
    mocks.get
      .mockResolvedValueOnce({ sandboxId: "sbx-source", status: "running", runCommand, snapshot })
      .mockResolvedValueOnce({ sandboxId: "sbx-source", status: "snapshotting" })
      .mockResolvedValueOnce({ sandboxId: "sbx-source", status: "stopped" });

    const result = await snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      sandboxId: "sbx-source",
      pollIntervalMs: 0,
    });

    const scrubScript = String((runCommand.mock.calls[0] as unknown as [string, string[]])?.[1]?.[1]);
    expect(scrubScript).toContain("agent-env*.sh");
    expect(scrubScript).toContain("$HOME/.codex");
    expect(scrubScript).toContain("$HOME/.claude");
    expect(scrubScript).toContain("arthur");
    expect(events).toEqual(["scrub", "snapshot"]);
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(mocks.unregisterSandbox).toHaveBeenCalledWith(
      "ticket:jira:AIW-96",
      "owner-parked",
      "sbx-source",
    );
    expect(result).toEqual({
      snapshotId: "snap-1",
      sourceSandboxId: "sbx-source",
      expiresAt: "2026-07-24T00:00:00.000Z",
    });
  });

  it("restores from only snapshot metadata, registers the exact successor, then injects fresh credentials", async () => {
    const events: string[] = [];
    const restored = { sandboxId: "sbx-restored", stop: vi.fn() };
    mocks.create.mockImplementation(async () => {
      events.push("create");
      return restored;
    });
    mocks.registerSandbox.mockImplementation(async () => {
      events.push("register");
    });
    mocks.configure.mockImplementation(async () => {
      events.push("configure");
    });

    const result = await restoreClarificationSandboxStep({
      snapshotId: "snap-1",
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-successor",
      timeoutMs: 900_000,
      agents: [
        { kind: "codex", model: "gpt-5-codex" },
        { kind: "claude", model: "claude-opus" },
      ],
      arthurTaskId: "arthur-task",
    });

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      source: { type: "snapshot", snapshotId: "snap-1" },
      timeout: 900_000,
    }));
    expect(events).toEqual(["create", "register", "configure", "configure"]);
    expect(mocks.registerSandbox).toHaveBeenCalledWith(
      "ticket:jira:AIW-96",
      "owner-successor",
      "sbx-restored",
    );
    expect(mocks.configure).toHaveBeenNthCalledWith(
      1,
      restored,
      expect.objectContaining({ model: "gpt-5-codex", codexApiKey: "codex-fresh" }),
    );
    expect(mocks.configure).toHaveBeenNthCalledWith(
      2,
      restored,
      expect.objectContaining({ model: "claude-opus", anthropicApiKey: "anthropic-fresh" }),
    );
    expect(result).toEqual({ sandboxId: "sbx-restored" });
  });

  it("does not lose a created snapshot when stopped-sandbox unregistering is transiently unavailable", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    });
    const snapshot = vi.fn().mockResolvedValue({
      snapshotId: "snap-durable",
      sourceSandboxId: "sbx-source",
      expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      status: "created",
    });
    mocks.get
      .mockResolvedValueOnce({ runCommand, snapshot })
      .mockResolvedValueOnce({ status: "stopped" });
    mocks.unregisterSandbox.mockRejectedValue(new Error("registry unavailable"));

    await expect(
      snapshotClarificationSandboxStep({
        subjectKey: "ticket:jira:AIW-96",
        ownerToken: "owner-parked",
        sandboxId: "sbx-source",
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ snapshotId: "snap-durable" });
  });

  it("deletes a snapshot by id and reports unavailable snapshots actionably", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.snapshotGet.mockResolvedValueOnce({ delete: remove });
    await expect(deleteClarificationSnapshotStep("snap-1")).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();

    mocks.snapshotGet.mockRejectedValueOnce(new Error("404 not found"));
    await expect(deleteClarificationSnapshotStep("snap-expired")).rejects.toThrow(
      /snapshot snap-expired is unavailable or expired.*restart the ticket/i,
    );
  });
});
