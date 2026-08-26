import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPrePrCheckConfigStep: vi.fn(),
  runPrePrChecksWithFixes: vi.fn(),
  resolvePhaseStall: vi.fn(),
  listWorkspaceRepositoriesStep: vi.fn(),
  startRepoCheckBatchStep: vi.fn(),
  collectRepoCheckBatchStep: vi.fn(),
  pollPhaseUntilDone: vi.fn(),
  recordSuccessfulWorkspaceGate: vi.fn(),
}));

vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
// Neither path is a step any more: both launch their checks detached and poll
// them across ticks, so the block is exercised against the steps it drives.
// Only the steps are replaced: the bounding, the derived cap and the stall
// sentence stay real, because those are what this block is now made of.
vi.mock("../../pre-pr-checks/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pre-pr-checks/runner.js")>()),
  listWorkspaceRepositoriesStep: mocks.listWorkspaceRepositoriesStep,
  startRepoCheckBatchStep: mocks.startRepoCheckBatchStep,
  collectRepoCheckBatchStep: mocks.collectRepoCheckBatchStep,
}));
// importOriginal, so PHASE_POLL_TICK_MAX_MS stays the real constant: the tick
// budget the block derives from it is part of what these tests assert.
vi.mock("./poll-phase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./poll-phase.js")>()),
  pollPhaseUntilDone: mocks.pollPhaseUntilDone,
}));
vi.mock("./pre-pr-checks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pre-pr-checks.js")>()),
  loadPrePrCheckConfigStep: mocks.loadPrePrCheckConfigStep,
  runPrePrChecksWithFixes: mocks.runPrePrChecksWithFixes,
  resolvePhaseStall: mocks.resolvePhaseStall,
}));
// Isolate the gate-emission behavior from real sandbox inspection: keep the
// invalidate mutator faithful (nulls the heap gate) and stub the recorder.
vi.mock("../workspace-gate.js", () => ({
  invalidateWorkspaceGate: (state: { prePrGate: unknown }) => {
    state.prePrGate = null;
  },
  recordSuccessfulWorkspaceGate: mocks.recordSuccessfulWorkspaceGate,
}));

import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import { execute, paramsSchema } from "./run-checks.js";
import { makeCtx, makeNode, runControlErrorCases } from "./test-support.js";

const trustedManifest: WorkspaceManifest = {
  version: 1,
  repositories: [{
    provider: "github",
    repoPath: "acme/api",
    slug: "acme__api",
    localPath: "/vercel/sandbox",
    defaultBranch: "main",
    branchName: "blazebot/awt-1",
    selectedRationale: "selected",
    expectedRemoteSha: "before",
    preAgentSha: "before",
  }],
};

describe("run_checks paramsSchema", () => {
  it("accepts empty params, commands, or a required skip reason", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ commands: ["pnpm lint"] }).success).toBe(true);
    expect(paramsSchema.safeParse({ skipReason: "Not applicable to docs-only work." }).success)
      .toBe(true);
    expect(paramsSchema.safeParse({ commands: [""] }).success).toBe(false);
    expect(paramsSchema.safeParse({ skipReason: " " }).success).toBe(false);
    expect(
      paramsSchema.safeParse({
        commands: ["pnpm lint"],
        skipReason: "Do not run",
      }).success,
    ).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("accepts named groups and refuses to combine them with another mode", () => {
    expect(paramsSchema.safeParse({ groups: ["test"] }).success).toBe(true);
    expect(paramsSchema.safeParse({ groups: ["test", "lint"] }).success).toBe(true);
    // Group names follow the shape the scripts configuration stores, so a name
    // this block accepts can actually match a configured group.
    expect(paramsSchema.safeParse({ groups: ["Test"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ groups: [] }).success).toBe(false);
    // Explicit commands and configured groups are different modes, not two
    // halves of one: accepting both would leave the block silently picking.
    expect(
      paramsSchema.safeParse({ groups: ["test"], commands: ["pnpm lint"] }).success,
    ).toBe(false);
    expect(
      paramsSchema.safeParse({ groups: ["test"], skipReason: "Not applicable." }).success,
    ).toBe(false);
  });
});

