import { describe, expect, it } from "vitest";
import { FatalError } from "workflow";
import { WorkflowRunCancelledError } from "workflow/errors";
import { ActiveRunOwnerError } from "../lib/active-run-owner.js";
import { ACTIVE_RUN_OWNER_ERROR_SENTINEL } from "../lib/run-control-errors.js";
import {
  isRunBudgetError,
  RunBudgetError,
  runBudgetFailureFromError,
  type RunBudgetFailure,
} from "./run-budget.js";
import { isRunControlError } from "./run-control-error.js";

function serializedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function replayedStepFailure(original: Error, wrapAfterRetries = true): FatalError {
  const message = wrapAfterRetries
    ? `Step "step//workflows/agent.ts//observeBudgetStep" failed after 0 retries: ${original.message}`
    : original.message;
  const error = new FatalError(message);
  error.stack = original.stack;
  return error;
}

describe("isRunControlError", () => {
  it.each([
    [
      "a live budget error",
      new RunBudgetError({
        status: "budget_exceeded",
        metric: "tokens",
        limit: 10,
        consumed: 11,
        reason: "budget exceeded",
      }),
    ],
    ["a serialized budget error", serializedError("RunBudgetError", "budget exceeded")],
    ["a live exact-owner error", new ActiveRunOwnerError()],
    [
      "a serialized exact-owner error",
      serializedError(
        "ActiveRunOwnerError",
        "Provider mutation requires the exact active run owner.",
      ),
    ],
    ["a live Workflow cancellation", new WorkflowRunCancelledError("wrun-1")],
    [
      "a serialized Workflow cancellation",
      serializedError("WorkflowRunCancelledError", 'Workflow run "wrun-1" cancelled'),
    ],
  ])("classifies %s", (_label, error) => {
    expect(isRunControlError(error)).toBe(true);
  });

  it.each([
    ["an ordinary provider error", new Error("provider rejected the request")],
    ["a generic AbortError", serializedError("AbortError", "request aborted")],
    ["a message-only cancellation", new Error("workflow cancelled")],
  ])("does not classify %s", (_label, error) => {
    expect(isRunControlError(error)).toBe(false);
  });

  it("keeps name-only serialized budget errors terminal without inventing metadata", () => {
    const error = serializedError("RunBudgetError", "budget exceeded");

    expect(isRunControlError(error)).toBe(true);
    expect(isRunBudgetError(error)).toBe(false);
    expect(runBudgetFailureFromError(error)).toBeNull();
  });

  it("keeps validated budget metadata on a live workflow error", () => {
    const failure: RunBudgetFailure = {
      status: "budget_exceeded",
      metric: "tokens",
      limit: 10,
      consumed: 11,
      reason: "budget exceeded",
    };
    const original = new RunBudgetError(failure);

    expect(isRunControlError(original)).toBe(true);
    expect(isRunBudgetError(original)).toBe(true);
    expect(runBudgetFailureFromError(original)).toEqual(failure);
  });

  it("keeps a Workflow-replayed budget failure terminal without inventing metadata", () => {
    const original = new RunBudgetError({
      status: "budget_exceeded",
      metric: "tokens",
      limit: 10,
      consumed: 11,
      reason: "budget exceeded",
    });
    const rehydrated = replayedStepFailure(original);

    expect(rehydrated).toBeInstanceOf(FatalError);
    expect(isRunControlError(rehydrated)).toBe(true);
    expect(isRunBudgetError(rehydrated)).toBe(false);
    expect(runBudgetFailureFromError(rehydrated)).toBeNull();
  });

  it("classifies exact-owner failures replayed by Workflow as FatalError", () => {
    const original = new ActiveRunOwnerError("owner changed");
    const rehydrated = replayedStepFailure(original, false);

    expect(original).toBeInstanceOf(ActiveRunOwnerError);
    expect(FatalError.is(original)).toBe(true);
    expect(original.name).toBe("FatalError");
    expect(rehydrated.message).toBe(original.message);
    expect(rehydrated.message).toContain(ACTIVE_RUN_OWNER_ERROR_SENTINEL);
    expect(isRunControlError(rehydrated)).toBe(true);
  });

  it("does not trust the owner sentinel or legacy stack on an ordinary error", () => {
    const messageForgery = new Error(`${ACTIVE_RUN_OWNER_ERROR_SENTINEL} forged`);
    const misplacedSentinel = new FatalError(
      `provider failed: ${ACTIVE_RUN_OWNER_ERROR_SENTINEL} forged`,
    );
    const stackForgery = new Error("provider failed");
    stackForgery.stack = "ActiveRunOwnerError: forged\n    at provider";

    expect(isRunControlError(messageForgery)).toBe(false);
    expect(isRunControlError(misplacedSentinel)).toBe(false);
    expect(isRunControlError(stackForgery)).toBe(false);
  });

  it("does not classify a name-only object as a legacy exact-owner error", () => {
    expect(isRunControlError({ name: "ActiveRunOwnerError" })).toBe(false);
  });

  it("rejects malformed serialized budget metadata", () => {
    const error = Object.assign(serializedError("RunBudgetError", "budget exceeded"), {
      failure: {
        status: "budget_exceeded",
        metric: "tokens",
        limit: 10,
        consumed: null,
        reason: "budget exceeded",
      },
    });

    expect(isRunControlError(error)).toBe(true);
    expect(isRunBudgetError(error)).toBe(false);
    expect(runBudgetFailureFromError(error)).toBeNull();
  });
});
