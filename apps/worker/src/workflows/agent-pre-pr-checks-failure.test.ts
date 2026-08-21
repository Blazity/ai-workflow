import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  loadPrePrCheckConfigStep: vi.fn(),
  runPrePrChecksWithFixes: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));
// The regex half of the real redactor is what these assert against; its
// process.env half would make the output depend on the machine running the
// suite, and there is no secret in these fixtures for it to find.
vi.mock("../../env.js", () => ({
  env: { DASHBOARD_ORIGIN: "https://dashboard.example.com" },
}));
// The engine boundary, replaced exactly where run-checks.test.ts replaces it:
// neither the load nor the run is a step the block owns, so the block is
// exercised against the two calls it makes and nothing below them.
vi.mock("./blocks/pre-pr-checks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./blocks/pre-pr-checks.js")>()),
  loadPrePrCheckConfigStep: mocks.loadPrePrCheckConfigStep,
  runPrePrChecksWithFixes: mocks.runPrePrChecksWithFixes,
}));

import {
  PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
  prePrChecksFailureMessage,
  PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH,
  definitionRequestsRepairCycles,
  describePrePrChecksFailureStep,
  isRepositoryScriptsFailurePhase,
  prePrChecksFailureInput,
  prePrChecksFailureMustPropagate,
  prePrChecksFailureReport,
  executeRunScripts,
  failureExitPhase,
  nodeCanRecordGate,
  recoverLatestRepositoryScriptsFailureFromSteps,
  repositoryScriptsFailureComment,
  repositoryScriptsOutput,
  repositoryScriptsStatus,
} from "./agent.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  runControlErrorCases as blockRunControlErrorCases,
} from "./blocks/test-support.js";
import type {
  WorkflowBlockType,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import {
  executionError,
  formatExecutionErrorForUser,
  type StepsRecord,
  type WorkflowExecutionErrorState,
} from "../workflow-definition/interpreter.js";
import { executeV2Graph } from "../workflow-definition/v2-scheduler.js";
import type { PrePrCheckRunResult } from "../pre-pr-checks/runner.js";
import { isDurationAbortError } from "./run-budget.js";
import { isRunControlError } from "./run-control-error.js";
import { runControlErrorCases } from "./blocks/test-support.js";

const MESSAGE_LEAD = "The repository scripts step failed: ";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * What the call site does with a throw it may not propagate: flatten it in
 * workflow scope, then compose and log the sentence inside the step. The
 * checks stopped being a step of their own (they are launched detached and
 * polled), so this pair is the seam that carries what #316 landed.
 */
function describe_(error: unknown, version: number | null = 7) {
  return describePrePrChecksFailureStep(prePrChecksFailureInput(error), version);
}

describe("pre-PR checks step failure cause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the thrown cause instead of leaving Workflow's wrapper to speak alone", async () => {
    // Production runs wrun_01M0CBQNAX24STRMN5SGCKKGB2 and
    // wrun_01M0CAZKV3YMNFBCZJA8MT95GW died here reading only "exceeded max
    // retries", with no sanitized output captured and nothing in the runtime
    // logs. Whatever the step throws has to reach the operator-facing text.
    await expect(describe_(new Error("sandbox connection reset"))).resolves.toBe(
      `${MESSAGE_LEAD}sandbox connection reset`,
    );
    expect(mocks.error).toHaveBeenCalledTimes(1);
    const [record, msg] = mocks.error.mock.calls[0] as [
      { version: number | null; name: string; cause: string; stackTail: string },
      string,
    ];
    expect(msg).toBe("pre_pr_checks_step_failed");
    expect(record.version).toBe(7);
    expect(record.name).toBe("Error");
    expect(record.cause).toBe("sandbox connection reset");
    // The tail, so a very deep stack keeps its innermost-to-outermost end
    // rather than growing the log record without bound. The message itself is
    // already in `cause`, so nothing is lost when the head is clipped.
    expect(record.stackTail).toMatch(/\bat\b/);
    expect(record.stackTail.length).toBeLessThanOrEqual(
      PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH,
    );
  });

  it("labels the cause with the class name, the only thing left of the error", async () => {
    // Everything caught here was thrown inside a step, and Workflow reduces a
    // thrown error to name, message and stack at the VM boundary and revives it
    // as a plain Error. A system error code would name the cause far better
    // than `Error` does, but `.code` cannot reach this side, so nothing may be
    // built on it: a label that can never fire reads as coverage that does not
    // exist. Recovering it would mean parsing the message.
    const error = Object.assign(namedError("SandboxError", "connect ECONNREFUSED 10.0.0.1:443"), {
      code: "ECONNREFUSED",
    });

    await expect(describe_(error)).resolves.toBe(
      `${MESSAGE_LEAD}SandboxError: connect ECONNREFUSED 10.0.0.1:443`,
    );
    // A plain Error adds nothing worth prefixing, and a non-Error throw's
    // `typeof` is noise on top of its own text.
    await expect(describe_(new Error("plain"))).resolves.toBe(`${MESSAGE_LEAD}plain`);
    await expect(describe_("just a string")).resolves.toBe(`${MESSAGE_LEAD}just a string`);
  });

  it("bounds a runaway cause instead of embedding it whole", async () => {
    const thrownMessage = "sandbox refused the launch. ".repeat(200);

    const message = await describe_(new Error(thrownMessage));

    expect(message).toContain(MESSAGE_LEAD);
    expect(message).not.toContain(thrownMessage);
    // Sentence plus the bound the cause is clamped to, and nothing more, so a
    // runaway error text cannot become the run status.
    expect(message.length).toBeLessThanOrEqual(
      MESSAGE_LEAD.length + PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
    );
    const logged = mocks.error.mock.calls[0]?.[0] as { cause: string };
    expect(logged.cause.length).toBe(PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH);
  });

  it.each(runControlErrorCases())(
    "keeps %s out of the wrap so the call site still recognizes it",
    (_label, error) => {
      expect(prePrChecksFailureMustPropagate(error)).toBe(true);
      expect(isRunControlError(error)).toBe(true);
    },
  );

  it.each([["AbortError"], ["TimeoutError"]])(
    "keeps a %s out of the wrap so the duration budget stop survives",
    (name) => {
      const error = namedError(name, "The operation was aborted.");

      expect(prePrChecksFailureMustPropagate(error)).toBe(true);
      expect(isDurationAbortError(error)).toBe(true);
    },
  );

  it("wraps only what wrapping cannot break", () => {
    // Why the two predicates gate the wrap at all: both match structurally on
    // `name`, so a control error re-thrown as `new Error(message)` stops being
    // one, and a duration budget stop would report as a generic failure.
    const budgetStop = namedError("RunBudgetError", "budget exceeded");
    const abort = namedError("AbortError", "The operation was aborted.");
    const identity = (value: string) => value;

    expect(prePrChecksFailureMustPropagate(budgetStop)).toBe(true);
    expect(prePrChecksFailureMustPropagate(abort)).toBe(true);
    expect(prePrChecksFailureMustPropagate(new Error("sandbox died"))).toBe(false);

    const rewrappedBudget = new Error(
      prePrChecksFailureReport(prePrChecksFailureInput(budgetStop), identity).message,
    );
    expect(isRunControlError(rewrappedBudget)).toBe(false);
    const rewrappedAbort = new Error(
      prePrChecksFailureReport(prePrChecksFailureInput(abort), identity).message,
    );
    expect(isDurationAbortError(rewrappedAbort)).toBe(false);
  });

  it("redacts the cause and the stack tail through the caller's redactor", () => {
    const report = prePrChecksFailureReport(
      prePrChecksFailureInput(new Error("auth failed for token=abcd1234")),
      (value) => value.replace("abcd1234", "[REDACTED]"),
    );

    expect(report.cause).toBe("auth failed for token=[REDACTED]");
    expect(report.stackTail).not.toContain("abcd1234");
  });

  it("names a non-Error throw rather than dropping it", () => {
    const report = prePrChecksFailureReport(
      prePrChecksFailureInput("sandbox vanished"),
      (v) => v,
    );

    expect(report.message).toBe(`${MESSAGE_LEAD}sandbox vanished`);
    expect(report.name).toBe("string");
    expect(report.stackTail).toBe("");
  });

  it("redacts and bounds before the value can be journaled", async () => {
    // Workflow journals step arguments durably, so whatever the flattener
    // returns is written into the run's event log verbatim. Redacting inside
    // the step would protect only the sentence an operator reads.
    const secret = "glpat-AAAAAAAAAAAAAAAAAAAA";
    const error = new Error(
      `clone failed for https://oauth2:${secret}@gitlab.com/acme/api.git ${"pad ".repeat(200)}`,
    );

    const input = prePrChecksFailureInput(error);

    expect(input.message).not.toContain(secret);
    expect(input.message).toContain("[REDACTED]");
    expect(input.message.length).toBe(PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH);
    expect(input.stack.length).toBeLessThanOrEqual(
      PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH,
    );
  });

  it("survives a throw with no properties at all", async () => {
    // `throw null` and a bare Promise.reject() both reach here. A TypeError
    // raised inside the reporting path would lose the cause it exists to carry
    // and hand the operator an unrelated error.
    for (const thrown of [null, undefined]) {
      expect(() => prePrChecksFailureInput(thrown)).not.toThrow();
      await expect(describe_(thrown)).resolves.toContain(MESSAGE_LEAD);
    }
  });

  it("degrades to a fixed sentence when the reporting step itself fails", async () => {
    // The step is the only place the cause is logged and its maxRetries is 0.
    // A failed dynamic import on a cold start, or an invocation killed
    // mid-step, must not substitute the reporting path's own error for the
    // report.
    mocks.error.mockImplementation(() => {
      throw new Error("logger transport is gone");
    });

    const message = await prePrChecksFailureMessage(
      Object.assign(new Error("sandbox connection reset"), { name: "SandboxError" }),
      7,
    );

    expect(message).toBe(
      "The repository scripts step failed (SandboxError), and the cause could not be recorded.",
    );
  });

  it.each(runControlErrorCases())(
    "rethrows %s from the reporting step instead of degrading",
    async (_label, controlError) => {
      // The degraded sentence is for a reporting path that broke. A cancelled
      // run surfaces at every step, this one included, and swallowing it here
      // would report a Pre-PR checks failure for a run the operator cancelled,
      // and let it carry on being cancelled anyway.
      mocks.error.mockImplementation(() => {
        throw controlError;
      });

      await expect(
        prePrChecksFailureMessage(new Error("sandbox connection reset"), 7),
      ).rejects.toBe(controlError);
    },
  );
});