/** What the collect step returns, with the fields this block never sets. */
function collected(
  overrides: Partial<{
    results: Array<{ provider: string; repoPath: string; command: string; exitCode: number }>;
    failures: Array<{
      provider: string;
      repoPath: string;
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
    progress: { completed: number; total: number; stoppedAt: string | null };
  }> = {},
) {
  const results = overrides.results ?? [];
  return {
    results,
    failures: overrides.failures ?? [],
    setupFailed: false,
    progress: overrides.progress ?? {
      completed: results.length,
      total: results.length,
      stoppedAt: null,
    },
  };
}

/** A poll that records what it consumed before returning, as the real one does. */
function pollEnds(reason: string, elapsedMs: number) {
  return async (...args: unknown[]) => {
    const tuning = args[6] as { outcome?: Record<string, unknown> } | undefined;
    if (tuning?.outcome) Object.assign(tuning.outcome, { reason, elapsedMs, ticks: 12 });
    return reason === "finished";
  };
}

describe("run_checks execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("finished", 30_000));
    mocks.resolvePhaseStall.mockResolvedValue("none");
    mocks.listWorkspaceRepositoriesStep.mockResolvedValue([
      { provider: "github", repoPath: "acme/api" },
    ]);
    mocks.startRepoCheckBatchStep.mockImplementation(async (...args: unknown[]) => ({
      skipped: false,
      commandId: `cmd-${args[6]}`,
      localPath: "/vercel/sandbox",
      paths: {
        launchId: `launch${args[6]}`,
        dir: `/tmp/batch-${args[6]}`,
        wrapper: `/tmp/batch-${args[6]}-wrapper.sh`,
        sentinel: `/tmp/batch-${args[6]}-done`,
      },
    }));
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
  });

  it("fails when no workspace is attached", async () => {
    const result = await execute(makeNode("run_checks"), {}, makeCtx({ sandboxId: null }));
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toContain("no workspace");
  });

  it("returns a typed intentional skip without requiring a workspace", async () => {
    const result = await execute(
      makeNode("run_checks", { skipReason: "No executable code changed." }),
      {},
      makeCtx({ sandboxId: null }),
    );

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        ok: true,
        outcome: "skipped",
        skipReason: "No executable code changed.",
        results: [],
        failures: [],
      },
    });
  });

  it("returns kind next with ok false when explicit commands fail", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue({
      results: [
        { provider: "github", repoPath: "acme/api", command: "pnpm lint", exitCode: 0 },
        { provider: "github", repoPath: "acme/api", command: "pnpm test", exitCode: 2 },
      ],
      failures: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "pnpm test",
          exitCode: 2,
          stdout: "boom output",
          stderr: "boom error",
        },
      ],
      setupFailed: false,
    });

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint", "pnpm test"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!).toEqual({
      status: "ok",
      ok: false,
      outcome: "failed",
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
      gate: null,
    });
  });

  it("returns ok true when every command passes", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [
          { provider: "github", repoPath: "acme/api", command: "pnpm lint", exitCode: 0 },
        ],
      }),
    );

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(true);
    expect(result.output!.outcome).toBe("passed");
    expect(result.output!.failures).toEqual([]);
  });

  it("runs explicit commands in every repository, with no setup and no change filter", async () => {
    // This mode's contract: one flat command list, every attached repository,
    // changed or not, and no provisioning phase of its own.
    mocks.listWorkspaceRepositoriesStep.mockResolvedValue([
      { provider: "github", repoPath: "acme/api" },
      { provider: "github", repoPath: "acme/web" },
    ]);
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        collected({
          results: [
            { provider: "github", repoPath: "acme/api", command: "pnpm lint", exitCode: 0 },
          ],
        }),
      )
      .mockResolvedValueOnce(
        collected({
          results: [
            { provider: "github", repoPath: "acme/web", command: "pnpm lint", exitCode: 0 },
          ],
        }),
      );

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.results).toEqual([
      { repo: "github:acme/api", command: "pnpm lint", exitCode: 0 },
      { repo: "github:acme/web", command: "pnpm lint", exitCode: 0 },
    ]);
    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledTimes(2);
    for (const call of mocks.startRepoCheckBatchStep.mock.calls) {
      expect(call[3]).toEqual([]);
      expect(call[7]).toBe(false);
    }
  });

  it("keeps the sentence explaining a failure out of the truncated payload", async () => {
    // A check that exits 0 because it never ran is reported as a failure, and
    // the only thing saying why is the note. This block's failure shape has one
    // `output` string, so the note is appended after the bound: folded in
    // before it, it would sit at the join between the two streams, which is
    // exactly the middle a head-and-tail bound deletes.
    mocks.collectRepoCheckBatchStep.mockResolvedValue({
      results: [{ provider: "github", repoPath: "acme/api", command: "yarn test", exitCode: 0 }],
      failures: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "yarn test",
          exitCode: 0,
          stdout: `HEAD${"y".repeat(40_000)}TAIL`,
          stderr: "",
          note: "Pre-PR check exited 0 but its dependencies are not installed.",
        },
      ],
      setupFailed: false,
    });

    const result = await execute(
      makeNode("run_checks", { commands: ["yarn test"] }),
      {},
      makeCtx(),
    );

    const { failures } = result.output! as unknown as {
      failures: Array<{ output: string }>;
    };
    const output = failures[0]!.output;
    expect(output).toContain("dependencies are not installed");
    expect(output).toContain("HEAD");
    expect(output).toContain("TAIL");
  });

  it("fails the block when an explicit batch stalls, never reporting a partial pass", async () => {
    mocks.listWorkspaceRepositoriesStep.mockResolvedValue([
      { provider: "github", repoPath: "acme/api" },
      { provider: "github", repoPath: "acme/web" },
    ]);
    // The first repository finishes; the second never reports.
    mocks.pollPhaseUntilDone
      .mockImplementationOnce(pollEnds("finished", 30_000))
      .mockImplementation(pollEnds("duration_cap", 1_500_000));
    mocks.resolvePhaseStall.mockResolvedValue("timed_out");
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        collected({
          results: [
            { provider: "github", repoPath: "acme/api", command: "pnpm lint", exitCode: 0 },
          ],
        }),
      )
      .mockResolvedValueOnce(
        collected({ progress: { completed: 0, total: 2, stoppedAt: "pnpm lint" } }),
      );

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint", "pnpm test"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(false);
    expect(result.output!.outcome).toBe("failed");
    const failures = result.output!.failures as Array<Record<string, unknown>>;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      repo: "github:acme/web",
      command: "pnpm lint",
      exitCode: -1,
    });
    // The same rule as the configured path: a stall is never a pass, and the
    // sentence says where the batch actually got to.
    expect(failures[0]!.output).toContain("ran for 25 minutes without finishing");
    expect(failures[0]!.output).toContain("0 of 2 script commands had finished");
    expect(failures[0]!.output).toContain("this is a timeout");
    // The finished repository's commands are still reported, but they never
    // become a pass, and the stalled batch is read back as abandoned.
    expect(result.output!.results).toEqual([
      { repo: "github:acme/api", command: "pnpm lint", exitCode: 0 },
    ]);
    expect(mocks.collectRepoCheckBatchStep).toHaveBeenCalledTimes(2);
    expect(mocks.collectRepoCheckBatchStep.mock.calls[1]![7]).toBe(false);
  });

  it("fails an explicit run whose ceiling was already spent, never reporting a pass", async () => {
    // The flag existed and this path never read it, so a run that verified
    // absolutely nothing returned outcome "passed" with ok true and an empty
    // results array. The configured path has refused this from the start.
    mocks.listWorkspaceRepositoriesStep.mockResolvedValue([
      { provider: "github", repoPath: "acme/api" },
      { provider: "github", repoPath: "acme/web" },
    ]);
    const ctx = makeCtx({
      // The whole 60 minute ceiling is gone before the first batch is asked
      // for, which is exactly what an earlier repository's slow suite does.
      observeBudget: vi.fn().mockResolvedValue({
        check: { status: "ok" },
        remainingDurationMs: 1_800_000,
        checksElapsedMs: 3_600_000,
      }),
    });

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      ctx,
    );

    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(false);
    expect(result.output!.outcome).toBe("failed");
    expect(result.output!.results).toEqual([]);
    const failures = result.output!.failures as Array<Record<string, unknown>>;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      repo: "github:acme/api",
      command: "(checks budget)",
      exitCode: -1,
    });
    // The same sentence the configured path produces, naming every repository
    // the exhausted ceiling cost and the knob that buys more.
    expect(failures[0]!.output).toContain("github:acme/api, github:acme/web");
    expect(failures[0]!.output).toContain("60 minute checks budget");
    expect(failures[0]!.output).toContain("batchTimeoutMinutes");
    // Nothing was launched, which is the point.
    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("bounds an explicit batch by the checks ceiling, not by the run's duration", async () => {
    await execute(makeNode("run_checks", { commands: ["pnpm lint"] }), {}, makeCtx());

    // makeCtx observes 30 minutes of run budget remaining, and it no longer
    // decides anything here: this mode also runs commands in the workspace, so
    // its time is checks time and is charged to the checks ceiling.
    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as {
      phaseLimitMs?: number;
      ignoreRemainingDuration?: boolean;
    };
    expect(tuning.phaseLimitMs).toBe(60 * 60_000);
    expect(tuning.ignoreRemainingDuration).toBe(true);
  });

  it("takes the checks ceiling from the prepare_workspace step output when there is one", async () => {
    await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      { prepare: { output: { status: "ok", checksCeilingMs: 420_000 } } },
      makeCtx(),
    );

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as {
      phaseLimitMs?: number;
    };
    expect(tuning.phaseLimitMs).toBe(420_000);
  });

  it("falls back to the default ceiling when the prepare output predates the field", async () => {
    // A run started on a deployment that published no ceiling resumes into
    // this code. It must bound its batch, not throw and not run unbounded.
    await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      { prepare: { output: { status: "ok", sandboxId: "sbx-1" } } },
      makeCtx(),
    );

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as {
      phaseLimitMs?: number;
    };
    expect(tuning.phaseLimitMs).toBe(60 * 60_000);
  });

  it("bounds a failure's output instead of cutting its head off", async () => {
    // The block's output field is read in the dashboard and fed to later
    // prompts, so it stays small; but a head slice of a long log lands in the
    // middle of it, showing neither the first error nor the verdict.
    const long = `FIRST_ERROR${"x".repeat(9_000)}LAST_ERROR`;
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [
          { provider: "github", repoPath: "acme/api", command: "pnpm test", exitCode: 1 },
        ],
        failures: [{
          provider: "github",
          repoPath: "acme/api",
          command: "pnpm test",
          exitCode: 1,
          stdout: "",
          stderr: long,
        }],
      }),
    );

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm test"] }),
      {},
      makeCtx(),
    );

    const output = (result.output!.failures as Array<{ output: string }>)[0]!.output;
    expect(output.startsWith("FIRST_ERROR")).toBe(true);
    expect(output.endsWith("LAST_ERROR")).toBe(true);
    expect(output).toContain("characters omitted");
    expect(output.length).toBe(2_000);
  });

  it("rethrows a budget stop raised while an explicit batch is polled, naming its progress", async () => {
    // The old wall-clock AbortSignal is gone. The bound is now the budget
    // observer that pollPhaseUntilDone re-reads on every tick, and its stop
    // must terminate the run rather than become a block failure edge. The
    // batch's files are still read first: a run that ends here otherwise
    // reports nothing at all about how far its checks got.
    const failure = {
      status: "budget_exceeded" as const,
      metric: "duration" as const,
      limit: 100,
      consumed: 100,
      reason: "budget_exceeded: duration 100 reached limit 100 while command is active",
    };
    mocks.pollPhaseUntilDone.mockRejectedValue(
      Object.assign(new Error(failure.reason), { name: "RunBudgetError", failure }),
    );
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ progress: { completed: 1, total: 2, stoppedAt: "pnpm test" } }),
    );

    await expect(
      execute(
        makeNode("run_checks", { commands: ["pnpm lint", "pnpm test"] }),
        {},
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: {
        status: "budget_exceeded",
        metric: "duration",
        reason: expect.stringContaining(
          "while running `pnpm test`; 1 of 2 script commands had finished",
        ),
      },
    });

    expect(mocks.collectRepoCheckBatchStep).toHaveBeenCalledTimes(1);
    expect(mocks.collectRepoCheckBatchStep.mock.calls[0]![7]).toBe(false);
  });

  it("runs the pre-PR-checks config report-only when no commands are set", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 3,
      config: { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["pnpm lint"] }] },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "failed",
      passed: false,
      fixCycles: 0,
      results: [
        {
          provider: "github",
          repoPath: "acme/api",
          command: "pnpm lint",
          exitCode: 1,
        },
      ],
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
      expect.objectContaining({
        sandboxId: "sbx-1",
        config: {
          repositories: [{ provider: "github", repoPath: "acme/api", commands: ["pnpm lint"] }],
        },
        agentKind: "claude",
        model: "claude-model",
        observeBudget: expect.any(Function),
      }),
    );
    // No group selection at all, which the engine reads as the gate's own:
    // the groups the configuration marks as gating, which is what this block
    // ran before named groups existed.
    expect(
      mocks.runPrePrChecksWithFixes.mock.calls[0]?.[0],
    ).not.toHaveProperty("groupSelection");
    // maxFixCycles is gone from the call, not merely set to zero: the repair
    // loop it bounded no longer exists.
    expect(mocks.runPrePrChecksWithFixes.mock.calls[0]?.[0]).not.toHaveProperty(
      "maxFixCycles",
    );
    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(false);
    expect(result.output!.outcome).toBe("failed");
    expect(result.output!.results).toEqual([
      { repo: "github:acme/api", command: "pnpm lint", exitCode: 1 },
    ]);
    expect(result.output!.failures).toEqual([
      { repo: "github:acme/api", command: "pnpm lint", exitCode: 1, output: "lint output" },
    ]);
  });

  it("durably emits the recorded gate in its passed configured output", async () => {
    const gate = { configurationVersion: 5, fingerprint: "fp-run-checks" };
    mocks.recordSuccessfulWorkspaceGate.mockResolvedValue(gate);
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 5,
      config: { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["pnpm lint"] }] },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "passed",
      passed: true,
      fixCycles: 0,
      results: [],
      failures: [],
      summary: "passed",
    });

    const result = await execute(
      makeNode("run_checks"),
      {},
      makeCtx({ workspaceManifest: trustedManifest }),
    );

    expect(mocks.recordSuccessfulWorkspaceGate).toHaveBeenCalledOnce();
    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(true);
    expect(result.output!.gate).toEqual(gate);
  });

  it("emits a null gate when a configured run passes but records no gate", async () => {
    // No workspace manifest -> the record branch is skipped, so no durable gate.
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 5,
      config: { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["pnpm lint"] }] },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "passed",
      passed: true,
      fixCycles: 0,
      results: [],
      failures: [],
      summary: "passed",
    });

    const result = await execute(makeNode("run_checks"), {}, makeCtx());

    expect(mocks.recordSuccessfulWorkspaceGate).not.toHaveBeenCalled();
    expect(result.output!.gate).toBeNull();
  });

  it("distinguishes missing configured checks from an intentional skip", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({ version: null, config: { repositories: [] } });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "missing_configuration",
      passed: true,
      fixCycles: 0,
      results: [],
      failures: [],
      summary: "No pre-PR checks configured.",
    });

    const result = await execute(makeNode("run_checks"), {}, makeCtx());

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        ok: true,
        outcome: "missing_configuration",
        results: [],
        failures: [],
        gate: null,
      },
    });
  });

  it("hands configured checks the run budget observer and classifies their abort", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({ version: null, config: { repositories: [] } });
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
      expect.objectContaining({
        sandboxId: "sbx-1",
        config: { repositories: [] },
        agentKind: "claude",
        model: "claude-model",
        // The wall-clock deadline is gone: pollPhaseUntilDone re-reads this
        // observer on every tick instead.
        observeBudget: expect.any(Function),
      }),
    );
  });

  it("dispatches named groups to the engine, leaving report-only semantics alone", async () => {
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 4,
      config: {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            groups: { test: { commands: ["pnpm test"] } },
          },
        ],
      },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "passed",
      passed: true,
      results: [
        { provider: "github", repoPath: "acme/api", command: "pnpm test", exitCode: 0 },
      ],
      failures: [],
      summary: "Repository scripts passed (1 command).",
    });

    const result = await execute(
      makeNode("run_checks", { groups: ["test"] }),
      {},
      makeCtx(),
    );

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      expect.objectContaining({
        groupSelection: { kind: "named", groups: ["test"] },
      }),
    );
    // Report-only stays report-only: the output contract is untouched, and a
    // named-group run still reports results and failures, nothing more.
    expect(result.kind).toBe("next");
    expect(result.output!.ok).toBe(true);
    expect(result.output!.outcome).toBe("passed");
    expect(result.output!.results).toEqual([
      { repo: "github:acme/api", command: "pnpm test", exitCode: 0 },
    ]);
  });

  it("never mints the publication gate for a named selection", async () => {
    // The gate means "everything the configuration requires before a PR has
    // passed". A node that ran only `lint` did not establish that, and a group
    // name no repository declares runs zero commands and still reports passed,
    // so minting here would hand Finalize a green gate for a workspace nothing
    // verified.
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 4,
      config: { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["x"] }] },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "passed",
      passed: true,
      results: [],
      failures: [],
      summary: "Repository scripts passed (1 command).",
    });

    const result = await execute(
      makeNode("run_checks", { groups: ["lint"] }),
      {},
      makeCtx({ workspaceManifest: trustedManifest }),
    );

    expect(mocks.recordSuccessfulWorkspaceGate).not.toHaveBeenCalled();
    expect(result.output!.gate).toBeNull();
  });

  it("still mints the gate for the default gating selection", async () => {
    // The unnamed path is unchanged: the gating selection ran, so the gate is
    // exactly what was established.
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 4,
      config: { repositories: [{ provider: "github", repoPath: "acme/api", commands: ["x"] }] },
    });
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "passed",
      passed: true,
      results: [],
      failures: [],
      summary: "Repository scripts passed (1 command).",
    });
    mocks.recordSuccessfulWorkspaceGate.mockResolvedValue({
      configurationVersion: 4,
      fingerprint: "fp",
    });

    const result = await execute(
      makeNode("run_checks"),
      {},
      makeCtx({ workspaceManifest: trustedManifest }),
    );

    expect(mocks.recordSuccessfulWorkspaceGate).toHaveBeenCalledTimes(1);
    expect(result.output!.gate).toEqual({ configurationVersion: 4, fingerprint: "fp" });
  });

  it("maps infrastructure errors to a failed result", async () => {
    mocks.listWorkspaceRepositoriesStep.mockRejectedValue(new Error("sandbox gone"));

    const result = await execute(
      makeNode("run_checks", { commands: ["pnpm lint"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") expect(result.error.detail).toBe("sandbox gone");
  });

  it.each(runControlErrorCases())("rethrows %s from checks", async (_label, error) => {
    mocks.listWorkspaceRepositoriesStep.mockRejectedValue(error);

    await expect(
      execute(
        makeNode("run_checks", { commands: ["pnpm lint"] }),
        {},
        makeCtx(),
      ),
    ).rejects.toBe(error);
  });
});
