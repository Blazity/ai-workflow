/**
 * An operator's cancel-by-id, from the run id in the path to the outcome.
 *
 * The heavy lifting (Workflow cancel, sandbox cleanup, exact claim release,
 * blocked settle, schedule-ledger settle) lives in the frozen
 * cancelRunForOperator next door. This binds what a request supplies that the
 * cancel itself cannot know: the connection, the provider adapters, and the
 * label the acting operator is recorded under.
 */
import { getDb } from "../../db/client.js";
import { dashboardUserLabel } from "../../pre-pr-checks/store.js";
import { createAdapters } from "../../engine/support/adapters.js";
import {
  cancelRunForOperator,
  type CancelRunForOperatorResult,
} from "./cancel-run.js";

export async function cancelRunAsOperator(
  runId: string,
  actor: { userId: string },
): Promise<CancelRunForOperatorResult> {
  const db = getDb();
  const adapters = createAdapters();
  const actorLabel = await dashboardUserLabel(db, actor.userId);
  // The cancel AND the schedule-ledger settle: both live in cancelRunForOperator
  // so this path and the MCP tool cannot drift on what an operator cancel means.
  // The settle is best-effort in there, for the reason it always was: the run is
  // already torn down, so a failed ledger write must never turn a confirmed
  // cancel into an error.
  return cancelRunForOperator(db, runId, {
    actorLabel,
    runRegistry: adapters.runRegistry,
    issueTracker: adapters.issueTracker,
  });
}
