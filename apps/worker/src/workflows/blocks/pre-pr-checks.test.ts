import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrePrCheckConfig } from "../../pre-pr-checks/config.js";
import { createRunBudgetState, type RunBudgetObservation } from "../run-budget.js";

const mocks = vi.hoisted(() => ({
  startRepoCheckBatchStep: vi.fn(),
  collectRepoCheckBatchStep: vi.fn(),
  startPrePrRepairStep: vi.fn(),
  collectPrePrRepairStep: vi.fn(),
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
  startPrePrRepairStep: mocks.startPrePrRepairStep,
  collectPrePrRepairStep: mocks.collectPrePrRepairStep,
}));
vi.mock("./poll-phase.js", () => ({ pollPhaseUntilDone: mocks.pollPhaseUntilDone }));
vi.mock("../../sandbox/poll-agent.js", () => ({ checkPhaseDone: mocks.checkPhaseDone }));

import { loadPrePrCheckConfigStep, runPrePrChecksWithFixes } from "./pre-pr-checks.js";
import type { PhasePollOutcome, PhasePollTuning } from "./poll-phase.js";

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
  results?: Array<{ provider: "github" | "gitlab"; repoPath: string; command: string; exitCode: number }>;
  failures?: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    phase?: "setup" | "workspace" | "batch" | "omitted";
  }>;
  setupFailed?: boolean;
  progress?: { completed: number; total: number; stoppedAt: string | null };
} = {}) {
  const results = overrides.results ?? [];
  const failures = overrides.failures ?? [];
  return {
    results,
    failures,
    setupFailed: overrides.setupFailed ?? false,
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
      summary: "No pre-PR checks configured.",
    });
    expect(mocks.startRepoCheckBatchStep).not.toHaveBeenCalled();
  });

  it("skips a repository the start step declined and reports no matching checks", async () => {
    mocks.startRepoCheckBatchStep.mockResolvedValue({ skipped: true });

    const result = await runPrePrChecksWithFixes(options());

    expect(result.passed).toBe(true);
    expect(result.summary).toBe("No pre-PR checks matched changed repositories.");
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
    expect(result.fixCycles).toBe(0);
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
    // The second repository was still started, polled and collected.
    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([
      { provider: "gitlab", repoPath: "acme/api", command: "pnpm test", exitCode: 0 },
    ]);
    expect(result.summary).toContain("SETUP FAILED for github:acme/web");
    expect(result.summary).toContain("no agent fix cycles were run");
  });

  it("says on every entry that one repository's setup failure suppressed the run", async () => {
    // Suppression is run-wide, so an unrelated repository's entry otherwise
    // shows a plainly repairable failure next to fixCycles: 0 and says nothing
    // about why nothing was attempted.
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
        collected({
          results: [{ provider: "gitlab", repoPath: "acme/api", command: "pnpm test", exitCode: 1 }],
          failures: [{
            provider: "gitlab",
            repoPath: "acme/api",
            command: "pnpm test",
            exitCode: 1,
            stdout: "",
            stderr: "Type error on line 12",
          }],
        }),
      );

    const result = await runPrePrChecksWithFixes(options({ config }));

    expect(result.fixCycles).toBe(0);
    const apiEntry = result.summary.split("\n\n").find((entry) => entry.startsWith("gitlab:acme/api"));
    expect(apiEntry).toContain("No agent fix cycles were run for this failure either");
    expect(apiEntry).toContain("github:acme/web");
    // The repair prompt is a different document and stays free of it: the
    // fixer is never run in this state at all.
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
  });

  it("does not claim the fixer never ran when it already had", async () => {
    // Suppression is evaluated per pass while the sentence speaks for the run,
    // so a run that spent a cycle and then hit a setup failure on the re-run
    // would otherwise tell the operator no fix cycles ran, with fixCycles: 1
    // sitting next to it.
    const apiFailure = {
      provider: "gitlab" as const,
      repoPath: "acme/api",
      command: "pnpm test",
      exitCode: 1,
      stdout: "",
      stderr: "still failing",
    };
    const setupFailure = {
      provider: "github" as const,
      repoPath: "acme/web",
      command: "make bootstrap",
      exitCode: 127,
      stdout: "",
      stderr: "toolchain: command not found",
      phase: "setup" as const,
    };
    // Pass one: web is fine, api fails a check, so one fix cycle runs.
    // Pass two: web's setup has broken, which suppresses the rest of the run.
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(collected())
      .mockResolvedValueOnce(collected({ failures: [apiFailure] }))
      .mockResolvedValueOnce(collected({ setupFailed: true, failures: [setupFailure] }))
      .mockResolvedValueOnce(collected({ failures: [apiFailure] }));
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    mocks.collectPrePrRepairStep.mockResolvedValue({ usage: null });

    const result = await runPrePrChecksWithFixes(options({ config, maxFixCycles: 3 }));

    expect(result.fixCycles).toBe(1);
    expect(result.summary).toContain("No further agent fix cycles were run");
    expect(result.summary).toContain("1 had already run");
    expect(result.summary).not.toContain("No agent fix cycles were run for this failure either");
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
    expect(result.fixCycles).toBe(0);
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
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
  });

  it("never reports a stall as a check whose fix cycles were suppressed", async () => {
    // A stall is not a check result: nothing was verified. Without a phase it
    // reads as an ordinary failing check, so with a setup failure earlier in
    // the same pass it collects the sentence explaining that its fix cycles
    // were suppressed, and it would be handed to the repair agent to fix.
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
    // The proof the phase is doing the work: an ordinary failing check in this
    // same summary would carry the suppression sentence.
    expect(stallEntry).not.toContain("No agent fix cycles were run");
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
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
    // Same category as a setup failure: the fixer has nothing to act on, and
    // handing it an infrastructure fault burns the whole fix budget rewriting
    // code that was never shown to be wrong.
    expect(result.fixCycles).toBe(0);
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
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
    expect(result.summary).toBe("Pre-PR checks passed (1 command).");
    expect(mocks.collectRepoCheckBatchStep.mock.calls[0]![7]).toBe(true);
  });

  it("repairs a failing check and re-runs the batch in its own cycle namespace", async () => {
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        collected({
          results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
          failures: [{
            provider: "github",
            repoPath: "acme/web",
            command: "pnpm typecheck",
            exitCode: 1,
            stdout: "",
            stderr: "Type error on line 12",
          }],
        }),
      )
      .mockResolvedValueOnce(
        collected({
          results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 0 }],
        }),
      );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    mocks.collectPrePrRepairStep.mockResolvedValue({ usage: null });

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 3 }));

    expect(result.passed).toBe(true);
    expect(result.fixCycles).toBe(1);
    expect(result.fixCycleUsages).toEqual([null]);
    // The fixer is handed the failing summary, and the re-run writes to cycle 1.
    expect(mocks.startPrePrRepairStep).toHaveBeenCalledWith(
      "sbx-test-123",
      "codex",
      "gpt-5",
      1,
      expect.stringContaining("Type error on line 12"),
      undefined,
      undefined,
    );
    expect(mocks.startRepoCheckBatchStep.mock.calls.map((call) => call[5])).toEqual([0, 1]);
  });

  it("stops the fix loop when the re-run after a repair stalls", async () => {
    // The guard has to hold on every pass, not just the first: a batch that
    // stalls after cycle one must not start cycle two.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    mocks.collectPrePrRepairStep.mockResolvedValue({ usage: null });
    // Batch one finishes, the repair finishes, the re-run never reports.
    mocks.pollPhaseUntilDone
      .mockImplementationOnce(pollEnds("finished", 30_000))
      .mockImplementationOnce(pollEnds("finished", 30_000))
      .mockImplementation(pollEnds("duration_cap", 1_500_000));
    mocks.checkPhaseDone.mockResolvedValue(false);

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 3 }));

    expect(result.fixCycles).toBe(1);
    expect(mocks.startPrePrRepairStep).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("ran for 25 minutes without finishing");
  });

  it("bounds a batch by the run's remaining duration, not by the constant alone", async () => {
    // The constant is a ceiling. What actually bounds a batch is the run's
    // duration budget, which is maxDurationMs from the definition or else
    // JOB_TIMEOUT_MS, so it differs per deployment and per plan.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    observeBudget.mockResolvedValueOnce({
      check: { status: "ok" as const },
      remainingDurationMs: 1_800_000,
    });

    await runPrePrChecksWithFixes(options());

    const tuning = mocks.pollPhaseUntilDone.mock.calls[0]![6] as PhasePollTuning;
    // Milliseconds, and deliberately ABOVE the remaining budget. Flooring to
    // whole minutes hands the poll a cap at or below the budget, so the phase
    // timeout fires first and a run that has simply run out of time reports
    // "the checks ran for 29 minutes without finishing" instead of halting as
    // budget_exceeded. Which of the two fired would not even be deterministic:
    // tick overhead competes with the discarded sub-minute remainder.
    expect(tuning.phaseLimitMs).toBe(1_860_000);
  });

  it("never lets a batch outlive the documented ceiling, however long the budget", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(collected());
    observeBudget.mockResolvedValueOnce({
      check: { status: "ok" as const },
      remainingDurationMs: 6_000_000,
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

  it("keeps another repository's fix cycles when one repository's workspace is gone", async () => {
    // A vanished workspace directory is the run's own failure, not the
    // operator's configuration. Reporting it as a setup failure suppressed the
    // fix cycles of every other repository in the run.
    const workspaceFailure = {
      provider: "github" as const,
      repoPath: "acme/web",
      command: "(repository workspace)",
      exitCode: -1,
      stdout: "",
      stderr: "The repository's workspace directory could not be entered.",
      phase: "workspace" as const,
    };
    const apiFailure = {
      provider: "gitlab" as const,
      repoPath: "acme/api",
      command: "pnpm test",
      exitCode: 1,
      stdout: "",
      stderr: "Type error on line 12",
    };
    mocks.collectRepoCheckBatchStep
      .mockResolvedValueOnce(
        collected({ failures: [workspaceFailure] }),
      )
      .mockResolvedValueOnce(
        collected({
          results: [{ provider: "gitlab", repoPath: "acme/api", command: "pnpm test", exitCode: 1 }],
          failures: [apiFailure],
        }),
      )
      .mockResolvedValueOnce(
        collected({ failures: [workspaceFailure] }),
      )
      .mockResolvedValueOnce(
        collected({
          results: [{ provider: "gitlab", repoPath: "acme/api", command: "pnpm test", exitCode: 0 }],
        }),
      );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    mocks.collectPrePrRepairStep.mockResolvedValue({ usage: null });

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 3, config }));

    expect(result.setupFailed).toBe(false);
    expect(mocks.startPrePrRepairStep).toHaveBeenCalledTimes(1);
    // The fixer sees the check it can repair and not the infrastructure fault
    // it cannot: asking it to edit code in response to a missing directory is
    // how a fix budget gets spent on nothing.
    const prompt = mocks.startPrePrRepairStep.mock.calls[0]![4] as string;
    expect(prompt).toContain("Type error on line 12");
    expect(prompt).not.toContain("workspace directory could not be entered");
    expect(result.summary).toContain("WORKSPACE UNAVAILABLE for github:acme/web");
  });

  it("runs no fix cycle when the only failure is the workspace's own", async () => {
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
    expect(result.fixCycles).toBe(0);
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
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
      true,
    );
  });

  it("stops at maxFixCycles and reports the last failing summary", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    mocks.collectPrePrRepairStep.mockResolvedValue({ usage: null });

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 2 }));

    expect(result.passed).toBe(false);
    expect(result.fixCycles).toBe(2);
    expect(result.summary).toContain("still failing");
  });

  it("runs no fix cycles when maxFixCycles is 0", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 0 }));

    expect(result.fixCycles).toBe(0);
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
  });

  it("runs no fix cycles when the graph does not author maxFixCycles", async () => {
    // Pins the shipped default. Repair before the pull request re-ran the whole
    // batch on every cycle and could not tell a broken environment from broken
    // code, so remediation moved behind the pull request. A graph that wants the
    // old behaviour has to ask for it by number.
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );

    const result = await runPrePrChecksWithFixes(options());

    expect(result.fixCycles).toBe(0);
    expect(result.passed).toBe(false);
    expect(mocks.startPrePrRepairStep).not.toHaveBeenCalled();
  });

  it("returns a repair agent failure without starting another cycle", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: false,
      failure: { ok: false, category: "provider", diagnostic: { failureKind: "setup_failed" } },
    });

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 3 }));

    expect(result.fixCycles).toBe(1);
    expect(result.agentFailure).toMatchObject({
      diagnostic: { failureKind: "setup_failed" },
    });
    expect(mocks.startPrePrRepairStep).toHaveBeenCalledTimes(1);
  });

  it("reports the repair stall reason the poll produced", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    // The batch poll succeeds; only the repair poll runs out. The kind of stall
    // comes from the poll, which is the only thing that saw the sandbox go: one
    // more sentinel read cannot tell a dead sandbox from a transient fault.
    mocks.pollPhaseUntilDone
      .mockImplementationOnce(pollEnds("finished", 30_000))
      .mockImplementationOnce(pollEnds("sandbox_stopped", 60_000));
    mocks.checkPhaseDone.mockResolvedValue(false);
    mocks.collectPrePrRepairStep.mockResolvedValue({
      usage: null,
      failure: { ok: false, category: "provider", diagnostic: { failureKind: "provider_error" } },
    });

    const result = await runPrePrChecksWithFixes(options({ maxFixCycles: 1 }));

    expect(mocks.collectPrePrRepairStep).toHaveBeenCalledWith(
      "sbx-test-123",
      "codex",
      "pre-pr-fix-1",
      expect.anything(),
      "sandbox_stopped",
      // The elapsed time the repair poll consumed, so its failure detail can
      // name the bound that applied instead of the 25 minute constant.
      60_000,
      undefined,
    );
    expect(result.agentFailure).toBeDefined();
  });

  it("stops before another check or fixer when the first fix cycle exceeds the token cap", async () => {
    mocks.collectRepoCheckBatchStep.mockResolvedValue(
      collected({
        results: [{ provider: "github", repoPath: "acme/web", command: "pnpm typecheck", exitCode: 1 }],
        failures: [{
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm typecheck",
          exitCode: 1,
          stdout: "",
          stderr: "still failing",
        }],
      }),
    );
    mocks.startPrePrRepairStep.mockResolvedValue({
      ok: true,
      commandId: "cmd-fix",
      phase: "pre-pr-fix-1",
      paths: { sentinel: "/tmp/pre-pr-fix-1-done" },
    });
    mocks.collectPrePrRepairStep.mockResolvedValue({
      usage: {
        cost_usd: null,
        tokens: { input: 8, cached_input: 2, output: 3 },
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
      },
    });

    const result = await runPrePrChecksWithFixes(
      options({
        maxFixCycles: 3,
        budget: {
          state: createRunBudgetState(),
          limits: { maxDurationMs: 60_000, maxTokens: 12 },
          price: { input: 0.001, cached_input: 0.0001, output: 0.002 },
        },
      }),
    );

    expect(result.fixCycles).toBe(1);
    expect(result.budgetFailure).toMatchObject({
      status: "budget_exceeded",
      metric: "tokens",
      limit: 12,
      consumed: 13,
    });
    expect(mocks.startPrePrRepairStep).toHaveBeenCalledTimes(1);
    expect(mocks.startRepoCheckBatchStep).toHaveBeenCalledTimes(1);
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
