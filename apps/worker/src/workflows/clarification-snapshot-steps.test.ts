import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  snapshotGet: vi.fn(),
  snapshotList: vi.fn(),
  registerSandbox: vi.fn(),
  unregisterSandbox: vi.fn(),
  configure: vi.fn(),
  recordSnapshot: vi.fn(),
  completeCheckpoint: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: mocks.get, create: mocks.create },
  Snapshot: { get: mocks.snapshotGet, list: mocks.snapshotList },
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
vi.mock("../db/client.js", () => ({ getDb: () => "db-sentinel" }));
vi.mock("../clarifications/store.js", () => ({
  recordClarificationSnapshotMetadata: (...args: unknown[]) =>
    mocks.recordSnapshot(...args),
  completeClarificationCheckpoint: (...args: unknown[]) =>
    mocks.completeCheckpoint(...args),
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
    mocks.snapshotList.mockResolvedValue({
      json: {
        snapshots: [],
        pagination: { count: 0, next: null, prev: null },
      },
    });
    mocks.recordSnapshot.mockResolvedValue(undefined);
    mocks.completeCheckpoint.mockResolvedValue(undefined);
  });

  it("scrubs credentials, snapshots for seven days, and polls until the source stopped", async () => {
    const events: string[] = [];
    const runCommand = vi.fn(async () => {
      events.push("scrub");
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    });
    const snapshot = vi.fn(async (opts: { expiration: number; signal?: AbortSignal }) => {
      events.push("snapshot");
      expect(opts.expiration).toBe(CLARIFICATION_SNAPSHOT_RETENTION_MS);
      expect(opts.signal).toBeInstanceOf(AbortSignal);
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
      clarificationId: "clar-1",
      sandboxId: "sbx-source",
      snapshotRequestedAt: "2026-07-17T00:00:00.000Z",
      timeoutMs: 10_000,
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
    expect(mocks.snapshotList).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date("2026-07-16T23:55:00.000Z"),
      signal: expect.any(AbortSignal),
    }));
    expect(runCommand).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.any(String)],
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.completeCheckpoint).toHaveBeenCalledWith(
      "db-sentinel",
      "clar-1",
      {
        snapshotId: "snap-1",
        sourceSandboxId: "sbx-source",
        expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      },
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

  it("stops and unregisters a restored sandbox when credential setup fails", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const restored = { sandboxId: "sbx-restore-failed", stop };
    mocks.create.mockResolvedValue(restored);
    mocks.registerSandbox.mockResolvedValue(undefined);
    mocks.configure.mockRejectedValue(new Error("credential setup failed"));
    mocks.unregisterSandbox.mockResolvedValue(true);

    await expect(restoreClarificationSandboxStep({
      snapshotId: "snap-retained",
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-successor",
      timeoutMs: 900_000,
      agents: [{ kind: "codex", model: "gpt-5-codex" }],
      arthurTaskId: null,
    })).rejects.toThrow("credential setup failed");
    expect(stop).toHaveBeenCalledWith({ blocking: true });
    expect(mocks.unregisterSandbox).toHaveBeenCalledWith(
      "ticket:jira:AIW-96",
      "owner-successor",
      "sbx-restore-failed",
    );
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
        clarificationId: "clar-1",
        sandboxId: "sbx-source",
        snapshotRequestedAt: "2026-07-17T00:00:00.000Z",
        timeoutMs: 10_000,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ snapshotId: "snap-durable" });
  });

  it("persists a created snapshot before source-stop polling can fail", async () => {
    const events: string[] = [];
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    });
    const snapshot = vi.fn().mockResolvedValue({
      snapshotId: "snap-before-poll",
      sourceSandboxId: "sbx-source",
      expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      status: "created",
    });
    mocks.recordSnapshot.mockImplementation(async () => {
      events.push("record");
    });
    mocks.get
      .mockResolvedValueOnce({ runCommand, snapshot })
      .mockImplementationOnce(async () => {
        events.push("poll");
        throw new Error("source lookup unavailable");
      });

    await expect(snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      clarificationId: "clar-before-poll",
      sandboxId: "sbx-source",
      snapshotRequestedAt: "2026-07-17T00:00:00.000Z",
      timeoutMs: 10_000,
      pollIntervalMs: 0,
    })).rejects.toThrow("source lookup unavailable");

    expect(mocks.recordSnapshot).toHaveBeenCalledWith(
      "db-sentinel",
      "clar-before-poll",
      {
        snapshotId: "snap-before-poll",
        sourceSandboxId: "sbx-source",
        expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      },
    );
    expect(events).toEqual(["record", "poll"]);
    expect(mocks.completeCheckpoint).not.toHaveBeenCalled();
  });

  it("treats an already absent snapshot as successful idempotent cleanup", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.snapshotGet.mockResolvedValueOnce({ delete: remove });
    await expect(deleteClarificationSnapshotStep("snap-1")).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();

    mocks.snapshotGet.mockRejectedValueOnce(new Error("404 not found"));
    await expect(deleteClarificationSnapshotStep("snap-expired")).resolves.toBeUndefined();
  });

  it("ignores an older same-source snapshot and recovers only the current attempt", async () => {
    const requestedAt = new Date("2026-07-17T00:00:00.000Z");
    mocks.snapshotList.mockResolvedValue({
      json: { snapshots: [
        {
          id: "snap-stale",
          sourceSandboxId: "sbx-source",
          status: "created",
          createdAt: requestedAt.getTime() - 5 * 60_000 - 1,
          expiresAt: new Date("2099-01-01T00:00:00.000Z").getTime(),
        },
        {
          id: "snap-recovered",
          sourceSandboxId: "sbx-source",
          status: "created",
          createdAt: requestedAt.getTime() + 1,
          expiresAt: new Date("2099-01-01T00:00:00.000Z").getTime(),
        },
      ], pagination: { count: 2, next: null, prev: null } },
    });
    mocks.get.mockResolvedValue({ status: "stopped" });

    await expect(
      snapshotClarificationSandboxStep({
        subjectKey: "ticket:jira:AIW-96",
        ownerToken: "owner-parked",
        clarificationId: "clar-1",
        sandboxId: "sbx-source",
        snapshotRequestedAt: requestedAt.toISOString(),
        timeoutMs: 10_000,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ snapshotId: "snap-recovered" });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.completeCheckpoint).toHaveBeenCalledWith(
      "db-sentinel",
      "clar-1",
      expect.objectContaining({ snapshotId: "snap-recovered" }),
    );
  });

  it("scans subsequent snapshot pages within the persisted attempt boundary", async () => {
    const requestedAt = new Date("2026-07-17T00:00:00.000Z");
    mocks.snapshotList
      .mockResolvedValueOnce({
        json: {
          snapshots: [{
            id: "snap-noise",
            sourceSandboxId: "another-sandbox",
            status: "created",
            createdAt: requestedAt.getTime() + 20,
            expiresAt: new Date("2099-01-01T00:00:00.000Z").getTime(),
          }],
          pagination: { count: 1, next: requestedAt.getTime() + 10, prev: null },
        },
      })
      .mockResolvedValueOnce({
        json: {
          snapshots: [{
            id: "snap-page-2",
            sourceSandboxId: "sbx-source",
            status: "created",
            createdAt: requestedAt.getTime() + 1,
            expiresAt: new Date("2099-01-01T00:00:00.000Z").getTime(),
          }],
          pagination: { count: 1, next: null, prev: requestedAt.getTime() + 10 },
        },
      });
    mocks.get.mockResolvedValue({ status: "stopped" });

    await expect(snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      clarificationId: "clar-paged",
      sandboxId: "sbx-source",
      snapshotRequestedAt: requestedAt.toISOString(),
      timeoutMs: 10_000,
      pollIntervalMs: 0,
    })).resolves.toMatchObject({ snapshotId: "snap-page-2" });
    expect(mocks.snapshotList).toHaveBeenNthCalledWith(2, expect.objectContaining({
      since: new Date(requestedAt.getTime() - 5 * 60_000),
      until: requestedAt.getTime() + 10,
    }));
  });

  it("recovers the exact source snapshot despite small worker/API clock skew", async () => {
    const requestedAt = new Date("2026-07-17T00:00:00.000Z");
    mocks.snapshotList.mockResolvedValue({
      json: {
        snapshots: [{
          id: "snap-skewed",
          sourceSandboxId: "sbx-source",
          status: "created",
          createdAt: requestedAt.getTime() - 1_000,
          expiresAt: new Date("2099-01-01T00:00:00.000Z").getTime(),
        }],
        pagination: { count: 1, next: null, prev: null },
      },
    });
    mocks.get.mockResolvedValue({ status: "stopped" });

    await expect(snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      clarificationId: "clar-clock-skew",
      sandboxId: "sbx-source",
      snapshotRequestedAt: requestedAt.toISOString(),
      timeoutMs: 10_000,
      pollIntervalMs: 0,
    })).resolves.toMatchObject({ snapshotId: "snap-skewed" });
  });

  it("fails safely when snapshot pagination repeats a cursor", async () => {
    const requestedAt = new Date("2026-07-17T00:00:00.000Z");
    mocks.snapshotList.mockResolvedValue({
      json: {
        snapshots: [],
        pagination: { count: 0, next: requestedAt.getTime() + 1, prev: null },
      },
    });

    await expect(snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      clarificationId: "clar-repeated-cursor",
      sandboxId: "sbx-source",
      snapshotRequestedAt: requestedAt.toISOString(),
      timeoutMs: 10_000,
      pollIntervalMs: 0,
    })).rejects.toThrow("repeated pagination cursor");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("aborts snapshot listing when it consumes the active-duration budget", async () => {
    mocks.snapshotList.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );

    await expect(snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      clarificationId: "clar-list-timeout",
      sandboxId: "sbx-source",
      snapshotRequestedAt: "2026-07-17T00:00:00.000Z",
      timeoutMs: 5,
      pollIntervalMs: 0,
    })).rejects.toThrow("snapshot listing exceeded the active-duration budget");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("bounds source-stop polling by the supplied active-duration budget", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    });
    const snapshot = vi.fn().mockResolvedValue({
      snapshotId: "snap-timeout",
      sourceSandboxId: "sbx-source",
      expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      status: "created",
    });
    mocks.get.mockResolvedValue({ status: "snapshotting", runCommand, snapshot });

    await expect(snapshotClarificationSandboxStep({
      subjectKey: "ticket:jira:AIW-96",
      ownerToken: "owner-parked",
      clarificationId: "clar-timeout",
      sandboxId: "sbx-source",
      snapshotRequestedAt: "2026-07-17T00:00:00.000Z",
      timeoutMs: 0,
      pollIntervalMs: 0,
    })).rejects.toThrow("active-duration budget");
    expect(mocks.completeCheckpoint).not.toHaveBeenCalled();
  });
});
