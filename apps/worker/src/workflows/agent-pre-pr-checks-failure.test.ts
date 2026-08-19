import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrePrCheckConfig: vi.fn(),
  runPrePrChecksWithFixes: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../pre-pr-checks/store.js", () => ({
  getCurrentPrePrCheckConfig: (...args: any[]) =>
    mocks.getCurrentPrePrCheckConfig(...args),
}));
vi.mock("../pre-pr-checks/runner.js", () => ({
  runPrePrChecksWithFixes: (...args: any[]) =>
    mocks.runPrePrChecksWithFixes(...args),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));
vi.mock("../../env.js", () => ({
  env: { DASHBOARD_ORIGIN: "https://dashboard.example.com" },
}));

import {
  PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
  PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH,
  prePrChecksFailureMustPropagate,
  prePrChecksFailureReport,
  runPrePrChecksStep,
} from "./agent.js";
import { isDurationAbortError } from "./run-budget.js";
import { isRunControlError } from "./run-control-error.js";
import { runControlErrorCases } from "./blocks/test-support.js";

const MESSAGE_LEAD = "The Pre-PR checks step failed: ";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function runStep() {
  return runPrePrChecksStep("sbx-test-123", "codex", "gpt-5");
}

describe("pre-PR checks step failure cause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrePrCheckConfig.mockResolvedValue({
      version: 7,
      config: { repositories: [] },
    });
  });

  it("returns the checks result and the loaded version when nothing throws", async () => {
    mocks.runPrePrChecksWithFixes.mockResolvedValue({
      outcome: "passed",
      passed: true,
      fixCycles: 0,
      fixCycleUsages: [],
      budgetFailure: null,
      summary: "All checks passed.",
    });

    await expect(runStep()).resolves.toEqual({
      outcome: "passed",
      passed: true,
      fixCycles: 0,
      fixCycleUsages: [],
      budgetFailure: null,
      summary: "All checks passed.",
      configurationVersion: 7,
    });
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("names the thrown cause instead of leaving Workflow's wrapper to speak alone", async () => {
    // Production runs wrun_01M0CBQNAX24STRMN5SGCKKGB2 and
    // wrun_01M0CAZKV3YMNFBCZJA8MT95GW died here reading only "exceeded max
    // retries", with no sanitized output captured and nothing in the runtime
    // logs. Whatever the step throws has to reach the operator-facing text.
    mocks.runPrePrChecksWithFixes.mockRejectedValue(
      new Error("sandbox connection reset"),
    );

    await expect(runStep()).rejects.toThrow(
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

  it("prefers a system error code over a class name that says nothing", async () => {
    mocks.runPrePrChecksWithFixes.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    );

    await expect(runStep()).rejects.toThrow(
      `${MESSAGE_LEAD}ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443`,
    );
  });

  it("bounds a runaway cause instead of embedding it whole", async () => {
    const thrownMessage = "sandbox refused the launch. ".repeat(200);
    mocks.runPrePrChecksWithFixes.mockRejectedValue(new Error(thrownMessage));

    const thrown = await runStep().then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(thrown?.message).toContain(MESSAGE_LEAD);
    expect(thrown?.message).not.toContain(thrownMessage);
    // Sentence plus the bound the cause is clamped to, and nothing more, so a
    // runaway error text cannot become the run status.
    expect(thrown?.message.length).toBeLessThanOrEqual(
      MESSAGE_LEAD.length + PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
    );
    const logged = mocks.error.mock.calls[0]?.[0] as { cause: string };
    expect(logged.cause.length).toBe(PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH);
  });

  it.each(runControlErrorCases())(
    "rethrows %s untouched so the call site still recognizes it",
    async (_label, error) => {
      mocks.runPrePrChecksWithFixes.mockRejectedValue(error);

      await expect(runStep()).rejects.toBe(error);
      const thrown = await runStep().then(
        () => null,
        (err: unknown) => err,
      );
      expect(isRunControlError(thrown)).toBe(true);
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it.each([["AbortError"], ["TimeoutError"]])(
    "rethrows a %s untouched so the duration budget stop survives",
    async (name) => {
      const error = namedError(name, "The operation was aborted.");
      mocks.runPrePrChecksWithFixes.mockRejectedValue(error);

      await expect(runStep()).rejects.toBe(error);
      const thrown = await runStep().then(
        () => null,
        (err: unknown) => err,
      );
      expect(isDurationAbortError(thrown)).toBe(true);
      expect(mocks.error).not.toHaveBeenCalled();
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
      prePrChecksFailureReport(budgetStop, identity).message,
    );
    expect(isRunControlError(rewrappedBudget)).toBe(false);
    const rewrappedAbort = new Error(
      prePrChecksFailureReport(abort, identity).message,
    );
    expect(isDurationAbortError(rewrappedAbort)).toBe(false);
  });

  it("redacts the cause and the stack tail through the caller's redactor", () => {
    const report = prePrChecksFailureReport(
      new Error("auth failed for token=abcd1234"),
      (value) => value.replace("abcd1234", "[REDACTED]"),
    );

    expect(report.cause).toBe("auth failed for token=[REDACTED]");
    expect(report.stackTail).not.toContain("abcd1234");
  });

  it("names a non-Error throw rather than dropping it", () => {
    const report = prePrChecksFailureReport("sandbox vanished", (v) => v);

    expect(report.message).toBe(`${MESSAGE_LEAD}sandbox vanished`);
    expect(report.name).toBe("string");
    expect(report.stackTail).toBe("");
  });
});
