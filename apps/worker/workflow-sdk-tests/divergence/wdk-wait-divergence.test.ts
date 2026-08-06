import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import {
  probeV2SharedBudgetGate,
  type ProbeSharedBudgetInput,
} from "../../workflow-test-fixtures/v2-concurrent/workflow.js";

/**
 * WHAT THIS SUITE IS FOR
 *
 * It pins a defect in the Workflow DevKit, not in code we own: a Workflow sleep()
 * wait cannot survive replay once two blocks of one run poll concurrently.
 * createSleep seeds the wait's expected resumeAt from Date.now() at call time and
 * corrects it only if the same consumer also consumes its own wait_created event.
 * Under concurrency the events drain can pass that wait_created before the owning
 * block's continuation has reinstalled its consumer, so the expectation stays a
 * wall-clock value that can never match the recording, and the run dies with a
 * replay divergence and then CORRUPTED_EVENT_LOG.
 *
 * Every row here therefore ASSERTS THE FAILURE. They are the reason
 * src/workflows/blocks/poll-delay.ts makes the agent poll tick a sleeping step
 * instead of a wait.
 *
 * WHY IT IS NOT IN THE DEFAULT RUN
 *
 * Each row deliberately drives four replay divergences through the runtime's three
 * recovery replays, and the serial baselines walk a full multi-block poll loop in
 * real time. Together they are most of the wall clock of the durable-workflow
 * tests, and they guard someone else's code, so they do not belong in the budget
 * of every pull request. What guards OUR fix is fast and stays in
 * test:workflow-sdk: the two "tick is a step" rows in v2-concurrent.test.ts.
 *
 * HOW TO RUN IT
 *
 *   pnpm --filter worker test:workflow-sdk-divergence
 *
 * or the "Workflow SDK divergence" workflow in GitHub Actions, which is manual
 * dispatch only. Run it when upgrading the workflow package, and periodically:
 * this is the tripwire for the upstream fix landing.
 *
 * WHAT A FAILURE HERE MEANS
 *
 * Not a regression in this repository. Either
 *   (a) the SDK fixed the defect, which is good news: poll-delay.ts can go back to
 *       a plain sleep(), these pins can be deleted, and the held-invocation cost
 *       documented in poll-delay.ts goes away; or
 *   (b) the SDK changed how it drains events, so the reproduction no longer
 *       provokes it while the underlying hazard may still exist.
 * Tell them apart by running the standalone reproduction in
 * divergence/wdk-sleep-repro.test.ts, which depends on nothing but the workflow
 * package, before concluding anything.
 */

/**
 * Asserts the run died the way AIW-233 dies in production: a replay divergence the
 * runtime retried and then gave up on as a corrupted event log.
 */
async function expectCorruptedEventLog(run: {
  returnValue: Promise<unknown>;
}): Promise<void> {
  let failure: unknown;
  try {
    await run.returnValue;
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    throw new Error(
      "expected the run to fail with a replay divergence, but it completed",
    );
  }
  const text = [
    failure instanceof Error ? failure.message : String(failure),
    failure instanceof Error && failure.cause instanceof Error
      ? failure.cause.message
      : "",
  ].join("\n");
  expect(text).toContain("Workflow replay diverged");
  expect(text).toContain("Replay divergence");
}

