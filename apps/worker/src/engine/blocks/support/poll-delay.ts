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
 * The controlled matrix lives in the divergence suite,
 * workflow-sdk-tests/divergence/wdk-wait-divergence.test.ts, which is manual
 * dispatch only (pnpm --filter worker test:workflow-sdk-divergence) because its
 * rows assert the failure in real time. With a wait, a three-block fan-out dies
 * at concurrency 3 and survives at 1, and that holds with the shared counter
 * removed, with per-invocation counters, with fixed-length waits, without the
 * cancellation race, and with a single shared wait for the whole run. With this
 * step instead, the same shape survives at concurrency 3, and those green rows
 * are in workflow-sdk-tests/v2-concurrent.test.ts, inside the default run. Start
 * at the divergence suite when asking whether this workaround is still needed:
 * its rows failing means the SDK fixed the defect and this module can go away.
 *
 * This lives in its own module so the poll loop's unit tests can substitute it
 * the way they already substitute checkPhaseDone, instead of really sleeping.
 *
 * WHAT THIS COSTS. A wait is scheduled by the platform and holds nothing open; a
 * step is a live function invocation for its whole duration. At the 30s ceiling
 * in poll-phase.ts and the 25 minute phase cap (MAX_MINUTES in generic-agent.ts,
 * DEFAULT_MAX_MINUTES in fix-agent.ts) that is up to 50 invocations per phase per
 * block, and up to three blocks poll at once. An idle step burns almost no active
 * CPU, so the bill is invocations plus provisioned memory for the span, not
 * compute. There is no timeout risk because the deployed step function ships
 * maxDuration "max" (see .vercel/output/functions/.well-known/workflow/v1/
 * step.func/.vc-config.json), but that is the constraint to respect: the 30s
 * ceiling must stay under whatever the deployed function limit is, so raising one
 * without checking the other is how this starts failing.
 *
 * RETRIES ARE DELIBERATELY THE SDK DEFAULT, NOT 0. Do not pin maxRetries = 0 for
 * symmetry with killPhaseCommand in poll-phase.ts. Sleeping again is idempotent,
 * so a tick whose invocation the platform kills should poll later rather than
 * fail the whole run. Know the accounting that follows, and do not "fix" it: the
 * SDK default is 3 retries, so 4 attempts, and poll-phase.ts:70 advances
 * phaseElapsedMs by the requested tick exactly once however many attempts it
 * took. A fully retried tick therefore burns up to four times its wall clock
 * against one tick of the phase budget, which makes maxMinutes a floor rather
 * than a ceiling. That is intentional: the real bound is the run-global duration
 * budget, re-read every iteration at poll-phase.ts:34 and :76, and it is measured
 * from the clock rather than counted in ticks, so it already covers the overrun.
 */
export async function delayPhasePollStep(ms: number): Promise<void> {
  "use step";
  await new Promise((resolve) => setTimeout(resolve, ms));
}
