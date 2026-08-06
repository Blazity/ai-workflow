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

// AIW-233, resolved. Three things live here, all driven against the real Workflow
// runtime, and all of them assert success. Nothing in this file is pinned as
// failing any more: it is what guards our own fix in test:workflow-sdk, which CI
// runs on every pull request, so a red row here is a regression of ours.
//
// 1. The deployed three-reviewer graph survives a concurrent fan-out, from one
//    block at a time up to maxConcurrency 3, including simultaneous hook
//    suspensions, step retries, in-VM work at every step boundary, and one
//    sibling failing beside the others.
// 2. The scheduler's join consumes results in graph order, so a replay
//    reproduces the recorded step-name sequence even where a concurrent block
//    has its own successor. Those shapes were pinned as failing until the
//    head-of-line consumption fix landed; they assert completion now.
// 3. The agent poll tick as a step survives concurrency, with a run-global
//    counter gating the loop and with no counter at all.
//
// What this file no longer asserts is the SDK defect underneath all of it, which
// is still open: a Workflow sleep() wait cannot survive replay once two blocks of
// one run poll concurrently. Those rows moved to
// divergence/wdk-wait-divergence.test.ts, manual dispatch only because each one
// drives real replay divergences in real time. Respect the hazard rather than the
// calm of this file: a sleep() from "workflow" on any path a block can reach
// while siblings run brings CORRUPTED_EVENT_LOG straight back.

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
  // Before the head-of-line consumption fix, the shapes below diverged at
  // concurrency 3 and were green at 1: the first reliably, the other two
  // intermittently, because the flip depends on microtask timing. They are
  // asserted green now because consumption order no longer depends on timing at
  // all, so the flakiness has no input left to vary. If any of them starts
  // failing again, the scheduler has gone back to consuming in completion order.
  const SHAPES: Array<{
    label: string;
    branches: ProbeDivergentSuccessorsInput["branches"];
  }> = [
    {
      label: "the slowest branch settles with the fewest microtask hops",
      branches: [
        { id: "alpha", delayMs: 25, hops: 0 },
        { id: "beta", delayMs: 12, hops: 80 },
        { id: "gamma", delayMs: 4, hops: 200 },
      ],
    },
    {
      label: "the fastest branch settles with the most microtask hops",
      branches: [
        { id: "alpha", delayMs: 3, hops: 400 },
        { id: "beta", delayMs: 5, hops: 40 },
        { id: "gamma", delayMs: 7, hops: 0 },
      ],
    },
    {
      label: "branches differ only in step duration",
      branches: [
        { id: "alpha", delayMs: 25, hops: 0 },
        { id: "beta", delayMs: 12, hops: 0 },
        { id: "gamma", delayMs: 4, hops: 0 },
      ],
    },
  ];

  for (const shape of SHAPES) {
    for (const maxConcurrency of [3, 1]) {
      it(`completes at concurrency ${maxConcurrency} when ${shape.label}`, async () => {
        const run = await start(probeV2ConsumptionOrder, [
          {
            runId: `probe-order-${randomUUID()}`,
            maxConcurrency,
            branches: shape.branches,
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
        // The point of the fix: results are consumed in graph order, so the
        // branches always finish in declaration order however fast each ran.
        expect(
          result.consumptionOrder.filter((id) =>
            ["alpha", "beta", "gamma"].includes(id),
          ),
        ).toEqual(["alpha", "beta", "gamma"]);
      }, 60_000);
    }
  }
});

describe("the agent poll tick as a step survives concurrency", () => {
  // The fix itself: three concurrent blocks running a faithful copy of
  // blocks/poll-phase.ts against a faithful copy of agent.ts's
  // observeBudgetAtBoundary, with the tick as a sleeping step. No successors, so
  // the scheduler's join is out of the picture and the tick is the only variable.
  //
  // The counterpart rows, where the tick is a Workflow sleep() wait and the run
  // dies, are pinned in workflow-sdk-tests/divergence/. They guard the SDK rather
  // than us and cost most of the wall clock, so they are manual dispatch only:
  // pnpm --filter worker test:workflow-sdk-divergence.
  function sharedInput(
    overrides: Partial<ProbeSharedBudgetInput> = {},
  ): ProbeSharedBudgetInput {
    return {
      runId: `probe-budget-${randomUUID()}`,
      maxConcurrency: 3,
      limitMs: 900,
      phaseLimitMs: 1_200,
      tickMs: 60,
      gateMode: "continue-no-wait",
      budgetScope: "run-global",
      blocks: [
        { id: "alpha", doneAtTick: 9, workUnits: 0 },
        { id: "beta", doneAtTick: 9, workUnits: 250_000 },
        { id: "gamma", doneAtTick: 9, workUnits: 1_500_000 },
      ],
      ...overrides,
    };
  }

  async function expectProbeCompleted(
    overrides: Partial<ProbeSharedBudgetInput>,
  ): Promise<void> {
    const run = await start(probeV2SharedBudgetGate, [sharedInput(overrides)]);
    const result = (await run.returnValue) as Awaited<
      ReturnType<typeof probeV2SharedBudgetGate>
    >;
    expect({
      outcome: result.outcome,
      executionError: result.executionError,
    }).toMatchObject({ outcome: "completed", executionError: null });
  }

  it("completes at concurrency 3 when a run-global counter gates the loop", async () => {
    await expectProbeCompleted({
      gateMode: "continue-no-wait",
      limitMs: 700,
      tickMs: 50,
    });
  }, 120_000);

  it("completes at concurrency 3 when there is no counter at all", async () => {
    await expectProbeCompleted({
      gateMode: "constant-step",
      tickMs: 40,
      blocks: [
        { id: "alpha", doneAtTick: 6, workUnits: 0 },
        { id: "beta", doneAtTick: 6, workUnits: 250_000 },
        { id: "gamma", doneAtTick: 6, workUnits: 1_500_000 },
      ],
    });
  }, 120_000);
});
