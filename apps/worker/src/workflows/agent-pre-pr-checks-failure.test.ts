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
  describePrePrChecksFailureStep,
  prePrChecksFailureInput,
  prePrChecksFailureMustPropagate,
  prePrChecksFailureReport,
  executeRunScripts,
  repositoryScriptsOutput,
  repositoryScriptsStatus,
} from "./agent.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  runControlErrorCases as blockRunControlErrorCases,
} from "./blocks/test-support.js";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import type { PrePrCheckRunResult } from "../pre-pr-checks/runner.js";
import { isDurationAbortError } from "./run-budget.js";
import { isRunControlError } from "./run-control-error.js";
import { runControlErrorCases } from "./blocks/test-support.js";

const MESSAGE_LEAD = "The Pre-PR checks step failed: ";

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
      "The Pre-PR checks step failed (SandboxError), and the cause could not be recorded.",
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
