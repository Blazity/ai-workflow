import { describe, expect, it } from "vitest";
import {
  readSchedulingGolden,
  renderSchedulingGolden,
  SCHEDULING_GOLDEN_PATH,
  SCHEDULING_GOLDEN_RECORD_COMMAND,
  SCHEDULING_GOLDEN_SINK_VARIABLE,
} from "../../test-support/scheduling-golden.js";

/**
 * The contract of the scheduler move: every scenario in this directory
 * dispatches the same blocks, in the same order, through the same executor
 * boundary and the same ports, before and after the walk moved into
 * `@shared/workflow-graph`.
 *
 * `scheduling.golden.json` was recorded on the stage 12-6b base
 * (92465dc2aaa0a984084880e8b9db5960de01c3ba) with the scheduler still inside
 * `workflow-definition/v2-scheduler.ts`, and this comparison is a byte
 * comparison on purpose: a structural diff would let the order inside one
 * scenario drift, and that order is the whole assertion.
 *
 * Nothing here regenerates the fixture. Re-recording is a decision a person
 * makes, and the diff it produces is the review.
 *
 * This test spawns the scenario suite, because the harness recording the order
 * is the only thing that sees it. The spawned run has the sink variable set, so
 * the copy of this file inside it skips rather than spawning a third.
 */
const RECORDING = process.env[SCHEDULING_GOLDEN_SINK_VARIABLE] !== undefined;

describe.skipIf(RECORDING)("scheduling golden", () => {
  it(
    "matches the fixture recorded on the stage base",
    () => {
      const recorded = readSchedulingGolden();
      expect(
        recorded,
        `${SCHEDULING_GOLDEN_PATH} is missing. Record it with: ${SCHEDULING_GOLDEN_RECORD_COMMAND}`,
      ).not.toBeNull();
      expect(
        renderSchedulingGolden(),
        `A scenario dispatched blocks in an order the fixture does not record. ` +
          `A scheduling change that was not intended is a bug in the change, not ` +
          `in the fixture; re-record only after deciding the new order is right: ` +
          SCHEDULING_GOLDEN_RECORD_COMMAND,
      ).toBe(recorded);
    },
    180_000,
  );
});