/** An engine result with nothing set, so each case states only what it changes. */
function engineResult(
  overrides: Partial<PrePrCheckRunResult> = {},
): PrePrCheckRunResult {
  return {
    outcome: "passed",
    passed: true,
    fixCycles: 0,
    fixCycleUsages: [],
    budgetFailure: null,
    results: [],
    failures: [],
    groupStatuses: [],
    dirtied: [],
    setupFailed: false,
    summary: "Pre-PR checks passed (1 command).",
    ...overrides,
  };
}

function groupStatus(
  group: string,
  status: PrePrCheckRunResult["groupStatuses"][number]["status"],
) {
  return { provider: "github" as const, repoPath: "acme/api", group, status };
}

function ranOneCommand() {
  return [
    {
      provider: "github" as const,
      repoPath: "acme/api",
      command: "pnpm test",
      exitCode: 0,
      group: "checks",
      durationMs: 1_200,
      timedOut: false,
    },
  ];
}

/** What ranOneCommand looks like once the adapter has shaped it. */
const ONE_COMMAND_RESULT = {
  repo: "github:acme/api",
  command: "pnpm test",
  group: "checks",
  exitCode: 0,
  durationMs: 1_200,
  timedOut: false,
};

describe("repository scripts block output", () => {
  it("reports a clean pass as passed, all passed, nothing failed", () => {
    const output = repositoryScriptsOutput(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [groupStatus("checks", "passed")],
      }),
    );

    expect(output).toEqual({
      ok: true,
      outcome: "passed",
      allPassed: true,
      anyFailed: false,
      groupStatuses: [groupStatus("checks", "passed")],
      results: [ONE_COMMAND_RESULT],
      failures: [],
      dirtied: [],
      setupFailed: false,
      summary: "Pre-PR checks passed (1 command).",
    });
  });

  it("carries a failing run as a branchable outcome, never as an error", () => {
    const output = repositoryScriptsOutput(
      engineResult({
        outcome: "failed",
        passed: false,
        results: ranOneCommand(),
        failures: [
          {
            provider: "github",
            repoPath: "acme/api",
            command: "pnpm test",
            exitCode: 1,
            stdout: "",
            stderr: "boom",
          },
        ],
        groupStatuses: [groupStatus("checks", "failed")],
        summary: "1 check failed.",
      }),
    );

    expect(output.ok).toBe(false);
    expect(output.outcome).toBe("failed");
    expect(output.anyFailed).toBe(true);
    expect(output.allPassed).toBe(false);
    expect(output.summary).toBe("1 check failed.");
  });

  it("calls a timed-out group a failure, because nothing about it was verified", () => {
    const output = repositoryScriptsOutput(
      engineResult({
        outcome: "failed",
        passed: false,
        results: ranOneCommand(),
        groupStatuses: [groupStatus("test", "timed_out")],
      }),
    );

    expect(output.anyFailed).toBe(true);
    expect(output.allPassed).toBe(false);
  });

  it("refuses to call a run all-passed when a selected group never started", () => {
    // A batch that stalled halfway verified nothing about the commands that
    // never ran. "not_run" is not a failure and not a pass, and folding it into
    // either is how a partial run reads as a green gate.
    const output = repositoryScriptsOutput(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [groupStatus("test", "passed"), groupStatus("lint", "not_run")],
      }),
    );

    expect(output.anyFailed).toBe(false);
    expect(output.allPassed).toBe(false);
  });

  it("ignores groups this run did not select when deciding all-passed", () => {
    // A node asking for "test" leaves every other group of the repository
    // "skipped". Those say nothing about this run and must not hold allPassed
    // down, or naming one group would make a green run unreportable.
    const output = repositoryScriptsOutput(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [groupStatus("test", "passed"), groupStatus("lint", "skipped")],
      }),
    );

    expect(output.allPassed).toBe(true);
    expect(output.anyFailed).toBe(false);
  });

  it("turns a run that executed nothing into a loud skip rather than a pass", () => {
    // The engine reports zero commands and no failures as "passed", which reads
    // as verified. It is not: nothing matched. This is the state that used to
    // let an unconfigured repository sail through the gate.
    const output = repositoryScriptsOutput(
      engineResult({
        summary: "No repository scripts matched changed repositories.",
        groupStatuses: [groupStatus("checks", "skipped")],
      }),
    );

    expect(output.outcome).toBe("skipped");
    expect(output.ok).toBe(true);
    expect(output.allPassed).toBe(false);
    expect(output.anyFailed).toBe(false);
    // The engine's own sentence, not one this adapter invents. It words itself
    // per selection, and overwriting it pointed a named run's operator at a
    // change filter that selection never applied.
    expect(output.summary).toBe("No repository scripts matched changed repositories.");
  });

  it("keeps an unconfigured product distinguishable from one that matched nothing", () => {
    const output = repositoryScriptsOutput(
      engineResult({
        outcome: "missing_configuration",
        summary: "No pre-PR checks configured.",
      }),
    );

    expect(output.outcome).toBe("missing_configuration");
    expect(output.summary).toBe("No pre-PR checks configured.");
  });

  it("reports a requested group no repository declares as not_run", () => {
    // A name nobody has is a typo or a deleted group, and running zero commands
    // for it reports a pass for work that never happened.
    const output = repositoryScriptsOutput(
      engineResult({
        summary: "No repository scripts matched the selected groups.",
        groupStatuses: [groupStatus("lint", "skipped"), groupStatus("test", "skipped")],
      }),
      ["checks"],
    );

    expect(output.groupStatuses).toContainEqual(groupStatus("checks", "not_run"));
    expect(output.allPassed).toBe(false);
    expect(output.outcome).toBe("skipped");
    // The named-selection sentence, naming the filter that was actually applied.
    expect(output.summary).toBe("No repository scripts matched the selected groups.");
  });

  it("leaves a group only some repositories declare alone", () => {
    // The engine's normal case: one node asking for "test" across a workspace
    // where only some repositories define it. Synthesizing not_run for the rest
    // would make every partial-workspace selection unreportable.
    const output = repositoryScriptsOutput(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [
          groupStatus("test", "passed"),
          { provider: "github", repoPath: "acme/web", group: "lint", status: "skipped" },
        ],
      }),
      ["test"],
    );

    expect(output.groupStatuses).toHaveLength(2);
    expect(output.allPassed).toBe(true);
  });

  it("raises anyFailed when the run could not start at all", () => {
    // An unreadable configuration produces no group statuses whatsoever, so
    // deriving anyFailed from groups alone let an anyFailed -> remediate wire
    // take the happy path on the one failure nobody can see from inside.
    const output = repositoryScriptsOutput(
      engineResult({
        outcome: "failed",
        passed: false,
        summary: "The repository scripts configuration could not be read.",
      }),
    );

    expect(output.groupStatuses).toEqual([]);
    expect(output.ok).toBe(false);
    expect(output.outcome).toBe("failed");
    expect(output.anyFailed).toBe(true);
    expect(output.allPassed).toBe(false);
  });

  it("keeps anyFailed false for the two states that verified nothing on purpose", () => {
    expect(
      repositoryScriptsOutput(
        engineResult({ outcome: "missing_configuration", summary: "none" }),
      ).anyFailed,
    ).toBe(false);
    expect(
      repositoryScriptsOutput(engineResult({ summary: "nothing matched" })).anyFailed,
    ).toBe(false);
  });

  it("publishes the per-command record a fix wire and a formatter commit need", () => {
    const output = repositoryScriptsOutput(
      engineResult({
        outcome: "failed",
        passed: false,
        results: ranOneCommand(),
        failures: [
          {
            provider: "github",
            repoPath: "acme/api",
            command: "pnpm test",
            exitCode: 1,
            stdout: "out",
            stderr: "err",
            note: "Exit code 1.",
          },
          {
            provider: "github",
            repoPath: "acme/api",
            command: "uv sync",
            exitCode: 127,
            stdout: "",
            stderr: "uv: not found",
            phase: "setup",
          },
        ],
        dirtied: [
          {
            provider: "github",
            repoPath: "acme/api",
            files: ["src/a.ts"],
            preExisting: ["src/b.ts"],
          },
        ],
        setupFailed: true,
        groupStatuses: [groupStatus("checks", "failed")],
      }),
    );

    expect(output.results).toEqual([ONE_COMMAND_RESULT]);
    expect(output.failures).toEqual([
      {
        repo: "github:acme/api",
        command: "pnpm test",
        exitCode: 1,
        // Bounded output, then the note on its own line.
        output: "err\nout\nExit code 1.",
        // null, not absent: an ordinary failing check, as opposed to one of the
        // phases that mean nothing could be checked.
        phase: null,
      },
      {
        repo: "github:acme/api",
        command: "uv sync",
        exitCode: 127,
        output: "uv: not found",
        phase: "setup",
      },
    ]);
    expect(output.dirtied).toEqual([
      { repo: "github:acme/api", files: ["src/a.ts"], preExisting: ["src/b.ts"] },
    ]);
    expect(output.setupFailed).toBe(true);
  });

  it("maps every outcome onto a status the registry actually declares", () => {
    expect(repositoryScriptsStatus({ ok: true, outcome: "passed" })).toBe("ok");
    // Never "failed": that word belongs to execution errors, and a failing
    // script run is an ordinary outcome carried by ok/outcome/anyFailed.
    expect(repositoryScriptsStatus({ ok: false, outcome: "failed" })).toBe("ok");
    expect(repositoryScriptsStatus({ ok: true, outcome: "skipped" })).toBe("skipped");
    expect(repositoryScriptsStatus({ ok: true, outcome: "missing_configuration" })).toBe(
      "skipped",
    );
  });

  it("produces output both script blocks' registry contracts accept", () => {
    const shared = repositoryScriptsOutput(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [groupStatus("checks", "passed")],
      }),
    );
    const status = repositoryScriptsStatus(shared);

    expectOutputConformsToRegistry(
      "run_scripts",
      { status, ...shared },
      { groups: ["checks"] },
    );
    expectOutputConformsToRegistry("run_pre_pr_checks", {
      status,
      ...shared,
      fixCycles: 0,
      gate: null,
    });
  });

  it("keeps the gate output recoverable by finalize and run_scripts out of it", async () => {
    const { recoverPrePrGateFromSteps } = await import("./blocks/finalize-workspace.js");
    const shared = repositoryScriptsOutput(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [groupStatus("checks", "passed")],
      }),
    );
    const gate = { configurationVersion: 7, fingerprint: "abc" };

    // The gate block still checkpoints outcome+gate, which is the pair
    // recoverPrePrGateFromSteps keys on.
    expect(
      recoverPrePrGateFromSteps({
        checks: {
          output: {
            status: repositoryScriptsStatus(shared),
            ...shared,
            fixCycles: 0,
            gate,
          },
        },
      }),
    ).toEqual(gate);

    // run_scripts carries an outcome too, so the only thing keeping it out of
    // gate recovery is that it emits no gate key at all.
    expect(
      recoverPrePrGateFromSteps({
        scripts: { output: { status: repositoryScriptsStatus(shared), ...shared } },
      }),
    ).toBeNull();
  });
});

