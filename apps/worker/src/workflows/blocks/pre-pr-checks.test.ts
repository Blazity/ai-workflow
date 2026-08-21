import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrePrCheckConfig } from "../../pre-pr-checks/config.js";
import {
  RunBudgetError,
  createRunBudgetState,
  type RunBudgetObservation,
} from "../run-budget.js";

const mocks = vi.hoisted(() => ({
  startRepoCheckBatchStep: vi.fn(),
  collectRepoCheckBatchStep: vi.fn(),
  pollPhaseUntilDone: vi.fn(),
  checkPhaseDone: vi.fn(),
  getCurrentPrePrCheckConfig: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../pre-pr-checks/store.js", () => ({
  getCurrentPrePrCheckConfig: (...args: unknown[]) =>
    mocks.getCurrentPrePrCheckConfig(...args),
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../pre-pr-checks/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pre-pr-checks/runner.js")>()),
  startRepoCheckBatchStep: mocks.startRepoCheckBatchStep,
  collectRepoCheckBatchStep: mocks.collectRepoCheckBatchStep,
}));
// importOriginal, so PHASE_POLL_TICK_MAX_MS stays the real constant: the tick
// budget the block derives from it is part of what these tests assert.
vi.mock("./poll-phase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./poll-phase.js")>()),
  pollPhaseUntilDone: mocks.pollPhaseUntilDone,
}));
vi.mock("../../sandbox/poll-agent.js", () => ({ checkPhaseDone: mocks.checkPhaseDone }));

import {
  loadPrePrCheckConfigStep,
  runPrePrChecksWithFixes,
  runRepositorySetup,
} from "./pre-pr-checks.js";
import type { PhasePollOutcome, PhasePollTuning } from "./poll-phase.js";
import {
  createV2InvocationCancellationController,
  createV2InvocationContext,
  type V2InvocationObservationHooks,
} from "../../workflow-definition/invocation-context.js";

const config: PrePrCheckConfig = {
  repositories: [
    { provider: "github", repoPath: "acme/web", setup: ["make bootstrap"], commands: ["pnpm typecheck"] },
    { provider: "gitlab", repoPath: "acme/api", commands: ["pnpm test"] },
  ],
};

const oneRepoConfig: PrePrCheckConfig = {
  repositories: [{ provider: "github", repoPath: "acme/web", commands: ["pnpm typecheck"] }],
};

const observeBudget = vi.fn(
  async (): Promise<RunBudgetObservation> => ({
    check: { status: "ok" },
    remainingDurationMs: 1_800_000,
  }),
);

function options(overrides: Partial<Parameters<typeof runPrePrChecksWithFixes>[0]> = {}) {
  return {
    sandboxId: "sbx-test-123",
    config: oneRepoConfig,
    agentKind: "codex" as const,
    model: "gpt-5",
    observeBudget,
    ...overrides,
  };
}

function started(repoIndex: number) {
  return {
    skipped: false as const,
    commandId: `cmd-${repoIndex}`,
    localPath: "/vercel/sandbox",
    paths: {
      launchId: `launch${repoIndex}`,
      dir: `/tmp/pre-pr-checks-c0-r${repoIndex}-launch${repoIndex}`,
      wrapper: `/tmp/pre-pr-checks-c0-r${repoIndex}-launch${repoIndex}-wrapper.sh`,
      sentinel: `/tmp/pre-pr-checks-c0-r${repoIndex}-launch${repoIndex}-done`,
    },
  };
}

/**
 * A poll that ends the way the real one does: it records what it consumed into
 * the tuning it was handed before returning. Everything downstream of a stall
 * reads that record rather than a constant, so a fake that skips it would let
 * the assertions pass against numbers no poll produced.
 */
function pollEnds(reason: PhasePollOutcome["reason"], elapsedMs: number) {
  return async (...args: unknown[]) => {
    const tuning = args[6] as PhasePollTuning | undefined;
    if (tuning?.outcome) Object.assign(tuning.outcome, { reason, elapsedMs, ticks: 12 });
    return reason === "finished";
  };
}

function collected(overrides: {
  results?: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    command: string;
    exitCode: number;
    group?: string;
    durationMs?: number;
    timedOut?: boolean;
  }>;
  failures?: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    phase?: "setup" | "workspace" | "batch" | "omitted" | "env";
  }>;
  setupFailed?: boolean;
  dirtied?: string[];
  preExistingDirty?: string[];
  setupMarkerFailed?: boolean;
  progress?: { completed: number; total: number; stoppedAt: string | null };
} = {}) {
  const results = overrides.results ?? [];
  const failures = overrides.failures ?? [];
  return {
    results,
    failures,
    setupFailed: overrides.setupFailed ?? false,
    dirtied: overrides.dirtied ?? [],
    preExistingDirty: overrides.preExistingDirty ?? [],
    setupMarkerFailed: overrides.setupMarkerFailed ?? false,
    progress: overrides.progress ?? {
      completed: results.length,
      total: results.length,
      stoppedAt: null,
    },
  };
}

