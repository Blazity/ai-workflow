import { describe, it, expect, afterAll } from "vitest";
import { callCronPoll } from "../helpers/cron.js";
import {
  cleanupSeededSchedule,
  getActiveRunBySubject,
  listScheduleOccurrences,
  seedDueScheduleDefinition,
  type SeededSchedule,
} from "../helpers/schedule.js";
import { waitFor } from "../helpers/wait.js";

/**
 * AIW-223: Schedule trigger dispatch is idempotent
 *
 * Vercel only runs cron jobs on production, never on preview or demo, so the
 * one path that actually proves a schedule fires by itself is `/cron/poll`
 * itself (e2e/helpers/cron.ts): this test calls it directly, the same way a
 * real cron tick would, with the same bearer auth.
 *
 * What this test does NOT prove: that deploying a definition mints the
 * workflow_schedules row in the first place (store.ts's
 * syncSchedulesForLiveHead, wired through deployWorkflowDefinition). Seeding
 * here writes the definition/version/schedule rows directly instead of going
 * through that dashboard-authenticated path, because deployWorkflowDefinition
 * transitively requires a full server environment e2e does not have and must
 * not fabricate (see e2e/helpers/schedule.ts for the full reasoning). Deploy
 * actually minting the row is proven separately, on production, as part of
 * this feature's release verification.
 *
 * What this test DOES prove, for real, against the deployed worker: a due
 * occurrence starts a run on the first poll, and a second poll never starts a
 * second run for that same occurrence. The second assertion is the ticket's
 * acceptance criterion and the one thing in this file that must never be
 * weakened.
 */
describe("AIW-223: schedule trigger dispatch is idempotent", () => {
  let seeded: SeededSchedule | undefined;

  afterAll(async () => {
    // Runs even when an assertion above throws: this suite runs against a
    // Neon branch shared with every other e2e test, so a failed run must not
    // leave the fixture behind for the next one.
    if (seeded) await cleanupSeededSchedule(seeded);
  });

  it("starts exactly one run for the due occurrence across two poll calls", async () => {
    // 1. Seed a "deployed" definition carrying the committed schedule-open-pr
    //    snapshot, with its schedule's evaluation watermark set 35 minutes in
    //    the past (past one 30-minute cron period) and a 12-hour catch-up
    //    grace, so exactly one occurrence is due now, comfortably inside the
    //    tolerance window regardless of scheduling delay in CI.
    seeded = await seedDueScheduleDefinition();

    // 2. First poll: the due occurrence should be admitted and dispatched.
    const first = await callCronPoll();
    expect(first.status).toBe(200);

    const occurrence = await waitFor(
      async () => {
        const rows = await listScheduleOccurrences(seeded!.scheduleId);
        const started = rows.find((row) => row.outcome === "started");
        return started ?? null;
      },
      {
        description: `schedule ${seeded.scheduleId} occurrence started`,
        timeoutMs: 30_000,
        intervalMs: 2_000,
      },
    );

    // 3. A run row exists: the occurrence ledger's run_id and the run
    //    registry's own row for this subject agree on the same run.
    expect(occurrence.runId).toBeTruthy();
    const activeRun = await getActiveRunBySubject(seeded.subjectKey);
    expect(activeRun?.runId).toBe(occurrence.runId);

    // 4. Second poll: the same occurrence is already settled (pending=false,
    //    outcome='started'), so neither the evaluation pass (watermark has
    //    already advanced past it) nor the drain (it is no longer pending)
    //    revisits it.
    const second = await callCronPoll();
    expect(second.status).toBe(200);

    // 5. This is the acceptance criterion: exactly one occurrence row for
    //    this schedule, still carrying the same run_id from the first poll.
    //    A second run for the same occurrence would show up here either as a
    //    second row or as a changed run_id, and must not.
    const occurrencesAfterSecondPoll = await listScheduleOccurrences(
      seeded.scheduleId,
    );
    expect(occurrencesAfterSecondPoll).toHaveLength(1);
    expect(occurrencesAfterSecondPoll[0]?.runId).toBe(occurrence.runId);
  });
});