describe("Workflow sleep() cannot replay under concurrency", () => {
  // Three concurrent blocks, NO successors, so the scheduler's join is out of the
  // picture and the only variable is what the poll tick suspends on. The loop is a
  // faithful copy of blocks/poll-phase.ts against a faithful copy of agent.ts's
  // observeBudgetAtBoundary.
  function sharedInput(
    overrides: Partial<ProbeSharedBudgetInput> = {},
  ): ProbeSharedBudgetInput {
    return {
      runId: `probe-budget-${randomUUID()}`,
      maxConcurrency: 3,
      limitMs: 900,
      phaseLimitMs: 1_200,
      tickMs: 60,
      gateMode: "sleep",
      budgetScope: "run-global",
      blocks: [
        { id: "alpha", doneAtTick: 9, workUnits: 0 },
        { id: "beta", doneAtTick: 9, workUnits: 250_000 },
        { id: "gamma", doneAtTick: 9, workUnits: 1_500_000 },
      ],
      ...overrides,
    };
  }

  const FIXED_TICK_BLOCKS = [
    { id: "alpha", doneAtTick: 6, workUnits: 0 },
    { id: "beta", doneAtTick: 6, workUnits: 250_000 },
    { id: "gamma", doneAtTick: 6, workUnits: 1_500_000 },
  ];

  /**
   * Every way a wait reaches the log, and every attempt to make the wait safe by
   * changing what feeds it. The list is the argument: the divergence is not caused
   * by our shared budget counter, nor by its scope, nor by the cancellation race,
   * nor by having more than one wait in flight. It is the wait itself.
   */
  const PINNED_WAIT_VARIANTS: Array<{
    label: string;
    overrides: Partial<ProbeSharedBudgetInput>;
  }> = [
    {
      label: "a run-global counter shortens the wait",
      overrides: { gateMode: "sleep" },
    },
    {
      label: "a run-global counter only decides whether to loop again",
      overrides: { gateMode: "continue", limitMs: 700, tickMs: 50 },
    },
    {
      label: "the counter is per-invocation and shortens the wait",
      overrides: { gateMode: "sleep", budgetScope: "per-invocation" },
    },
    {
      label: "the counter is per-invocation and only gates the loop",
      overrides: {
        gateMode: "continue",
        budgetScope: "per-invocation",
        limitMs: 700,
        tickMs: 50,
      },
    },
    {
      label: "there is no counter and every wait is a fixed length",
      overrides: {
        gateMode: "constant-wait",
        tickMs: 40,
        blocks: FIXED_TICK_BLOCKS,
      },
    },
    {
      label: "the cancellation race is removed entirely",
      overrides: {
        gateMode: "constant-wait-no-race",
        tickMs: 40,
        blocks: FIXED_TICK_BLOCKS,
      },
    },
    {
      label: "the whole run shares a single tick wait",
      overrides: {
        gateMode: "shared-wait",
        tickMs: 40,
        blocks: FIXED_TICK_BLOCKS,
      },
    },
    {
      label: "the whole run shares one tick wait and races it",
      overrides: {
        gateMode: "shared-wait-race",
        tickMs: 40,
        blocks: FIXED_TICK_BLOCKS,
      },
    },
  ];

  for (const variant of PINNED_WAIT_VARIANTS) {
    it(`PINNED FAILING: diverges at concurrency 3 when ${variant.label}`, async () => {
      await expectCorruptedEventLog(
        await start(probeV2SharedBudgetGate, [sharedInput(variant.overrides)]),
      );
    }, 120_000);
  }

  // The serial baselines: every variant above, including all the wait ones,
  // completes when only one block runs at a time. That is what production bought
  // with V2_MAX_BLOCK_CONCURRENCY=1, and it is what proves the pinned rows are
  // about concurrency rather than about the probe being broken. These walk a real
  // multi-block poll loop, so they are the slowest thing here.
  for (const gateMode of [
    "sleep",
    "continue",
    "continue-no-wait",
    "constant-wait",
    "constant-wait-no-race",
    "constant-step",
    "shared-wait",
    "shared-wait-race",
  ] as const) {
    it(`completes one block at a time via ${gateMode}`, async () => {
      const run = await start(probeV2SharedBudgetGate, [
        sharedInput({
          maxConcurrency: 1,
          gateMode,
          tickMs: 40,
          blocks: FIXED_TICK_BLOCKS,
        }),
      ]);
      const result = (await run.returnValue) as Awaited<
        ReturnType<typeof probeV2SharedBudgetGate>
      >;
      expect({
        outcome: result.outcome,
        executionError: result.executionError,
      }).toMatchObject({ outcome: "completed", executionError: null });
    }, 120_000);
  }
});