describe("runPrePrChecksWithFixes", () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clear leaves queued mockImplementationOnce
    // entries behind, so a test that consumes fewer of them than it queued leaks
    // the rest into whatever runs next. That made five unrelated tests fail the
    // moment the repair loop stopped running by default.
    vi.resetAllMocks();
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("finished", 30_000));
    mocks.startRepoCheckBatchStep.mockImplementation(async (
      _sandboxId: string,
      _provider: string,
      _repoPath: string,
      _setup: string[],
      _commands: string[],
      _fixCycle: number,
      repoIndex: number,
    ) => started(repoIndex));
  });

  it("reports missing configuration without launching anything", async () => {
    const result = await runPrePrChecksWithFixes(options({ config: { repositories: [] } }));

    expect(result).toMatchObject({
      outcome: "missing_configuration",
      passed: true,
      results: [],
      failures: [],
      summary: "No repository scripts configured.",
    });
    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("skips a repository the start step declined and reports no matching checks", async () => {
    mocks.startRepoCheckBatchStep.mockResolvedValue({ skipped: true });

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(true);
    expect(result.summary).toBe("No repository scripts matched changed repositories.");
    expect(mocks.collectRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("keeps a second repository running after the first one's setup fails, and starts no fix cycle", async () => {
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        collected({
          setupFailed: true,
          failures: [{
            provider: "github",
            repoPath: "acme/web",
            command: "make bootstrap",
            exitCode: 127,
            stdout: "",
            stderr: "bash: line 1: toolchain: command not found",
            phase: "setup",
          }],
        }),
      )
      .mockResolvedValueOnce(
        collected({
          results: [{ provider: "gitlab", repoPath: "acme/api", command: "pnpm test", exitCode: 0 }],
        }),
      );

    const result = await runPrePrChecksWithFixes(options({ config }));

    expect(result.setupFailed).toBe(true);
    expect(result.passed).toBe(false);
    // The second repository was still started, polled and collected.
    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([
      { provider: "gitlab", repoPath: "acme/api", command: "pnpm test", exitCode: 0 },
    ]);
    expect(result.summary).toContain("SETUP FAILED for github:acme/web");
    expect(result.summary).toContain("Fix the setup command");
  });

  it("fails the checks when the poll runs out of its cap, never passing them", async () => {
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("duration_cap", 1_500_000));
    // Not "stopped": the sandbox is alive, the sentinel simply never appeared.
    mocks.checkPhaseDone.mockResolvedValue(false);
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        progress: {
          completed: 3,
          total: 5,
          stoppedAt: "uv run pytest tests/ -m integration",
        },
      }),
    );

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(false);
    expect(result.outcome).toBe("failed");
    // The elapsed time the poll actually consumed, not the cap it was given:
    // the cap is derived from the remaining budget and the poll can end early,
    // so a fixed sentence would eventually be a false one.
    expect(result.summary).toContain("ran for 25 minutes without finishing");
    expect(result.summary).toContain(
      "while running `uv run pytest tests/ -m integration`; 3 of 5 commands had finished",
    );
    expect(result.summary).toContain("this is a timeout");
    // The abandoned batch is still read back: those files are the only record
    // of where it died. It is read as abandoned, so the commands after the one
    // that was running are not reported at all.
    expect(mocks.collectRepoCheckBatchStep).toHaveBeenCalledTimes(1);
    expect(mocks.collectRepoCheckBatchStep.mock.calls[0]![7]).toBe(false);
  });

  it("never reports a stall as an ordinary failing check", async () => {
    // A stall is not a check result: nothing was verified. Without a phase it
    // reads as an ordinary failing check, and every sentence that only makes
    // sense for a command that ran gets attached to it.
    mocks.pollPhaseUntilDone
      .mockImplementationOnce(pollEnds("finished", 30_000))
      .mockImplementation(pollEnds("duration_cap", 1_500_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        collected({
          setupFailed: true,
          failures: [{
            provider: "github",
            repoPath: "acme/web",
            command: "make bootstrap",
            exitCode: 127,
            stdout: "",
            stderr: "toolchain: command not found",
            phase: "setup",
          }],
        }),
      )
      .mockResolvedValueOnce(
        collected({ progress: { completed: 0, total: 1, stoppedAt: "pnpm test" } }),
      );

    const result = await runPrePrChecksWithFixes(options({ config }));

    const entries = result.summary.split("\n\n");
    const setupEntry = entries.find((entry) => entry.startsWith("SETUP FAILED"));
    const stallEntry = entries.find((entry) => entry.includes("this is a timeout"));
    expect(setupEntry).toBeDefined();
    expect(stallEntry).toContain("CHECK BATCH ABANDONED for gitlab:acme/api");
    // The proof the phase is doing the work: it is not headed by the bare
    // repository key an ordinary failing check gets.
    expect(stallEntry).not.toContain("Fix the setup command");
  });

  it("keeps the stall diagnosis when the abandoned batch cannot be read either", async () => {
    // The sandbox-death path collects from a sandbox already observed as not
    // running twice, and the collect step's maxRetries is 0. Letting that
    // rejection out replaces the stall sentence with an unclassified run
    // failure: neither a run-control error nor a budget error, so agent.ts
    // kills the run with no usable cause, in the exact case this mechanism was
    // written for.
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("sandbox_stopped", 120_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    mocks.collectRepoCheckBatchStep.mockRejectedValue(
      new Error("sandbox sbx-test-123 is not running"),
    );

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("sandbox stopped while");
    // No invented progress: the files were never read, so no count is claimed.
    expect(result.summary).toContain("how far it got could not be read back");
    expect(result.summary).not.toContain("0 of");
  });

  it("fails with a reason distinct from the timeout when the sandbox stopped", async () => {
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("sandbox_stopped", 120_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ progress: { completed: 1, total: 2, stoppedAt: "pnpm test" } }),
    );

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("sandbox stopped while");
    expect(result.summary).toContain("1 of 2 commands had finished");
    expect(result.summary).not.toContain("this is a timeout");
    // A lost workspace is not a verdict on the repository: nothing about it may
    // read as a passing or a failing check.
    expect(result.summary).toContain("Nothing was verified");
  });

  it("collects normally when the sentinel appears between the last tick and the check", async () => {
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("duration_cap", 1_500_000));
    mocks.checkPhaseDone.mockResolvedValue(true);
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 0 }],
      }),
    );

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(true);
    expect(result.summary).toBe("Repository scripts passed (1 command).");
    expect(mocks.collectRepoCheckBatchStep.mock.calls[0]![7]).toBe(true);
  });

  it("bounds a batch by what is left of the checks ceiling, ignoring the run's duration", async () => {
    // The run's remaining duration is deliberately tiny here and changes
    // nothing. Checks time is charged to its own ceiling, so a test suite can
    // outlive the budget that pays for the agent's work without the run
    // halting as budget_exceeded with a green check run behind it.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    observeBudget.mockResolvedValueOnce({
      check: { status: "ok" as const },
      remainingDurationMs: 60_000,
      checksElapsedMs: 900_000,
    });

    await runPrePrChecksWithFixes(options());

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    expect(tuning.phaseLimitMs).toBe(60 * 60_000 - 900_000);
    // And the poll is told not to consult the run's duration at all, so an
    // exhausted run budget cannot pre-empt the checks report.
    expect(tuning.ignoreRemainingDuration).toBe(true);
  });

  it("hands the poll the observer that charges its waiting to the checks ceiling", async () => {
    // Two observers, because the split is a boundary: everything up to the
    // launch is the run's time, everything the poll waits through is the
    // checks phase's.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    const observeChecksBudget = vi.fn(observeBudget);

    await runPrePrChecksWithFixes(options({ observeChecksBudget }));

    expect(mocks.pollPhaseUntilDone.mock.calls[0]![4]).toBe(observeChecksBudget);
  });

  it("stops launching once the ceiling is spent, and says so exactly once", async () => {
    // One paragraph for the whole slice, not one per repository: eight repos
    // each reporting the same exhausted budget is eight identical paragraphs
    // in a ticket comment nobody reads to the end.
    observeBudget.mockResolvedValue({
      check: { status: "ok" as const },
      remainingDurationMs: 1_800_000,
      checksElapsedMs: 60 * 60_000,
    });

    const result = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            { provider: "github" as const, repoPath: "acme/web", commands: ["pnpm typecheck"] },
            { provider: "github" as const, repoPath: "acme/api", commands: ["pnpm test"] },
            { provider: "gitlab" as const, repoPath: "acme/ops", commands: ["pnpm lint"] },
          ],
        },
      }),
    );

    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
    const budgetFailures = result.failures.filter((f) => f.phase === "budget");
    expect(budgetFailures).toHaveLength(1);
    expect(budgetFailures[0]!.note).toContain("60 minute checks budget");
    expect(budgetFailures[0]!.note).toContain("github:acme/web");
    expect(budgetFailures[0]!.note).toContain("github:acme/api");
    expect(budgetFailures[0]!.note).toContain("gitlab:acme/ops");
  });

  it("still accounts for every repository it never reached", async () => {
    // Breaking the walk must never break the accounting. An unreached group
    // that vanished from groupStatuses instead of landing not_run would let
    // allPassed stay true, and the gate would pass a publication on the
    // strength of checks that were never launched.
    observeBudget.mockResolvedValue({
      check: { status: "ok" as const },
      remainingDurationMs: 1_800_000,
      checksElapsedMs: 60 * 60_000,
    });

    const result = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            { provider: "github" as const, repoPath: "acme/web", commands: ["pnpm typecheck"] },
            { provider: "github" as const, repoPath: "acme/api", commands: ["pnpm test"] },
          ],
        },
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.groupStatuses).toEqual([
      { provider: "github", repoPath: "acme/web", group: "checks", status: "not_run" },
      { provider: "github", repoPath: "acme/api", group: "checks", status: "not_run" },
    ]);
  });

  it("authorizes a tick budget the configured cap can actually spend", async () => {
    // A fixed 200 ticks covers about 98 minutes at the 30s ceiling, so a
    // 180 minute cap used to end on the tick cap and report the batch as
    // unfinished, blaming it for a bound nobody could see.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    observeBudget.mockResolvedValue({
      check: { status: "ok" as const },
      remainingDurationMs: 1_800_000,
      checksElapsedMs: 0,
    });

    await runPrePrChecksWithFixes(options({ checksCeilingMs: 180 * 60_000 }));

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    expect(tuning.phaseLimitMs).toBe(180 * 60_000);
    expect(tuning.maxTicks).toBe(Math.ceil((180 * 60_000) / 30_000) + 8);
  });

  it("shares one ceiling across a run's repositories instead of giving each its own", async () => {
    // Also the resume contract: the second batch is bounded by what is LEFT,
    // never by a refreshed ceiling. The checks total lives on the run's budget
    // state and the ceiling is journaled, so a run that resumes mid-phase
    // continues spending the same minutes rather than starting them again.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    observeBudget
      .mockResolvedValueOnce({
        check: { status: "ok" as const },
        remainingDurationMs: 1_800_000,
        checksElapsedMs: 0,
      })
      .mockResolvedValueOnce({
        check: { status: "ok" as const },
        remainingDurationMs: 1_800_000,
        checksElapsedMs: 1_200_000,
      });

    await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            { provider: "github" as const, repoPath: "acme/web", commands: ["pnpm typecheck"] },
            { provider: "github" as const, repoPath: "acme/api", commands: ["pnpm typecheck"] },
          ],
        },
      }),
    );

    const first = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    const second = mocks.pollPhaseUntilDone.mock.calls[1]![6] as PhasePollTuning;
    expect(first.phaseLimitMs).toBe(60 * 60_000);
    expect(second.phaseLimitMs).toBe(60 * 60_000 - 1_200_000);
  });

  it("prefers the ceiling prepare_workspace published over the configuration's own", async () => {
    // The published number is what the sandbox lifetime was sized against, so
    // a batchTimeoutMinutes raised mid-run must not hand a batch a bound its
    // sandbox will not survive.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());

    await runPrePrChecksWithFixes(options({ checksCeilingMs: 300_000 }));

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    expect(tuning.phaseLimitMs).toBe(300_000);
  });

  it("never lets a batch outlive the documented ceiling, however long the budget", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    observeBudget.mockResolvedValueOnce({
      check: { status: "ok" as const },
      remainingDurationMs: 6_000_000,
      checksElapsedMs: 0,
    });

    await runPrePrChecksWithFixes(options());

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    expect(tuning.phaseLimitMs).toBe(60 * 60_000);
  });

  it("refuses to launch a batch on an already exhausted budget", async () => {
    // The poll would raise the same error on its first tick, but only after a
    // wrapper had been written, chmodded and started in the sandbox.
    observeBudget.mockResolvedValueOnce({
      check: {
        status: "budget_exceeded" as const,
        metric: "tokens" as const,
        limit: 10,
        consumed: 11,
        reason: "budget_exceeded: tokens 11 reached limit 10",
      },
      remainingDurationMs: 600_000,
    });

    await expect(runPrePrChecksWithFixes(options())).rejects.toMatchObject({
      name: "RunBudgetError",
    });
    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("polls with a ramp and survives a single unreachable reading", async () => {
    // checkPhaseDone reports "stopped" for any failure to reach the sandbox,
    // not only for a sandbox that is gone, and a long batch asks it dozens of
    // times. One reading may not end a check run.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());

    await runPrePrChecksWithFixes(options());

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    expect(tuning).toMatchObject({ checkBeforeFirstTick: true, stoppedObservations: 2 });
    expect(tuning.initialTickMs!).toBeLessThan(30_000);
    expect(tuning.tickGrowthFactor!).toBeGreaterThan(1);
    expect(tuning.maxTicks!).toBeGreaterThan(0);
  });


  it("separates the run's own workspace failure from a setup command that failed", async () => {
    // A vanished workspace directory is the run's own failure, not the
    // operator's configuration, so nothing about it may be reported as a setup
    // command anyone should go and edit.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "(repository workspace)",
          exitCode: -1,
          stdout: "",
          stderr: "The repository's workspace directory could not be entered.",
          phase: "workspace",
        }],
      }),
    );

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(false);
    expect(result.setupFailed).toBe(false);
    expect(result.summary).toContain("WORKSPACE UNAVAILABLE for github:acme/web");
  });

  it("runs a repository configured twice only once, on its last entry", async () => {
    // The blocking runner keyed the configuration into a Map, so a duplicate
    // only ever ran its last occurrence. Running both would double a batch
    // whose wall clock is measured in tens of minutes.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());

    await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            { provider: "github", repoPath: "acme/web", commands: ["pnpm lint"] },
            { provider: "github", repoPath: "acme/web", commands: ["pnpm typecheck"] },
          ],
        },
      }),
    );

    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledTimes(1);
    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledWith(
      "sbx-test-123",
      "github",
      "acme/web",
      [],
      ["pnpm typecheck"],
      0,
      0,
      // A gate selection keeps the unchanged-repository filter.
      true,
      { restoreTree: true },
    );
  });

});

describe("loadPrePrCheckConfigStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the stored version out with the configuration it loaded", async () => {
    // The version is what records the workspace gate, so it has to travel from
    // this step to the gate write. It used to leave with the checks result;
    // the checks are no longer a step, so it leaves with the config instead.
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 7,
      config: { repositories: [] },
    });

    await expect(loadPrePrCheckConfigStep()).resolves.toEqual({
      version: 7,
      config: { repositories: [] },
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { version: 7 },
      "pre_pr_checks_config_version",
    );
  });

  it("falls back to the empty configuration when nothing is stored", async () => {
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue(undefined);

    await expect(loadPrePrCheckConfigStep()).resolves.toEqual({
      version: null,
      config: { repositories: [] },
    });
  });
});

// ---------------------------------------------------------------------------
// Repository scripts: named groups, group selection, forwarded environment and
// the typed per-group verdict the gate and the block picker build on.
// ---------------------------------------------------------------------------

/** Two groups on one repository, the shape stage 3's group picker selects from. */
const groupedConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        lint: { commands: ["pnpm lint"] },
        test: { commands: ["pnpm test"] },
      },
    },
  ],
};

function result(command: string, exitCode = 0) {
  return { provider: "github" as const, repoPath: "acme/web", command, exitCode };
}