/** run_scripts is v2-only, so its node cannot be built by makeNode's v1 type. */
function scriptsNode(groups: unknown): WorkflowDefinitionNode {
  return {
    id: "scripts",
    type: "run_scripts",
    x: 0,
    y: 0,
    params: { groups },
    inputs: {},
  } as unknown as WorkflowDefinitionNode;
}

describe("run_scripts executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks drops recorded calls but keeps implementations, and the
    // reporting-path cases above leave logger.error throwing on purpose. The
    // executor logs through it, so an inherited throw would surface here as
    // that suite's fixture error instead of this block's own failure.
    mocks.error.mockReset();
    mocks.loadPrePrCheckConfigStep.mockResolvedValue({
      version: 9,
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
    mocks.runPrePrChecksWithFixes.mockResolvedValue(
      engineResult({
        results: ranOneCommand(),
        groupStatuses: [groupStatus("test", "passed")],
        summary: "Repository scripts passed (1 command).",
      }),
    );
  });

  it("dispatches the authored groups to the engine as a named selection", async () => {
    const result = await executeRunScripts(scriptsNode(["test"]), {}, makeCtx());

    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx-1",
        groupSelection: { kind: "named", groups: ["test"] },
        observeBudget: expect.any(Function),
      }),
    );
    // Nothing about repair reaches the engine from this path.
    expect(mocks.runPrePrChecksWithFixes.mock.calls[0]?.[0]).not.toHaveProperty(
      "maxFixCycles",
    );
    expect(result.kind).toBe("next");
    expect(result.output).toEqual({
      status: "ok",
      ok: true,
      outcome: "passed",
      allPassed: true,
      anyFailed: false,
      groupStatuses: [groupStatus("test", "passed")],
      results: [ONE_COMMAND_RESULT],
      failures: [],
      dirtied: [],
      setupFailed: false,
      summary: "Repository scripts passed (1 command).",
    });
  });

  it("hands the raw stored configuration straight to the engine", async () => {
    await executeRunScripts(scriptsNode(["test"]), {}, makeCtx());

    // Not normalized on the way past: the engine parses it, because the gate
    // fingerprints the stored bytes.
    expect(mocks.runPrePrChecksWithFixes).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          repositories: [
            {
              provider: "github",
              repoPath: "acme/api",
              groups: { test: { commands: ["pnpm test"] } },
            },
          ],
        },
      }),
    );
  });

  it("returns a failing run as a branchable next, never an execution error", async () => {
    mocks.runPrePrChecksWithFixes.mockResolvedValue(
      engineResult({
        outcome: "failed",
        passed: false,
        results: ranOneCommand(),
        failures: [
          {
            provider: "github",
            repoPath: "acme/api",
            command: "pnpm test",
            exitCode: 1,
            stdout: "",
            stderr: "boom",
          },
        ],
        groupStatuses: [groupStatus("test", "failed")],
        summary: "1 script failed.",
      }),
    );

    const result = await executeRunScripts(scriptsNode(["test"]), {}, makeCtx());

    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("ok");
    expect(result.output!.ok).toBe(false);
    expect(result.output!.outcome).toBe("failed");
    expect(result.output!.anyFailed).toBe(true);
  });

  it("reports a run that matched nothing as a loud skip", async () => {
    mocks.runPrePrChecksWithFixes.mockResolvedValue(
      engineResult({
        summary: "No repository scripts matched changed repositories.",
        groupStatuses: [groupStatus("test", "skipped")],
      }),
    );

    // "nope" is declared by no repository, so it also lands as not_run below.
    const result = await executeRunScripts(scriptsNode(["nope"]), {}, makeCtx());

    expect(result.output!.status).toBe("skipped");
    expect(result.output!.outcome).toBe("skipped");
    expect(result.output!.summary).toBe(
      "No repository scripts matched changed repositories.",
    );
    expect(result.output!.groupStatuses).toContainEqual(groupStatus("nope", "not_run"));
  });

  it("surfaces a requested group the configuration does not declare", async () => {
    // The registry default is ["checks"], the group every legacy config
    // normalizes to. A tenant that authored only custom groups gets a node that
    // silently ran nothing, so the missing name has to be visible.
    mocks.runPrePrChecksWithFixes.mockResolvedValue(
      engineResult({
        summary: "No repository scripts matched the selected groups.",
        groupStatuses: [groupStatus("lint", "skipped")],
      }),
    );

    const result = await executeRunScripts(scriptsNode(["checks"]), {}, makeCtx());

    expect(result.output!.groupStatuses).toContainEqual(groupStatus("checks", "not_run"));
    expect(result.output!.allPassed).toBe(false);
    expect(result.output!.summary).toBe(
      "No repository scripts matched the selected groups.",
    );
  });

  it("never records or emits a workspace gate", async () => {
    const ctx = makeCtx({
      prePrGate: { configurationVersion: 3, fingerprint: "stale" },
    });

    const result = await executeRunScripts(scriptsNode(["test"]), {}, ctx);

    // The key is absent, not null: recoverPrePrGateFromSteps keys on the
    // outcome+gate pair, and this output carries an outcome.
    expect(result.output).not.toHaveProperty("gate");
    // Deliberately NOT invalidated. Nulling ctx.prePrGate would not durably
    // invalidate anything: finalize resolves it as
    // `ctx.prePrGate ?? recoverPrePrGateFromSteps(steps)`, so the checkpointed
    // gate is resurrected on the next read and the call would only imply a
    // protection that does not exist. A restoreTree:false group that runs after
    // a passed gate is caught by the publication fingerprint instead.
    expect(ctx.prePrGate).toEqual({ configurationVersion: 3, fingerprint: "stale" });
  });

  it("fails loudly when no workspace is attached", async () => {
    const result = await executeRunScripts(
      scriptsNode(["test"]),
      {},
      makeCtx({ sandboxId: null }),
    );

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("no workspace");
    }
    expect(mocks.runPrePrChecksWithFixes).not.toHaveBeenCalled();
  });

  it("names the cause when the engine throws instead of returning", async () => {
    mocks.runPrePrChecksWithFixes.mockRejectedValue(new Error("sandbox connection reset"));

    await expect(
      executeRunScripts(scriptsNode(["test"]), {}, makeCtx()),
    ).rejects.toThrow("sandbox connection reset");
  });

  it.each(blockRunControlErrorCases())(
    "rethrows %s untouched",
    async (_label, error) => {
      mocks.runPrePrChecksWithFixes.mockRejectedValue(error);

      await expect(
        executeRunScripts(scriptsNode(["test"]), {}, makeCtx()),
      ).rejects.toBe(error);
    },
  );
});

