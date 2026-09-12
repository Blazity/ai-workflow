import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import { createWorkflowExecutionErrorState } from "./execution-error.js";

describe("execution error state", () => {
  it("derives the diagnostic id from the run, the node and the attempt", () => {
    expect(
      createWorkflowExecutionErrorState("run-1", "block-a", 2, {
        category: "engine",
        message: "The workflow engine could not continue.",
      }),
    ).toEqual({
      category: "engine",
      message: "The workflow engine could not continue.",
      diagnosticId: "AIW-DIAG-run-1-block-a-2",
      nodeId: "block-a",
      attempt: 2,
    });
  });

  it("carries the phase when the error names one", () => {
    expect(
      createWorkflowExecutionErrorState("run-1", "block-a", 1, {
        category: "provider",
        message: "An external service could not complete this block.",
        phase: "implementation",
      }),
    ).toMatchObject({ phase: "implementation" });
  });

  it("keeps the raw detail out of the recorded state", () => {
    expect(
      createWorkflowExecutionErrorState("run-1", "block-a", 1, {
        category: "provider",
        message: "An external service could not complete this block.",
        detail: "402 insufficient credits for account acct_42",
      }),
    ).not.toHaveProperty("detail");
  });
});