function status(group: string, groupStatus: string) {
  return { provider: "github", repoPath: "acme/web", group, status: groupStatus };
}

describe("runPrePrChecksWithFixes, repository scripts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pollPhaseUntilDone.mockImplementation(pollEnds("finished", 30_000));
    mocks.startRepoCheckBatchStep.mockImplementation(async (
      _sandboxId: string,
      _provider: string,
      _repoPath: string,
      _setup: string[],
      _commands: string[],
      _fixCycle: number,
      repoIndex: number,
    ) => started(repoIndex));
  });

  it("runs a legacy flat command list as the checks group", async () => {
    // Every configuration stored before repository scripts existed looks like
    // this, and it must keep working end to end without a migration.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm typecheck")] }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            { provider: "github", repoPath: "acme/web", commands: ["pnpm typecheck"] },
          ],
        },
      }),
    );

    expect(run.passed).toBe(true);
    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![4]).toEqual(["pnpm typecheck"]);
    expect(run.groupStatuses).toEqual([status("checks", "passed")]);
    expect(run.summary).toBe("Repository scripts passed (1 command).");
  });

  it("runs only the groups a named selection asked for and skips the rest", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm test")] }),
    );

    const run = await runPrePrChecksWithFixes(
      options({ config: groupedConfig, groupSelection: { kind: "named", groups: ["test"] } }),
    );

    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![4]).toEqual(["pnpm test"]);
    expect(run.groupStatuses).toEqual([status("lint", "skipped"), status("test", "passed")]);
  });

  it("starts nothing for a repository that has none of the requested groups", async () => {
    const run = await runPrePrChecksWithFixes(
      options({ config: groupedConfig, groupSelection: { kind: "named", groups: ["docs"] } }),
    );

    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
    expect(run.groupStatuses).toEqual([status("lint", "skipped"), status("test", "skipped")]);
    expect(run.passed).toBe(true);
    // Not the gate's sentence. A named selection runs whether or not the
    // repository changed, so telling its operator that nothing "matched
    // changed repositories" would name a filter that was never applied.
    expect(run.summary).toBe("No repository scripts matched the selected groups.");
  });

  it("keeps the gate's own sentence when the gate is what selected nothing", async () => {
    mocks.startRepoCheckBatchStep.mockResolvedValue({ skipped: true });

    const run = await runPrePrChecksWithFixes(options({ config: groupedConfig }));

    expect(run.summary).toBe("No repository scripts matched changed repositories.");
  });

  it("asks the batch to filter on change for a gate and not for a named selection", async () => {
    // requireChange is the gate's filter: run only where the branch touched
    // something. A node that asked for `lint` by name asked for it outright,
    // and silently dropping it because the repository is unchanged would turn
    // an explicit instruction into a no-op the author cannot see.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm lint"), result("pnpm test")] }),
    );

    await runPrePrChecksWithFixes(options({ config: groupedConfig }));
    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![7]).toBe(true);

    mocks.startRepoCheckBatchStep.mockClear();
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm test")] }),
    );

    await runPrePrChecksWithFixes(
      options({ config: groupedConfig, groupSelection: { kind: "named", groups: ["test"] } }),
    );
    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![7]).toBe(false);
  });

  it("runs the gate groups the configuration names, not every group", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm test")] }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [{ ...groupedConfig.repositories[0], gateGroups: ["test"] }],
        },
      }),
    );

    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![4]).toEqual(["pnpm test"]);
    expect(run.groupStatuses).toEqual([status("lint", "skipped"), status("test", "passed")]);
  });

  it("expands extends once and gives a shared command to the first group that asked", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm install"), result("pnpm lint"), result("pnpm test")] }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: {
                deps: { commands: ["pnpm install"] },
                lint: { extends: ["deps"], commands: ["pnpm lint"] },
                test: { extends: ["deps"], commands: ["pnpm test"] },
              },
            },
          ],
        },
        groupSelection: { kind: "named", groups: ["lint", "test"] },
      }),
    );

    // `pnpm install` runs once, not twice, and belongs to lint: it ran there.
    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![4]).toEqual([
      "pnpm install",
      "pnpm lint",
      "pnpm test",
    ]);
    expect(run.groupStatuses).toEqual([
      status("deps", "skipped"),
      status("lint", "passed"),
      status("test", "passed"),
    ]);
  });

  it("fails every group that depends on a failed shared command, not just the one it ran under", async () => {
    // The bug this closes. `pnpm install` is deduplicated into a single run,
    // attributed to whichever group got there first, so a naive per-group
    // verdict reads the failure under `lint` and reports `test` as passed.
    // Nothing verified `test`. Its dependency never even finished.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [result("pnpm install", 1)],
        failures: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm install",
            exitCode: 1,
            stdout: "",
            stderr: "lockfile out of date",
          },
        ],
        progress: { completed: 1, total: 3, stoppedAt: "pnpm install" },
      }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: {
                deps: { commands: ["pnpm install"] },
                lint: { extends: ["deps"], commands: ["pnpm lint"] },
                test: { extends: ["deps"], commands: ["pnpm test"] },
              },
            },
          ],
        },
        groupSelection: { kind: "named", groups: ["lint", "test"] },
      }),
    );

    expect(run.groupStatuses).toEqual([
      status("deps", "skipped"),
      status("lint", "failed"),
      status("test", "failed"),
    ]);
  });

  it("shares a verbatim duplicate command's verdict with every group that declared it", async () => {
    // The same trap without `extends`: two groups happen to name the identical
    // command. Deduplication runs it once, and both groups own the result.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [result("pnpm build", 1), result("pnpm lint"), result("pnpm test")],
        failures: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm build",
            exitCode: 1,
            stdout: "",
            stderr: "build failed",
          },
        ],
      }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: {
                lint: { commands: ["pnpm build", "pnpm lint"] },
                test: { commands: ["pnpm build", "pnpm test"] },
              },
            },
          ],
        },
        groupSelection: { kind: "named", groups: ["lint", "test"] },
      }),
    );

    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![4]).toEqual([
      "pnpm build",
      "pnpm lint",
      "pnpm test",
    ]);
    expect(run.groupStatuses).toEqual([status("lint", "failed"), status("test", "failed")]);
  });

  it("calls a group that both failed and timed out failed", async () => {
    // A timeout is "we do not know"; a failure is "we know, and it is bad".
    // Reporting the group as timed_out would let a real, observed failure be
    // presented as an inconclusive run and retried instead of fixed.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [
          result("pnpm unit", 1),
          { ...result("pnpm e2e", 124), timedOut: true },
        ],
        failures: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm unit",
            exitCode: 1,
            stdout: "",
            stderr: "2 tests failed",
          },
        ],
      }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: { test: { commands: ["pnpm unit", "pnpm e2e"] } },
            },
          ],
        },
        groupSelection: { kind: "named", groups: ["test"] },
      }),
    );

    expect(run.groupStatuses).toEqual([status("test", "failed")]);
  });

  it("fails the run loudly when the stored configuration cannot be read", async () => {
    // A configuration that does not parse must not be silently treated as no
    // configuration: that reads as a pass, and the gate then records a green
    // verdict for a repository nothing verified.
    const run = await runPrePrChecksWithFixes(
      options({ config: { repositories: [{ provider: "github", repoPath: "acme/web" }] } }),
    );

    expect(run.passed).toBe(false);
    expect(run.outcome).toBe("failed");
    expect(run.summary).toContain("repositories");
    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("marks every group not_run when the repository's environment was refused", async () => {
    mocks.startRepoCheckBatchStep.mockResolvedValue({
      skipped: false,
      envFailure: {
        provider: "github",
        repoPath: "acme/web",
        command: "(repository environment)",
        exitCode: -1,
        stdout: "",
        stderr: "ARTHUR_TOKEN is not in PRE_PR_CHECKS_ALLOWED_ENV.",
        phase: "env",
      },
    });

    const run = await runPrePrChecksWithFixes(options({ config: groupedConfig }));

    expect(run.passed).toBe(false);
    expect(run.failures[0]).toMatchObject({ phase: "env" });
    expect(run.groupStatuses).toEqual([status("lint", "not_run"), status("test", "not_run")]);
    expect(mocks.collectRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("separates a failing group from a timed out one", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [
          { ...result("pnpm lint", 1) },
          { ...result("pnpm test", 124), timedOut: true },
        ],
        failures: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm lint",
            exitCode: 1,
            stdout: "",
            stderr: "lint failed",
          },
        ],
      }),
    );

    const run = await runPrePrChecksWithFixes(options({ config: groupedConfig }));

    expect(run.groupStatuses).toEqual([status("lint", "failed"), status("test", "timed_out")]);
  });

  it("surfaces the tracked files a repository's commands left behind", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [result("pnpm lint"), result("pnpm test")],
        dirtied: ["src/generated.ts"],
      }),
    );

    const run = await runPrePrChecksWithFixes(options({ config: groupedConfig }));

    expect(run.dirtied).toEqual([
      {
        provider: "github",
        repoPath: "acme/web",
        files: ["src/generated.ts"],
        preExisting: [],
      },
    ]);
  });

  it("hands the batch this repository's env names and per-command timeout", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm test")] }),
    );

    await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              env: ["ARTHUR_TOKEN"],
              commandTimeoutMinutes: 3,
              groups: { test: { commands: ["pnpm test"] } },
            },
          ],
        },
      }),
    );

    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![8]).toEqual({
      envNames: ["ARTHUR_TOKEN"],
      commandTimeoutMinutes: 3,
      restoreTree: true,
    });
  });

  it("leaves the tree alone when a selected group opted out of restoring it", async () => {
    // A formatter group exists to edit the tree. Restoring it would delete the
    // group's only output. One opted-out group in the selection decides for
    // the batch, because the batch has a single tree and no way to put back
    // one group's files without racing the other's.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("prettier --write ."), result("pnpm lint")] }),
    );

    const run = await runPrePrChecksWithFixes(
      options({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: {
                format: { commands: ["prettier --write ."], restoreTree: false },
                lint: { commands: ["pnpm lint"] },
              },
            },
          ],
        },
        groupSelection: { kind: "named", groups: ["format", "lint"] },
      }),
    );

    expect(mocks.startRepoCheckBatchStep.mock.calls[0]![8]).toMatchObject({
      restoreTree: false,
    });
    expect(run.passed).toBe(true);
  });

  it("never launches a repair agent, whatever the graph authored", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [result("pnpm lint", 1), result("pnpm test")],
        failures: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm lint",
            exitCode: 1,
            stdout: "",
            stderr: "lint failed",
          },
        ],
      }),
    );

    const run = await runPrePrChecksWithFixes(
      options({ config: groupedConfig, maxFixCycles: 3 }),
    );

    expect(run.passed).toBe(false);
    expect(run.fixCycles).toBe(0);
    expect(run.fixCycleUsages).toEqual([]);
    expect(run.agentFailure).toBeUndefined();
    // One pass over the repository, never a second one after a repair.
    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledTimes(1);
  });

  it("bounds a batch by the configured batchTimeoutMinutes", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({ results: [result("pnpm test")] }),
    );

    await runPrePrChecksWithFixes(
      options({
        config: {
          batchTimeoutMinutes: 5,
          repositories: [
            {
              provider: "github",
              repoPath: "acme/web",
              groups: { test: { commands: ["pnpm test"] } },
            },
          ],
        },
      }),
    );

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as { phaseLimitMs: number };
    expect(tuning.phaseLimitMs).toBe(5 * 60_000);
  });
});

