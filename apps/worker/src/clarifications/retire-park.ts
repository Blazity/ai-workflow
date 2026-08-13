import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import {
  cancelRunForOperator,
  type CancelRunForOperatorResult,
} from "../lib/cancel-run.js";
import { logger } from "../lib/logger.js";

/**
 * Why an automated sweep is taking a park down. Carried as data so the durable
 * reason recorded on the run states a cause rather than an actor, and so every
 * sweep that retires a park words it the same way.
 */
export type ParkRetirementCause = { kind: "ticket_deleted"; ticketKey: string };

/**
 * Retire a park nobody can ever answer and give its concurrency slot back.
 *
 * A parked run keeps its `active_runs` row for the whole park and
 * `listCapacityConsumers` counts it, so a question that lost its point still
 * holds one of MAX_CONCURRENT_AGENTS slots until the seven day hook expiry.
 * Three of them starved dispatch on a client tenant on 2026-08-13: every new
 * ticket was refused as `at_capacity` for over an hour, with nothing running.
 *
 * Every piece of the teardown already exists inside `cancelRunForOperator`, so
 * this only words the reason and delegates:
 *   - the clarification rows are superseded by the tombstone that opens the
 *     cancel (`preparing`, `pending` and `answered` alike), which is also the
 *     fence against a human pressing ANSWER at the same moment. Retiring the
 *     question here first would break that fence, so this deliberately does not.
 *   - the reason lands in `workflow_runs.status_reason` while the run is still
 *     `awaiting`, and the park marker settles as `blocked` behind the step drain.
 *   - the claim is released in the same call, which is what frees the slot.
 *   - a schedule occurrence behind the parked run gets settled. Reaching for the
 *     cancel core underneath instead would skip that and reintroduce AIW-240, a
 *     torn down run whose occurrence stayed "started".
 *
 * No ticket fetch and no ticket transition are involved, so a ticket that no
 * longer exists cannot block the release. The outcome is passed through
 * unmapped: `unconfirmed` is the only one worth retrying, because it is the only
 * one where the run was never touched.
 */
export async function retireParkedRun(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  runId: string;
  cause: ParkRetirementCause;
}): Promise<CancelRunForOperatorResult> {
  const { db, runRegistry, runId, cause } = input;
  const result = await cancelRunForOperator(db, runId, {
    actorLabel: parkRetirementActorLabel(cause),
    runRegistry,
  });
  logger.info(
    {
      runId,
      cause: cause.kind,
      outcome: result.outcome,
      subjectKey: result.subjectKey,
    },
    "park_retired",
  );
  return result;
}

/**
 * Recorded as "cancelled by <label>", so the label has to name the cause a
 * person reading the run in the dashboard would be looking for.
 */
function parkRetirementActorLabel(cause: ParkRetirementCause): string {
  return `the parked run sweep (ticket ${cause.ticketKey} no longer exists in the issue tracker)`;
}
