import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { WorkflowRunFailedError } from "workflow/errors";
import { parseStepName } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import { ACTIVE_RUN_OWNER_ERROR_SENTINEL } from "../src/lib/run-control-errors.js";
import {
  probeRunControlStepBoundary,
  probeStickyExecutionFailure,
} from "../workflow-test-fixtures/run-control/workflow.js";

describe("installed Workflow step failure boundary", () => {
  it.each(["owner_no_retries", "owner_default_retries"] as const)(
    "replays %s owner loss once as a terminal FatalError",
    async (kind) => {
      const run = await start(probeRunControlStepBoundary, [kind]);
      const result = await run.returnValue;

      expect(result).toMatchObject({
        name: "FatalError",
        isRunControl: true,
        budgetFailure: null,
        hasFailureProperty: false,
      });
      expect(result.message).toBe(`${ACTIVE_RUN_OWNER_ERROR_SENTINEL} attempt=1`);
    },
  );

  it("drops a custom budget field at the SDK step event boundary but remains terminal", async () => {
    const run = await start(probeRunControlStepBoundary, ["budget_no_retries"]);
    const result = await run.returnValue;

    expect(result).toMatchObject({
      name: "FatalError",
      isRunControl: true,
      budgetFailure: null,
      hasFailureProperty: false,
    });
    expect(result.message).toContain("failed after 0 retries: budget exceeded");
  });

  it("retries an ordinary step failure through the SDK default", async () => {
    const run = await start(probeRunControlStepBoundary, [
      "ordinary_default_retries",
    ]);
    const result = await run.returnValue;

    expect(result).toMatchObject({
      name: "FatalError",
      isRunControl: false,
      budgetFailure: null,
      hasFailureProperty: false,
    });
    expect(result.message).toContain(
      "failed after 3 retries: ordinary failure attempt=4",
    );
  });

  it("completes cleanup before reporting a safe failed workflow trace", async () => {
    const run = await start(probeStickyExecutionFailure, []);

    let failure: unknown;
    try {
      await run.returnValue;
    } catch (error) {
      failure = error;
    }

    expect(WorkflowRunFailedError.is(failure)).toBe(true);
    if (!WorkflowRunFailedError.is(failure)) throw failure;
    expect(failure.cause.message).toBe(
      "An external service could not complete this block. Diagnostic ID: AIW-DIAG-sdk-run-provider-1",
    );
    // The Workflow SDK owns this classification code. The application-level
    // diagnostic code remains in the safe message and is recovered by the run
    // detail collector rather than exposing this SDK stack to the dashboard.
    expect(failure.cause.code).toBe("USER_ERROR");
    expect(JSON.stringify(failure.cause)).not.toContain("provider secret detail");
    expect(await run.status).toBe("failed");

    const steps = await getWorld().steps.list({
      runId: run.runId,
      resolveData: "none",
    });
    const cleanup = steps.data.find(
      (step) => parseStepName(step.stepName)?.shortName === "deterministicCleanupStep",
    );
    expect(cleanup?.status).toBe("completed");
  });
});
