/**
 * The agent poll tick, as a step that sleeps rather than a Workflow sleep() wait.
 *
 * That distinction is the whole point of AIW-233. The SDK seeds a wait's expected
 * resumeAt from Date.now() at call time (createSleep in @workflow/core, via
 * parseDurationToDate) and corrects it only if the same consumer also consumes
 * its own wait_created event. When several blocks of one run execute
 * concurrently, the events drain can pass a wait_created before the owning
 * block's continuation has reinstalled its consumer, so the expectation stays a
 * wall-clock value that can never match the recording. The run then dies with a
 * replay divergence and, after the runtime's recovery replays, with
 * CORRUPTED_EVENT_LOG. A step has no recomputed expectation: replay hands back
 * the recorded result and compares only the step name.
 *
 * The controlled matrix is in workflow-sdk-tests/v2-concurrent.test.ts. With a
 * wait, a three-block fan-out dies at concurrency 3 and survives at 1, and that
 * holds with the shared counter removed, with per-invocation counters, with
 * fixed-length waits, without the cancellation race, and with a single shared
 * wait for the whole run. With this step instead, the same shape survives at
 * concurrency 3.
 *
 * This lives in its own module so the poll loop's unit tests can substitute it
 * the way they already substitute checkPhaseDone, instead of really sleeping.
 *
 * Retries are deliberately left at the SDK default rather than pinned to 0:
 * sleeping again is idempotent, so a step invocation the platform kills
 * mid-sleep should poll later instead of failing the run.
 */
export async function delayPhasePollStep(ms: number): Promise<void> {
  "use step";
  await new Promise((resolve) => setTimeout(resolve, ms));
}
