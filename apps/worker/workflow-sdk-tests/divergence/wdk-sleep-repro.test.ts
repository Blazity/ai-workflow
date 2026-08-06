import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import {
  probeConcurrentSleep,
  type ConcurrentSleepInput,
} from "../../workflow-test-fixtures/wdk-sleep-repro/workflow.js";

// The standalone reproduction to attach to an upstream report. It depends on
// nothing but the "workflow" package: no scheduler, no graph, no contracts.
// See the fixture for the diagnosis.
//
// Manual dispatch only, like the rest of this directory. See
// wdk-wait-divergence.test.ts for what the suite is for, when to run it, and what
// a failure means. The single-branch and step-based rows travel with the pinned
// row on purpose: they are its controls, and a pinned failure is meaningless
// without them.

function input(
  overrides: Partial<ConcurrentSleepInput> = {},
): ConcurrentSleepInput {
  return {
    branches: 3,
    ticks: 6,
    tickMs: 40,
    workUnits: [0, 250_000, 1_500_000],
    tickKind: "wait",
    ...overrides,
  };
}

async function failureTextOf(run: {
  returnValue: Promise<unknown>;
}): Promise<string> {
  try {
    await run.returnValue;
  } catch (error) {
    return [
      error instanceof Error ? error.message : String(error),
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : "",
    ].join("\n");
  }
  return "";
}

describe("Workflow sleep() replay divergence with concurrent branches", () => {
  it("PINNED FAILING: three branches sleeping concurrently corrupt the event log", async () => {
    const run = await start(probeConcurrentSleep, [input()]);
    const text = await failureTextOf(run);
    expect(text).toContain("Workflow replay diverged");
    expect(text).toContain("Replay divergence: wait_completed event");
    expect(text).toContain("but the current wait consumer expects");
  }, 120_000);

  it("completes with a single branch sleeping", async () => {
    const run = await start(probeConcurrentSleep, [
      input({ branches: 1, workUnits: [1_500_000] }),
    ]);
    await expect(run.returnValue).resolves.toMatchObject({ branches: 1 });
  }, 120_000);

  it("completes with three branches when the tick is a step instead of a wait", async () => {
    const run = await start(probeConcurrentSleep, [input({ tickKind: "step" })]);
    await expect(run.returnValue).resolves.toMatchObject({ branches: 3 });
  }, 120_000);
});
