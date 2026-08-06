import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getHookByToken, resumeHook, start } from "workflow/api";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import {
  probeV2ConcurrentFanOut,
  probeV2ConsumptionOrder,
  probeV2SharedBudgetGate,
  type ProbeConcurrentInput,
  type ProbeDivergentSuccessorsInput,
  type ProbeSharedBudgetInput,
} from "../workflow-test-fixtures/v2-concurrent/workflow.js";

// AIW-233. Three things live here, all driven against the real Workflow runtime.
//
// 1. The deployed three-reviewer graph survives a concurrent fan-out, including
//    simultaneous hook suspensions, step retries and in-VM work at every step
//    boundary. These must stay green.
// 2. A Workflow sleep() wait corrupts the run's event log as soon as two blocks
//    poll concurrently. Those rows are PINNED AS FAILING: they assert the
//    divergence, because the defect is in the SDK and not in code we own. They
//    are the reason src/workflows/blocks/poll-delay.ts makes the poll tick a
//    sleeping step, and the same rows with a step instead are green. If the SDK
//    ever fixes this, the pins fail and poll-delay.ts can go away.
// 3. The scheduler's Promise.race join can consume results in an order a replay
//    does not reproduce, on graphs where a concurrent block has its own
//    successor. Pinned as failing too, pending its own fix.

const SNAPSHOT = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../src/workflow-definition/scenarios/snapshots/post-pr-review-v1.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as WorkflowDefinitionV2;

const REVIEWS = ["security-review", "quality-review", "requirements-review"];

type ProbeResult = Awaited<ReturnType<typeof probeV2ConcurrentFanOut>>;

/** The measured production spread: three reviewers finishing in an order that is
 * neither their admission order nor their declaration order (104/111/68s). */
function timingsFor(jitter: number): ProbeConcurrentInput["timings"] {
  return {
    "create-check": { startMs: 3, pollMs: 0, ticks: 0 },
    prepare: { startMs: 3, pollMs: 0, ticks: 0 },
    "security-review": { startMs: 5 + jitter, pollMs: 11, ticks: 4 },
    "quality-review": { startMs: 2, pollMs: 17 + jitter, ticks: 3 },
    "requirements-review": { startMs: 11, pollMs: 5, ticks: 6 + (jitter % 3) },
    "post-review": { startMs: 3, pollMs: 0, ticks: 0 },
    "complete-success": { startMs: 3, pollMs: 0, ticks: 0 },
    "complete-failure": { startMs: 3, pollMs: 0, ticks: 0 },
  };
}

function probeInput(
  overrides: Partial<ProbeConcurrentInput> = {},
): ProbeConcurrentInput {
  return {
    runId: `probe-${randomUUID()}`,
    definition: SNAPSHOT,
    entryTriggerId: "trigger-ready",
    triggerOutput: {
      status: "fired",
      pr: {
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        prUrl: "https://github.test/acme/app/pull/7",
        headRef: "feature",
        headSha: "abc123",
        baseRef: "main",
        title: "Add scenarios",
        author: "contributor",
        isDraft: false,
      },
    },
    maxConcurrency: 3,
    timings: timingsFor(0),
    parks: [],
    flakyPolls: [],
    vmWorkPerStep: 0,
    failNodes: [],
    ...overrides,
  };
}

async function waitForHook(token: string): Promise<{ runId: string }> {
  const deadline = Date.now() + 25_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await getHookByToken(token);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error(`hook ${token} was not registered`);
}