describe("runRepositorySetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observeBudget.mockResolvedValue({
      check: { status: "ok" as const },
      remainingDurationMs: 1_800_000,
      checksElapsedMs: 0,
    });
    mocks.pollPhaseUntilDone.mockResolvedValue(true);
    mocks.startRepoCheckBatchStep.mockImplementation(async (...args: unknown[]) =>
      started(args[7] as number),
    );
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
  });

  it("launches only the setup commands, never the repository's checks", async () => {
    const outcome = await runRepositorySetup({
      sandboxId: "sbx-test-123",
      config: {
        repositories: [
          {
            provider: "github" as const,
            repoPath: "acme/web",
            setup: ["make bootstrap"],
            commands: ["pnpm typecheck"],
          },
        ],
      },
      observeBudget,
    });

    expect(outcome.ran).toBe(1);
    expect(outcome.failures).toEqual([]);
    const [, , , setup, commands, , , requireChange] =
      mocks.startRepoCheckBatchStep.mock.calls[0]!;
    expect(setup).toEqual(["make bootstrap"]);
    expect(commands).toEqual([]);
    // There is no agent work yet at workspace creation, so provisioning cannot
    // be conditional on the agent having touched the repository.
    expect(requireChange).toBe(false);
  });

  it("skips a repository that configured no setup at all", async () => {
    const outcome = await runRepositorySetup({
      sandboxId: "sbx-test-123",
      config: {
        repositories: [
          { provider: "github" as const, repoPath: "acme/web", commands: ["pnpm typecheck"] },
        ],
      },
      observeBudget,
    });

    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ran: 0, failures: [] });
  });

  it("reports a failing setup command so provisioning can stop on it", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        failures: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "make bootstrap",
            exitCode: 127,
            stdout: "",
            stderr: "make: command not found",
            phase: "setup",
          },
        ],
      }),
    );

    const outcome = await runRepositorySetup({
      sandboxId: "sbx-test-123",
      config: {
        repositories: [
          {
            provider: "github" as const,
            repoPath: "acme/web",
            setup: ["make bootstrap"],
            commands: ["pnpm typecheck"],
          },
        ],
      },
      observeBudget,
    });

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.summary).toBe("Setup failed in 1 of 1 repositories.");
  });

  it("charges its waiting to the run's duration, with the ceiling only as a backstop", async () => {
    // Setup is provisioning, not verification. A toolchain install is work the
    // agent needs done before it can start, so it spends the run's minutes and
    // is bounded by them tick by tick; the checks ceiling only stops a setup
    // that would otherwise run unbounded.
    await runRepositorySetup({
      sandboxId: "sbx-test-123",
      config: {
        repositories: [
          {
            provider: "github" as const,
            repoPath: "acme/web",
            setup: ["make bootstrap"],
            commands: ["pnpm typecheck"],
          },
        ],
      },
      observeBudget,
      checksCeilingMs: 60 * 60_000,
    });

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    expect(tuning.ignoreRemainingDuration).toBe(false);
    expect(tuning.phaseLimitMs).toBe(60 * 60_000);
    // And no separate checks observer: the one budget context it polls through
    // is the run's, which is what makes the elapsed land on duration.
    expect(mocks.pollPhaseUntilDone.mock.calls[0]![4]).toBe(observeBudget);
  });

  it("names setup, not checks, when the run's budget stops it", async () => {
    // Two phases spend two different budgets, and an operator reading "setup
    // stopped" reaches for a different knob than one reading "checks stopped".
    mocks.pollPhaseUntilDone.mockRejectedValue(
      new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit: 1_800_000,
        consumed: 1_800_001,
        reason: "budget_exceeded: duration 1800001 reached limit 1800000",
      }),
    );

    await expect(
      runRepositorySetup({
        sandboxId: "sbx-test-123",
        config: {
          repositories: [
            {
              provider: "github" as const,
              repoPath: "acme/web",
              setup: ["make bootstrap"],
              commands: ["pnpm typecheck"],
            },
          ],
        },
        observeBudget,
      }),
    ).rejects.toMatchObject({
      name: "RunBudgetError",
      failure: { reason: expect.stringContaining("setup for github:acme/web stopped") },
    });
  });

  it("leaves the workspace alone when the configuration cannot be read", async () => {
    // A broken configuration is the checks block's failure to report, with the
    // field that broke. Refusing to create a workspace for it would stop runs
    // that never reach a check.
    const outcome = await runRepositorySetup({
      sandboxId: "sbx-test-123",
      config: { repositories: [{ provider: "invalid" }] },
      observeBudget,
    });

    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
    expect(outcome.failures).toEqual([]);
    expect(outcome.summary).toContain("could not be read");
  });
});

