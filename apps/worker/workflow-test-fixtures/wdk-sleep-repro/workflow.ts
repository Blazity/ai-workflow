import { sleep } from "workflow";

// Minimal, standalone reproduction of a Workflow DevKit replay divergence.
//
// Diagnosis: createSleep seeds resumeAt from Date.now() and treats a missing
// wait_created as licence to trust the recomputed value.
//
// In @workflow/core, createSleep computes the wait's expected resumeAt with
// parseDurationToDate(param), which is new Date(Date.now() + durationMs). The
// consumer overwrites that expectation only when it consumes its own
// wait_created event; when it does not, the wait_completed check falls back to
// the locally recomputed wall-clock value and compares it against the recorded
// one. Those can never be equal.
//
// With several concurrent branches in one run, the events drain can pass a
// wait_created before the owning branch's continuation has reinstalled its wait
// consumer, because that continuation is queued behind other branches'
// deliveries. The run then fails with:
//
//   Replay divergence: wait_completed event for wait_... has resumeAt "...",
//   but the current wait consumer expects "..."
//
// and, after the runtime's recovery replays, with CORRUPTED_EVENT_LOG.
//
// Depends on nothing but the "workflow" package. Run one branch and it passes;
// run several and it fails. Replace the sleep with the sleeping step below and
// several branches pass, which isolates the wait as the cause.

/** A durable step, for comparison: replay hands back its recorded result. */
async function recordTickStep(label: string): Promise<string> {
  "use step";
  return label;
}

/** The same tick as a step that sleeps, rather than as a workflow wait. */
async function sleepingTickStep(ms: number): Promise<void> {
  "use step";
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synchronous work between a delivery and the next suspension point. Branches
 * burn different amounts, which is what real concurrent work looks like and what
 * makes one branch's continuation lag behind another's.
 */
function burn(units: number): number {
  let acc = 0;
  for (let index = 0; index < units; index += 1) {
    acc = (acc * 31 + index) % 1_000_003;
  }
  return acc;
}

export interface ConcurrentSleepInput {
  /** How many branches run at once. 1 passes, 3 fails. */
  branches: number;
  /** Poll iterations per branch. */
  ticks: number;
  /** Tick length in milliseconds. */
  tickMs: number;
  /** Per-branch synchronous work, so the branches are not symmetric. */
  workUnits: number[];
  /** "wait" uses sleep(); "step" uses a step that sleeps for the same time. */
  tickKind: "wait" | "step";
}

export async function probeConcurrentSleep(input: ConcurrentSleepInput) {
  "use workflow";

  const runBranch = async (branch: number): Promise<string> => {
    const units = input.workUnits[branch] ?? 0;
    let last = "";
    for (let tick = 0; tick < input.ticks; tick += 1) {
      burn(units);
      if (input.tickKind === "wait") {
        await sleep(`${input.tickMs}ms`);
      } else {
        await sleepingTickStep(input.tickMs);
      }
      last = await recordTickStep(`b${branch}t${tick}`);
    }
    return last;
  };

  const results = await Promise.all(
    Array.from({ length: input.branches }, (_unused, branch) =>
      runBranch(branch),
    ),
  );
  return { branches: results.length, last: results };
}