/**
 * Asserts the run died exactly the way AIW-233 dies in production: a replay
 * divergence the runtime retried and then gave up on as a corrupted event log.
 * Used to pin defects we do not own, so the suite stays green while still
 * failing loudly the day the behaviour changes.
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

function expectCompleted(result: ProbeResult): void {
  expect({
    outcome: result.outcome,
    executionError: result.executionError,
  }).toMatchObject({ outcome: "completed", executionError: null });
  expect(result.startOrder.filter((id) => REVIEWS.includes(id)).sort()).toEqual(
    [...REVIEWS].sort(),
  );
}

describe("executeV2Graph fan-out against the real Workflow runtime", () => {
  it("completes a three-reviewer fan-out one block at a time", async () => {
    const run = await start(probeV2ConcurrentFanOut, [
      probeInput({ maxConcurrency: 1 }),
    ]);
    const result = (await run.returnValue) as ProbeResult;
    expectCompleted(result);
    expect(result.finishOrder.filter((id) => REVIEWS.includes(id))).toEqual(
      REVIEWS,
    );
  });

  it("completes repeated three-reviewer fan-outs at maxConcurrency 3", async () => {
    // Timings are jittered per iteration because the reported corruption is
    // intermittent: a single lucky interleaving proves nothing.
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const run = await start(probeV2ConcurrentFanOut, [
        probeInput({ timings: timingsFor(iteration * 3) }),
      ]);
      const result = (await run.returnValue) as ProbeResult;
      expectCompleted(result);
    }
  }, 180_000);

  it("completes a fan-out whose polls retry under concurrency", async () => {
    const run = await start(probeV2ConcurrentFanOut, [
      probeInput({
        flakyPolls: [
          { nodeId: "security-review", tick: 2 },
          { nodeId: "quality-review", tick: 1 },
          { nodeId: "requirements-review", tick: 3 },
        ],
      }),
    ]);
    const result = (await run.returnValue) as ProbeResult;
    expectCompleted(result);
  });

  it("completes a fan-out with in-VM work at every step boundary", async () => {
    const run = await start(probeV2ConcurrentFanOut, [
      probeInput({ vmWorkPerStep: 2_000_000 }),
    ]);
    const result = (await run.returnValue) as ProbeResult;
    expectCompleted(result);
  }, 120_000);

  it("completes a fan-out where all three siblings suspend on hooks at once", async () => {
    const parks = REVIEWS.map((nodeId, index) => ({
      nodeId,
      token: `probe-park:${nodeId}:${randomUUID()}`,
      tick: index + 1,
    }));
    const run = await start(probeV2ConcurrentFanOut, [probeInput({ parks })]);

    // Wait until every sibling has parked, so the run really is suspended with
    // three blocks in flight, then resume them out of declaration order.
    for (const park of parks) {
      const hook = await waitForHook(park.token);
      expect(hook.runId).toBe(run.runId);
    }
    for (const park of [parks[2]!, parks[0]!, parks[1]!]) {
      await resumeHook(park.token, { answer: "keep going" });
    }

    const result = (await run.returnValue) as ProbeResult;
    expectCompleted(result);
  });

  // The deployed graph fans three reviewers straight back into one block, so on
  // the all-success path every consumption order leads to the same next step
  // name. A mixed fan-in removes that cover: a failing reviewer reports through
  // logProbeExecutionErrorStep while a succeeding one writes block statuses.
  for (const failing of REVIEWS) {
    it(`fails cleanly when ${failing} fails beside its concurrent siblings`, async () => {
      const run = await start(probeV2ConcurrentFanOut, [
        probeInput({ failNodes: [failing] }),
      ]);
      const result = (await run.returnValue) as ProbeResult;
      expect(result.outcome).toBe("failed");
      expect(result.executionError).toMatchObject({ nodeId: failing });
    }, 60_000);
  }
});

describe("executeV2Graph result-consumption order across replays", () => {
  // Each branch has its own successor calling a differently named step, so the
  // order the scheduler consumes results in IS the recorded step-name sequence.
  //
  // Only one shape is asserted. Two others (a fast branch settling with the most
  // microtask hops, and branches differing only in step duration) diverge in
  // most runs but not all: the flip depends on microtask timing, so an assertion
  // either way would be flaky. This shape failed in every run observed so far and
  // is the one a join fix has to make green. Do not read a passing run of a
  // flaky shape as evidence the join is sound.
  const RELIABLE_SHAPE: ProbeDivergentSuccessorsInput["branches"] = [
    { id: "alpha", delayMs: 25, hops: 0 },
    { id: "beta", delayMs: 12, hops: 80 },
    { id: "gamma", delayMs: 4, hops: 200 },
  ];

  it("PINNED FAILING: diverges at concurrency 3 when settle latency is lopsided", async () => {
    const run = await start(probeV2ConsumptionOrder, [
      {
        runId: `probe-order-${randomUUID()}`,
        maxConcurrency: 3,
        branches: RELIABLE_SHAPE,
      },
    ]);
    await expectCorruptedEventLog(run);
  }, 60_000);

  it("completes the same shape one block at a time", async () => {
    const run = await start(probeV2ConsumptionOrder, [
      {
        runId: `probe-order-serial-${randomUUID()}`,
        maxConcurrency: 1,
        branches: RELIABLE_SHAPE,
      },
    ]);
    const result = (await run.returnValue) as Awaited<
      ReturnType<typeof probeV2ConsumptionOrder>
    >;
    expect({
      outcome: result.outcome,
      executionError: result.executionError,
    }).toMatchObject({ outcome: "completed", executionError: null });
    expect(result.consumptionOrder).toHaveLength(6);
  }, 60_000);
});

describe("Workflow sleep() under concurrency versus a sleeping step", () => {
  // Three concurrent blocks, NO successors, so the scheduler's join is out of the
  // picture and the only variable is what the poll tick suspends on. The loop is
  // a faithful copy of blocks/poll-phase.ts against a faithful copy of
  // agent.ts's observeBudgetAtBoundary.
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

  async function runProbe(
    overrides: Partial<ProbeSharedBudgetInput>,
  ): Promise<{ returnValue: Promise<unknown> }> {
    return start(probeV2SharedBudgetGate, [sharedInput(overrides)]);
  }

  async function expectProbeCompleted(
    overrides: Partial<ProbeSharedBudgetInput>,
  ): Promise<void> {
    const run = await runProbe(overrides);
    const result = (await run.returnValue) as Awaited<
      ReturnType<typeof probeV2SharedBudgetGate>
    >;
    expect({
      outcome: result.outcome,
      executionError: result.executionError,
    }).toMatchObject({ outcome: "completed", executionError: null });
  }

  const FIXED_TICK_BLOCKS = [
    { id: "alpha", doneAtTick: 6, workUnits: 0 },
    { id: "beta", doneAtTick: 6, workUnits: 250_000 },
    { id: "gamma", doneAtTick: 6, workUnits: 1_500_000 },
  ];

  /**
   * Every way a wait reaches the log, and every attempt to make the wait safe by
   * changing what feeds it. All pinned failing: the divergence is the SDK
   * seeding a wait's expected resumeAt from Date.now() and trusting that value
   * whenever the consumer misses its own wait_created event.
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
      await expectCorruptedEventLog(await runProbe(variant.overrides));
    }, 120_000);
  }

  // The fix. Identical graph, identical concurrency, identical block asymmetry,
  // identical tick timings. The only change is that the tick is a step.
  it("completes at concurrency 3 when the tick is a step and a counter gates the loop", async () => {
    await expectProbeCompleted({
      gateMode: "continue-no-wait",
      limitMs: 700,
      tickMs: 50,
    });
  }, 120_000);

  it("completes at concurrency 3 when the tick is a step and there is no counter", async () => {
    await expectProbeCompleted({
      gateMode: "constant-step",
      tickMs: 40,
      blocks: FIXED_TICK_BLOCKS,
    });
  }, 120_000);

  // The serial baselines: everything above, including every pinned wait variant,
  // completes when only one block runs at a time. That is what production has
  // been buying with V2_MAX_BLOCK_CONCURRENCY=1.
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
      await expectProbeCompleted({
        maxConcurrency: 1,
        gateMode,
        tickMs: 40,
        blocks: FIXED_TICK_BLOCKS,
      });
    }, 120_000);
  }
});