describe("checks phase progress observations", () => {
  /** A poll that fires the ticks it is told to, then finishes. Everything a
   *  progress observation reports comes off those ticks. `sleepMs` defaults to
   *  zero so a test that is not about the throttle boundary can ignore it. */
  function pollTicking(
    ticks: Array<{
      elapsedMs: number;
      ticks: number;
      sleepMs?: number;
      remainingDurationMs?: number;
    }>,
  ) {
    return async (...args: unknown[]) => {
      const tuning = args[6] as PhasePollTuning | undefined;
      for (const tick of ticks) {
        await tuning?.onTick?.({
          sleepMs: 0,
          remainingDurationMs: 1_800_000,
          ...tick,
        });
      }
      if (tuning?.outcome) {
        Object.assign(tuning.outcome, {
          reason: "finished",
          elapsedMs: ticks[ticks.length - 1]?.elapsedMs ?? 0,
          ticks: ticks.length,
        });
      }
      return true;
    };
  }

  /**
   * The hooks exactly as a block receives them, through the one function that
   * builds them.
   *
   * createV2InvocationContext REBUILDS the hooks rather than passing them
   * through, so anything it does not name is stripped before a block can call
   * it. A hand-built literal here would test a shape production never hands
   * out, and did: `flush` was dropped at this boundary while the literal-based
   * tests stayed green.
   */
  function wired(
    hooks: V2InvocationObservationHooks,
  ): V2InvocationObservationHooks {
    return createV2InvocationContext({
      nodeId: "checks",
      attempt: 1,
      activationScopeId: "root",
      cancellation: createV2InvocationCancellationController().view,
      observations: hooks,
    }).observations;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.startRepoCheckBatchStep.mockImplementation(async (
      _sandboxId: string,
      _provider: string,
      _repoPath: string,
      _setup: string[],
      _commands: string[],
      _fixCycle: number,
      repoIndex: number,
    ) => started(repoIndex));
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [
          {
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm typecheck",
            exitCode: 0,
          },
        ],
      }),
    );
  });

  it("reports elapsed against the ceiling while the batch is still running", async () => {
    // A forty minute checks phase used to be indistinguishable from a hung run:
    // everything a batch knows is written inside the sandbox and read back only
    // once it finishes.
    const emit = vi.fn();
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([{ elapsedMs: 2_000, ticks: 1 }]),
    );

    await runPrePrChecksWithFixes(
      options({
        // 10 minutes of the ceiling are already gone, so the bound this batch
        // got is the remainder and the elapsed it reports includes both.
        observeBudget: async () => ({
          check: { status: "ok" },
          remainingDurationMs: 1_800_000,
          checksElapsedMs: 600_000,
        }),
        observations: wired({ emit }),
      }),
    );

    // A LOG, and a sentence. The metadata envelope is a latest-value cell the
    // store overwrites, so a forty minute batch used to leave one raw-ms JSON
    // blob behind; logs append. "about" because elapsed is the sum of the
    // sleeps the poll requested and under-reports a slow tick, and "launched"
    // because the count is a total that read as "done".
    expect(emit).toHaveBeenCalledWith({
      kind: "log",
      value:
        "Checks running: about 10 minutes of 60 minutes, 1 command launched, github:acme/web",
    });
  });

  it("reports at most once per tick ceiling, so the ramp does not spam", async () => {
    const emit = vi.fn();
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([
        { elapsedMs: 2_000, ticks: 1 },
        { elapsedMs: 5_200, ticks: 2 },
        { elapsedMs: 40_000, ticks: 5 },
      ]),
    );

    await runPrePrChecksWithFixes(options({ observations: wired({ emit }) }));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![0]).toMatchObject({
      value: expect.stringContaining("about 40 seconds"),
    });
  });

  it("still reports when the ramp lands a hair under the interval", async () => {
    // The tick ramps 2s, 3.2s, 5.1s, 8.2s, 13.1s, so the fifth one arrives
    // 29.6 seconds after the first. A throttle that compares the gap against a
    // flat 30 seconds drops exactly that report and leaves the operator staring
    // at nothing for another twenty seconds, which is the interval failing at
    // the one moment it is supposed to hold.
    const emit = vi.fn();
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([
        { elapsedMs: 2_000, ticks: 1, sleepMs: 2_000 },
        { elapsedMs: 5_200, ticks: 2, sleepMs: 3_200 },
        { elapsedMs: 10_320, ticks: 3, sleepMs: 5_120 },
        { elapsedMs: 18_512, ticks: 4, sleepMs: 8_192 },
        { elapsedMs: 31_619, ticks: 5, sleepMs: 13_107 },
      ]),
    );

    await runPrePrChecksWithFixes(options({ observations: wired({ emit }) }));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]![0]).toMatchObject({
      value: expect.stringContaining("about 32 seconds"),
    });
  });

  it("makes every progress report durable before the batch ends", async () => {
    // Emitting alone only buffers, and the buffer is written when the node
    // finishes. That is the exact moment a progress report stops being worth
    // anything.
    const emit = vi.fn();
    const flush = vi.fn();
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([{ elapsedMs: 2_000, ticks: 1 }]),
    );

    await runPrePrChecksWithFixes(options({ observations: wired({ emit, flush }) }));

    expect(flush).toHaveBeenCalledTimes(1);
    expect(emit.mock.invocationCallOrder[0]!).toBeLessThan(
      flush.mock.invocationCallOrder[0]!,
    );
  });

  it("never lets a failed flush end a healthy batch", async () => {
    const flush = vi.fn(() => {
      throw new Error("replay capture is down");
    });
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([{ elapsedMs: 2_000, ticks: 1 }]),
    );

    const run = await runPrePrChecksWithFixes(
      options({ observations: wired({ emit: vi.fn(), flush }) }),
    );

    expect(flush).toHaveBeenCalledTimes(1);
    expect(run.outcome).toBe("passed");
  });

  it("never lets a failed observation end a healthy batch", async () => {
    const emit = vi.fn(() => {
      throw new Error("replay capture is down");
    });
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([{ elapsedMs: 2_000, ticks: 1 }]),
    );

    const run = await runPrePrChecksWithFixes(
      options({ observations: wired({ emit }) }),
    );

    expect(emit).toHaveBeenCalledTimes(1);
    expect(run.outcome).toBe("passed");
  });

  it("reports the setup substep too, which is where a run is silent longest", async () => {
    // Provisioning precedes every block that produces output, so an operator
    // watching a five minute `uv sync` has nothing else at all to look at. A
    // setup batch spends the run's duration rather than the checks ceiling, so
    // its elapsed is its own wait and nothing is claimed about the ceiling.
    const emit = vi.fn();
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([
        { elapsedMs: 2_000, ticks: 1, remainingDurationMs: 900_000 },
      ]),
    );

    await runRepositorySetup({
      sandboxId: "sbx-test-123",
      config: {
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            setup: ["uv sync"],
            commands: ["pnpm typecheck"],
          },
        ],
      },
      observeBudget,
      checksCeilingMs: 3_600_000,
      observations: wired({ emit }),
    });

    // Setup is charged to the run's duration budget and is deliberately outside
    // the checks ceiling, so the line names no ceiling at all: its bound is
    // what the duration budget had left at this tick.
    expect(emit).toHaveBeenCalledWith({
      kind: "log",
      value:
        "Setup running: about 2 seconds in, 15 minutes of run budget left, " +
        "1 command launched, github:acme/web",
    });
  });

  it("emits nothing when the caller has no invocation to bind observations to", async () => {
    mocks.pollPhaseUntilDone.mockImplementation(
      pollTicking([{ elapsedMs: 2_000, ticks: 1 }]),
    );

    await expect(runPrePrChecksWithFixes(options())).resolves.toMatchObject({
      outcome: "passed",
    });
  });
});
