import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));
// The real redactor reads process.env to find the secrets it blanks, which
// makes its output depend on the machine running the suite. Redaction itself
// is pinned below against an injected redactor.
vi.mock("../sandbox/agents/protocol.js", () => ({
  redactDiagnosticText: (value: string) => value,
}));
vi.mock("../../env.js", () => ({
  env: { DASHBOARD_ORIGIN: "https://dashboard.example.com" },
}));

import {
  PRE_PR_CHECKS_FAILURE_CAUSE_MAX_LENGTH,
  PRE_PR_CHECKS_FAILURE_STACK_TAIL_MAX_LENGTH,
  describePrePrChecksFailureStep,
  prePrChecksFailureInput,
  prePrChecksFailureMustPropagate,
  prePrChecksFailureReport,
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

  it("prefers a system error code over a class name that says nothing", async () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
      code: "ECONNREFUSED",
    });

    await expect(describe_(error)).resolves.toBe(
      `${MESSAGE_LEAD}ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443`,
    );
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
});