// AIW-309: the product knew which command failed and never said so. The engine
// publishes its per-command report on the block output; the run fails at a
// LATER node, and only a 600-character execution error message crosses that
// boundary. These pin what the one ticket comment carries instead.
const REASON =
  "The checks could not be started. (required checks not satisfied: checks) " +
  "Diagnostic ID: AIW-DIAG-wrun_01M0CBQNAX24STRMN5SGCKKGB2-finalize-1";

function scriptsSteps(
  output: Partial<ReturnType<typeof repositoryScriptsOutput>>,
): StepsRecord {
  return {
    prepare: { output: { status: "ok", sandboxId: "sbx-1" } },
    scripts: {
      output: {
        status: "ok",
        ok: false,
        outcome: "failed",
        allPassed: false,
        anyFailed: true,
        groupStatuses: [],
        results: [],
        failures: [],
        dirtied: [],
        setupFailed: false,
        summary: "",
        ...output,
      },
    },
  };
}

describe("repository scripts failure comment", () => {
  it("names the repository, the command, the exit code and the output tail", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          outcome: "failed",
          summary: "github:acme/web\nCommand: pnpm test",
          failures: [
            {
              repo: "github:acme/web",
              command: "pnpm test",
              exitCode: 1,
              output: "FAIL src/index.test.ts\n1 failed, 12 passed",
              phase: null,
            },
          ],
        }),
      ),
    );

    // The reason stays first and byte-for-byte: the run header, the run list
    // and Slack all carry that same string (AIW-254).
    expect(comment.startsWith(REASON)).toBe(true);
    expect(comment).toContain("Repository scripts failed.");
    expect(comment).toContain("github:acme/web: pnpm test (exit 1)");
    expect(comment).toContain("FAIL src/index.test.ts\n1 failed, 12 passed");
  });

  it("says nothing matched when the selection ran no commands", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          outcome: "skipped",
          ok: true,
          anyFailed: false,
          summary: "No repository scripts matched changed repositories.",
        }),
      ),
    );

    expect(comment).toContain(
      "0 commands executed - no entry matched the changed repositories.",
    );
    expect(comment).not.toContain("Repository scripts failed.");
  });

  it("names the phase and the command for scripts that never started", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          setupFailed: true,
          failures: [
            {
              repo: "gitlab:acme/engine",
              command: "uv sync",
              exitCode: 127,
              output: "uv: command not found",
              phase: "setup",
            },
          ],
        }),
      ),
    );

    expect(comment).toContain("Repository scripts could not be started.");
    expect(comment).toContain(
      "SETUP FAILED for gitlab:acme/engine: uv sync (exit 127)",
    );
    expect(comment).toContain("uv: command not found");
  });

  it("names the repositories an exhausted checks budget cost", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          failures: [
            {
              repo: "github:acme/api",
              command: "(checks budget)",
              exitCode: -1,
              output:
                "Nothing ran in 2 repositories (github:acme/api, github:acme/web): " +
                "this run's 60 minute checks budget was already spent by the " +
                "repositories before them.",
              phase: "budget",
            },
          ],
        }),
      ),
    );

    expect(comment).toContain("CHECKS BUDGET SPENT.");
    expect(comment).toContain(
      "CHECKS BUDGET SPENT before github:acme/api: (checks budget) (exit -1)",
    );
    expect(comment).toContain("github:acme/api, github:acme/web");
  });

  it("counts the failures it does not render", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          failures: Array.from({ length: 7 }, (_, index) => ({
            repo: "github:acme/web",
            command: `pnpm test:${index}`,
            exitCode: 1,
            output: "",
            phase: null,
          })),
        }),
      ),
    );

    expect(comment).toContain("pnpm test:4 (exit 1)");
    expect(comment).not.toContain("pnpm test:5");
    expect(comment).toContain("and 2 more failing commands not shown.");
  });

  it("says the repair loop is gone when the definition still asks for cycles", () => {
    const scripts = recoverLatestRepositoryScriptsFailureFromSteps(
      scriptsSteps({
        failures: [
          {
            repo: "github:acme/web",
            command: "pnpm test",
            exitCode: 1,
            output: "",
            phase: null,
          },
        ],
      }),
    );

    expect(
      repositoryScriptsFailureComment(REASON, scripts, {
        repairCyclesRequested: true,
      }),
    ).toContain(
      "This workflow definition still requests repair cycles (maxFixCycles), and " +
        "the repair loop was removed",
    );
    expect(repositoryScriptsFailureComment(REASON, scripts)).not.toContain(
      "maxFixCycles",
    );
  });

  it("posts the reason alone when no repository scripts output is recoverable", () => {
    expect(repositoryScriptsFailureComment(REASON, null)).toBe(REASON);
    expect(
      recoverLatestRepositoryScriptsFailureFromSteps({
        prepare: { output: { status: "ok", sandboxId: "sbx-1" } },
      }),
    ).toBeNull();
  });

  it("ignores a clean scripts run, so an unrelated failure keeps its own cause", () => {
    expect(
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          ok: true,
          outcome: "passed",
          allPassed: true,
          anyFailed: false,
          summary: "Repository scripts passed (3 commands).",
        }),
      ),
    ).toBeNull();
  });

  it("reports the last scripts run when a definition ran them more than once", () => {
    const base = scriptsSteps({}).scripts?.output ?? {};
    const steps: StepsRecord = {
      lint: {
        output: {
          ...base,
          outcome: "passed",
          ok: true,
          summary: "Repository scripts passed (1 command).",
        },
      },
      gate: {
        output: {
          ...base,
          summary: "github:acme/web",
          failures: [
            {
              repo: "github:acme/web",
              command: "pnpm test",
              exitCode: 2,
              output: "",
              phase: null,
            },
          ],
        },
      },
    };

    expect(recoverLatestRepositoryScriptsFailureFromSteps(steps)?.failures[0]).toEqual({
      repo: "github:acme/web",
      command: "pnpm test",
      exitCode: 2,
      output: "",
      phase: null,
    });
  });

  it("attaches the report only to a failure the scripts own", () => {
    // A run whose scripts failed can go on to fail somewhere else entirely, and
    // attaching the script report there would name the wrong cause.
    expect(isRepositoryScriptsFailurePhase("checks")).toBe(true);
    expect(isRepositoryScriptsFailurePhase("pre-pr-checks")).toBe(true);
    expect(isRepositoryScriptsFailurePhase("run_scripts")).toBe(true);
    expect(isRepositoryScriptsFailurePhase("planning")).toBe(false);
    expect(isRepositoryScriptsFailurePhase("push")).toBe(false);
  });

  it("posts the enriched comment and records the bare reason, from one failure exit", () => {
    // The composition above is pure and tested; this pins that the failure exit
    // actually uses it, and that it uses it for the ticket comment ALONE. The
    // run header, the run list and Slack read one bounded reason each and
    // AIW-254 pins all of them to the same string.
    const lines = readFileSync(
      fileURLToPath(new URL("./agent.ts", import.meta.url)),
      "utf8",
    ).split("\n");
    const index = lines.findIndex((line) =>
      line.includes("const failureExit = async ("),
    );
    expect(index, "failureExit moved out of agent.ts").toBeGreaterThan(-1);

    const body = lines.slice(index, index + 60).join("\n");
    expect(body).toContain("recordRunFailureReasonStep(workflowRunId, reason)");
    expect(body).toContain(
      "postFailureReasonCommentStep(ticket.identifier, comment, transitionOwner)",
    );
    // Exactly one comment call in the whole exit.
    expect(body.match(/postFailureReasonCommentStep\(/g)).toHaveLength(1);
  });

  it("sizes the restored clarification sandbox from the recovered checks ceiling", () => {
    // sandboxLifetimeMs is unit-tested; the COMPOSITION at this call site is
    // not, and it is the one that matters: the checks cap no longer consults
    // the run's duration, so a restore sized from the duration alone would kill
    // a resumed run's sandbox under a batch well inside its own bound and
    // report it as a lost workspace. Anchored on the restore call rather than
    // on an argument list, so reflowing the arguments does not fail it.
    const lines = readFileSync(
      fileURLToPath(new URL("./agent.ts", import.meta.url)),
      "utf8",
    ).split("\n");
    const index = lines.findIndex((line) =>
      line.includes("await restoreClarificationSandboxStep({"),
    );
    expect(
      index,
      "the clarification restore call moved out of agent.ts",
    ).toBeGreaterThan(-1);

    const call = lines.slice(index, index + 20).join("\n");
    expect(call).toContain("timeoutMs: sandboxLifetimeMs(");
    expect(call).toContain("restoreBudget.remainingDurationMs");
    expect(call).toContain("restoredCeilingMs");
  });

  it("always prints the engine's own summary, whatever class the lead announces", () => {
    // An unreadable configuration reports outcome "failed" with no failure
    // entries at all, and the field that broke is named ONLY in the summary.
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          outcome: "failed",
          failures: [],
          summary:
            "Repository scripts configuration could not be read: repositories[0].provider",
        }),
      ),
    );

    expect(comment).toContain("Repository scripts could not be started.");
    expect(comment).toContain("repositories[0].provider");
    // The one class that would tell the operator their selection was fine.
    expect(comment).not.toContain(
      "0 commands executed - no entry matched the changed repositories.",
    );
  });

  it("never renders a budget entry out of the window a flood of commands filled", () => {
    // Array order deciding whether the operator learns the budget ran out is a
    // coin toss, and six failing commands ahead of it wins the toss.
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          failures: [
            ...Array.from({ length: 6 }, (_, index) => ({
              repo: "github:acme/web",
              command: `pnpm test:${index}`,
              exitCode: 1,
              output: "",
              phase: null,
            })),
            {
              repo: "github:acme/api",
              command: "(checks budget)",
              exitCode: -1,
              output: "Nothing ran in 1 repository (github:acme/api).",
              phase: "budget",
            },
          ],
        }),
      ),
    );

    expect(comment).toContain(
      "CHECKS BUDGET SPENT before github:acme/api: (checks budget) (exit -1)",
    );
    expect(comment).toContain("and 1 more failing command not shown.");
    // The window still bounds the ordinary commands it was there to bound.
    expect(comment).not.toContain("pnpm test:5");
  });

  it("says where the failures it left out can still be read", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          failures: Array.from({ length: 7 }, (_, index) => ({
            repo: "github:acme/web",
            command: `pnpm test:${index}`,
            exitCode: 1,
            output: "",
            phase: null,
          })),
        }),
      ),
    );

    expect(comment).toContain(
      "The full list is on the scripts block's `failures` output, in the run details view.",
    );
  });

  it("names the files the scripts left behind and the ones already there", () => {
    const comment = repositoryScriptsFailureComment(
      REASON,
      recoverLatestRepositoryScriptsFailureFromSteps(
        scriptsSteps({
          failures: [],
          summary: "Repository scripts passed (2 commands).",
          dirtied: [
            {
              repo: "github:acme/web",
              files: ["src/a.ts", "src/b.ts"],
              preExisting: ["docs/notes.md"],
            },
          ],
        }),
      ),
    );

    expect(comment).toContain(
      "Repository scripts modified in github:acme/web: src/a.ts, src/b.ts",
    );
    expect(comment).toContain(
      "Already modified before the scripts ran in github:acme/web: docs/notes.md",
    );
  });

  it("still names the drift on a run whose scripts all passed", () => {
    // A group configured with restoreTree false leaves files behind on a green
    // run, and that is exactly the run the publication boundary then refuses:
    // there is no failure entry anywhere to hang the paths on.
    const comment = repositoryScriptsFailureComment(REASON, null, {
      drift: [{ repo: "github:acme/web", files: ["src/a.ts"], preExisting: [] }],
    });

    expect(comment.startsWith(REASON)).toBe(true);
    expect(comment).toContain(
      "Repository scripts modified in github:acme/web: src/a.ts",
    );
  });

  it("says the definition can never mint the gate it is being failed for", () => {
    const comment = repositoryScriptsFailureComment(REASON, null, {
      noGateBlock: true,
    });

    expect(comment).toContain(
      "only run_pre_pr_checks, and a run_checks left on its default configured " +
        "selection, record the gate the publication boundary requires",
    );
    expect(repositoryScriptsFailureComment(REASON, null)).not.toContain(
      "record the gate the publication boundary",
    );
  });

  it("wires the no-gate note to the reason and the definition, not to a guess", () => {
    const lines = readFileSync(
      fileURLToPath(new URL("./agent.ts", import.meta.url)),
      "utf8",
    ).split("\n");
    const index = lines.findIndex((line) =>
      line.includes("const comment = repositoryScriptsFailureComment("),
    );
    expect(
      index,
      "the comment composition moved out of failureExit",
    ).toBeGreaterThan(-1);

    const call = lines.slice(index, index + 24).join("\n");
    expect(call).toContain("reason.includes(WORKSPACE_GATE_NOT_RECORDED_PREFIX)");
    expect(call).toContain("plan.nodes.some(nodeCanRecordGate)");
    expect(call).toContain("recoverScriptDriftFromSteps(steps)");
  });

  it("reads gate capability off the node's own selection, not off its type", () => {
    // run_checks records a gate ONLY on its default configured path. Keying on
    // the type alone traded one falsehood for a narrower silence: the author of
    // a run_checks(groups) graph got no note at all, on the run that failed for
    // exactly the reason the note explains.
    expect(nodeCanRecordGate({ type: "run_pre_pr_checks", params: {} })).toBe(true);
    expect(nodeCanRecordGate({ type: "run_checks", params: {} })).toBe(true);
    expect(nodeCanRecordGate({ type: "run_checks", params: { groups: [] } })).toBe(true);

    // A node that ran only `lint` never established what the gate claims.
    expect(
      nodeCanRecordGate({ type: "run_checks", params: { groups: ["lint"] } }),
    ).toBe(false);
    // An explicit list produces no configuration version to record against.
    expect(
      nodeCanRecordGate({ type: "run_checks", params: { commands: ["pnpm test"] } }),
    ).toBe(false);
    // A skipped node returns before any of it.
    expect(
      nodeCanRecordGate({ type: "run_checks", params: { skipReason: "not now" } }),
    ).toBe(false);

    expect(nodeCanRecordGate({ type: "run_scripts", params: {} })).toBe(false);
    expect(nodeCanRecordGate({ type: "generic_agent", params: {} })).toBe(false);
  });

  it("notes the missing gate for a definition whose only checks node is narrowed", () => {
    const nodes = [{ type: "run_checks", params: { groups: ["lint"] } }];
    expect(nodes.some(nodeCanRecordGate)).toBe(false);

    expect(
      repositoryScriptsFailureComment(REASON, null, {
        noGateBlock: !nodes.some(nodeCanRecordGate),
      }),
    ).toContain("record the gate the publication boundary requires");

    // The same graph with the selection removed can mint one, so it gets no
    // note: its gate is missing for some other reason and this sentence would
    // send the reader to rebuild a graph that is already correct.
    const defaulted = [{ type: "run_checks", params: {} }];
    expect(
      repositoryScriptsFailureComment(REASON, null, {
        noGateBlock: !defaulted.some(nodeCanRecordGate),
      }),
    ).not.toContain("record the gate the publication boundary");
  });

  it("attaches no evidence from a scripts run a later block already superseded", () => {
    // The recovery is LATEST-recorded, not latest-failing, and that is the
    // point: a first selection that failed and a second that passed leaves a
    // run whose scripts are fine, and hanging the first one's commands on an
    // unrelated later failure would name the wrong cause.
    const base = scriptsSteps({}).scripts?.output ?? {};
    const steps: StepsRecord = {
      first: {
        output: {
          ...base,
          failures: [
            {
              repo: "github:acme/web",
              command: "pnpm test",
              exitCode: 1,
              output: "stale",
              phase: null,
            },
          ],
        },
      },
      second: {
        output: {
          ...base,
          ok: true,
          outcome: "passed",
          allPassed: true,
          anyFailed: false,
          failures: [],
          summary: "Repository scripts passed (1 command).",
        },
      },
    };

    expect(recoverLatestRepositoryScriptsFailureFromSteps(steps)).toBeNull();
    expect(
      repositoryScriptsFailureComment(
        REASON,
        recoverLatestRepositoryScriptsFailureFromSteps(steps),
      ),
    ).toBe(REASON);
  });

  it("reads maxFixCycles off the definition, which is the only thing that remembers it", () => {
    expect(definitionRequestsRepairCycles([{ params: { maxFixCycles: 3 } }])).toBe(
      true,
    );
    expect(
      definitionRequestsRepairCycles([
        { params: {} },
        { params: { maxFixCycles: 0 } },
      ]),
    ).toBe(false);
  });
});

