import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { ACTIVE_RUN_OWNER_ERROR_SENTINEL } from "../src/lib/run-control-errors.js";
import { probeRunControlStepBoundary } from "../workflow-test-fixtures/run-control/workflow.js";

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
});
