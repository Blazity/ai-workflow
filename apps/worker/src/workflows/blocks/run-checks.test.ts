import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sandboxGet: vi.fn(),
  getDb: vi.fn(),
  getCurrentPrePrCheckConfig: vi.fn(),
  runPrePrChecksWithFixes: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../db/client.js", () => ({ getDb: mocks.getDb }));
vi.mock("../../pre-pr-checks/store.js", () => ({
  getCurrentPrePrCheckConfig: mocks.getCurrentPrePrCheckConfig,
}));
vi.mock("../../pre-pr-checks/runner.js", () => ({
  runPrePrChecksWithFixes: mocks.runPrePrChecksWithFixes,
}));

import { execute, paramsSchema } from "./run-checks.js";
import { makeCtx, makeNode } from "./test-support.js";

const manifest = JSON.stringify({
  version: 1,
  repositories: [
    {
      provider: "github",
      repoPath: "acme/api",
      slug: "api",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "blazebot/awt-1",
      selectedRationale: "selected",
    },
  ],
});

function sandboxRunningCommands(exitCodes: Record<string, number>) {
  return {
    runCommand: vi.fn(async (cmdOrSpec: unknown, args?: string[]) => {
      if (cmdOrSpec === "cat" && args) {
        return { exitCode: 0, stdout: async () => manifest, stderr: async () => "" };
      }
      const spec = cmdOrSpec as { args: string[] };
      const command = spec.args[1];
      const exitCode = exitCodes[command] ?? 0;
      return {
        exitCode,
        stdout: async () => (exitCode === 0 ? "passed" : "boom output"),
        stderr: async () => (exitCode === 0 ? "" : "boom error"),
      };
    }),
  };
}

describe("run_checks paramsSchema", () => {
  it("accepts empty params and a commands array", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ commands: ["pnpm lint"] }).success).toBe(true);
    expect(paramsSchema.safeParse({ commands: [""] }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("run_checks execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
  });

  it("fails when no workspace is attached", async () => {
    const result = await execute(makeNode("run_checks"), {}, makeCtx({ sandboxId: null }));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("no workspace");
  });

  it("returns kind next with ok false when explicit commands fail", async () => {
    mocks.sandboxGet.mockResolvedValue(
      sandboxRunningCommands({ "pnpm lint": 0, "pnpm test": 2 }),
    );

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint", "pnpm test"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output).toEqual({
      status: "ok",
      ok: false,
      results: [
        { repo: "github:acme/api", command: "pnpm lint", exitCode: 0 },
        { repo: "github:acme/api", command: "pnpm test", exitCode: 2 },
      ],
      failures: [
        {
          repo: "github:acme/api",
          command: "pnpm test",
          exitCode: 2,
          output: "boom error\nboom output",
        },
      ],
    });
  });

  it("returns ok true when every command passes", async () => {
    mocks.sandboxGet.mockResolvedValue(sandboxRunningCommands({}));

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output.ok).toBe(true);
    expect(result.output.failures).toEqual([]);
  });

  it("aborts explicit commands at the remaining duration and starts no later command", async () => {
    let startedCommands = 0;
    const runCommand = vi.fn(async (cmdOrSpec: unknown, args?: string[]) => {
      if (cmdOrSpec === "cat" && args) {
        return { exitCode: 0, stdout: async () => manifest, stderr: async () => "" };
      }
      const spec = cmdOrSpec as { signal?: AbortSignal };
      expect(spec.signal).toBeInstanceOf(AbortSignal);
      startedCommands += 1;
      throw new DOMException("duration expired", "TimeoutError");
    });
    mocks.sandboxGet.mockResolvedValue({ runCommand });
    const failure = {
      status: "budget_exceeded" as const,
      metric: "duration" as const,
      limit: 100,
      consumed: 100,
      reason: "budget_exceeded: duration 100 reached limit 100 during Run checks",
    };
    const ctx = makeCtx({
      observeBudget: vi
        .fn()
        .mockResolvedValueOnce({
          check: { status: "ok" },
          remainingDurationMs: 25,
          durationLimitMs: 100,
          activeElapsedMs: 75,
        })
        .mockResolvedValueOnce({ check: failure, remainingDurationMs: 0 }),
    });

    await expect(
      execute(
        makeNode("run_checks", { commands: ["pnpm lint", "pnpm test"] }),
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ name: "RunBudgetError", failure });

    expect(startedCommands).toBe(1);
  });

  it("runs the pre-PR-checks config report-only when no commands are set", async () => {
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 3,
      config: { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["pnpm lint"] }] },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      passed: false,
      fixCycles: 0,
      failures: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "pnpm lint",
          exitCode: 1,
          stdout: "lint output",
          stderr: "",
        },
      ],
      summary: "failed",
    });

    const result = await execute(makeNode("run_checks"), {}, makeCtx());

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      "sbx-1",
      { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["pnpm lint"] }] },
      "claude",
      "claude-model",
      0,
      1_800_000,
    );
    expect(result.kind).toBe("next");
    expect(result.output.ok).toBe(false);
    expect(result.output.failures).toEqual([
      { repo: "github:acme/api", command: "pnpm lint", exitCode: 1, output: "lint output" },
    ]);
  });

  it("passes the remaining duration to configured checks and classifies their abort", async () => {
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue(null);
    mocks.runPrePrChecksWithFixes.mockRejectedValue(
      new DOMException("duration expired", "TimeoutError"),
    );
    const failure = {
      status: "budget_exceeded" as const,
      metric: "duration" as const,
      limit: 100,
      consumed: 100,
      reason: "budget_exceeded: duration 100 reached limit 100 during Run checks",
    };
    const ctx = makeCtx({
      observeBudget: vi
        .fn()
        .mockResolvedValueOnce({
          check: { status: "ok" },
          remainingDurationMs: 25,
          durationLimitMs: 100,
          activeElapsedMs: 75,
        })
        .mockResolvedValueOnce({ check: failure, remainingDurationMs: 0 }),
    });

    await expect(execute(makeNode("run_checks"), {}, ctx)).rejects.toMatchObject({
      name: "RunBudgetError",
      failure,
    });
    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      "sbx-1",
      { repositories: [] },
      "claude",
      "claude-model",
      0,
      25,
    );
  });

  it("maps infrastructure errors to a failed result", async () => {
    mocks.sandboxGet.mockRejectedValue(new Error("sandbox gone"));

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toBe("sandbox gone");
  });
});