describe("v2 terminal failure exit", () => {
  /**
   * The three expressions the v2 call site composes, in the order it composes
   * them. This is deliberately not a helper in agent.ts: what the gate found
   * broken was the composition, and a helper would only move the same three
   * calls somewhere a test could not tell them apart from production.
   */
  function commentForWalk(walk: {
    executionError?: WorkflowExecutionErrorState;
    steps: StepsRecord;
  }): string {
    const error = walk.executionError;
    if (!error) throw new Error("the walk did not fail");
    const phase = failureExitPhase(error);
    return repositoryScriptsFailureComment(
      formatExecutionErrorForUser(error),
      isRepositoryScriptsFailurePhase(phase)
        ? recoverLatestRepositoryScriptsFailureFromSteps(walk.steps)
        : null,
    );
  }

  function v2Node(
    id: string,
    type: WorkflowBlockType,
  ): WorkflowDefinitionV2Node {
    return { id, type, x: 0, y: 0, configuration: {}, inputs: {}, additionalInputs: [] };
  }

  const definition: WorkflowDefinitionV2 = {
    schemaVersion: 2,
    nodes: [
      v2Node("trigger", "trigger_ticket_ai"),
      v2Node("scripts", "run_pre_pr_checks"),
      v2Node("finalize", "finalize_workspace"),
    ],
    edges: [
      { id: "trigger-scripts", from: "trigger", to: "scripts" },
      { id: "scripts-finalize", from: "scripts", to: "finalize" },
    ],
  };

  const failingScripts = repositoryScriptsOutput(
    engineResult({
      outcome: "failed",
      passed: false,
      results: [
        {
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm test",
          exitCode: 1,
          group: "checks",
          durationMs: 1_200,
          timedOut: false,
        },
      ],
      failures: [
        {
          provider: "github",
          repoPath: "acme/web",
          command: "pnpm test",
          exitCode: 1,
          stdout: "FAIL src/index.test.ts",
          stderr: "",
        },
      ],
      summary: "github:acme/web\nCommand: pnpm test",
    }),
  );

  async function walkFailingAtFinalize() {
    return executeV2Graph({
      definition,
      entryTriggerId: "trigger",
      triggerOutput: { status: "fired" },
      executeBlock: async (current) => {
        if (current.id === "scripts") {
          return {
            kind: "next",
            output: {
              status: repositoryScriptsStatus(failingScripts),
              ...failingScripts,
              fixCycles: 0,
              gate: null,
            },
          };
        }
        // Exactly what blocks/finalize-workspace.ts returns for unmet checks:
        // the category is "checks" and there is NO phase, which is the whole
        // reason the fallback in failureExitPhase exists.
        return executionError("required checks not satisfied: checks", {
          category: "checks",
        });
      },
    });
  }

  it("carries the repository, command and exit code out of a real v2 walk", async () => {
    // AIW-309's headline case runs on schemaVersion 2, and this used to land on
    // a "workflow" phase that matched nothing, so the operator got the bare
    // 600-character reason and none of the evidence sitting in the walk.
    const walk = await walkFailingAtFinalize();

    expect(walk.outcome).toBe("failed");
    expect(walk.executionError?.phase).toBeUndefined();
    expect(failureExitPhase(walk.executionError!)).toBe("checks");

    const comment = commentForWalk(walk);
    expect(comment).toContain("Repository scripts failed.");
    expect(comment).toContain("github:acme/web: pnpm test (exit 1)");
    expect(comment).toContain("FAIL src/index.test.ts");
  });

  it("keeps the reason first and byte-for-byte, whatever it appends", async () => {
    const walk = await walkFailingAtFinalize();
    const reason = formatExecutionErrorForUser(walk.executionError!);

    expect(commentForWalk(walk).startsWith(reason)).toBe(true);
  });

  it("prefers a phase the block did name over the category", () => {
    expect(failureExitPhase({ phase: "push", category: "provider" })).toBe(
      "push",
    );
    expect(failureExitPhase({ category: "checks" })).toBe("checks");
    // Only a state with neither falls through, and nothing downstream reads it
    // as a scripts failure.
    expect(failureExitPhase({} as never)).toBe("workflow");
    expect(isRepositoryScriptsFailurePhase("workflow")).toBe(false);
  });

  it("pins the v2 call site to the phase helper and to the walk's steps", () => {
    const lines = readFileSync(
      fileURLToPath(new URL("./agent.ts", import.meta.url)),
      "utf8",
    ).split("\n");
    const index = lines.findIndex((line) =>
      line.includes("terminalExecutionError && plan.schemaVersion === 2"),
    );
    expect(index, "the v2 terminal failure exit moved out of agent.ts").toBeGreaterThan(-1);

    const call = lines.slice(index, index + 10).join("\n");
    expect(call).toContain("failureExitPhase(terminalExecutionError)");
    expect(call).toContain("walk.steps");
  });
});
