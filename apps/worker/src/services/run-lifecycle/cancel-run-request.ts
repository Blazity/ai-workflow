/**
 * An operator's cancel-by-id, from the run id in the path to the outcome.
 *
 * The heavy lifting (Workflow cancel, sandbox cleanup, exact claim release,
 * blocked settle, schedule-ledger settle) lives in the frozen
 * cancelRunForOperator next door. This binds what a request supplies that the
 * cancel itself cannot know: the connection, the provider adapters, and the
 * label the acting operator is recorded under.
 */
import { getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";
import type { SettingsSnapshot } from "@shared/contracts";
import { createAdapters, issueTrackerIfConnected } from "../../engine/support/adapters.js";
import {
  cancelConnectedRunForOperator,
  type CancelRunForOperatorResult,
} from "./cancel-run.js";

export async function cancelRunAsOperator(
  runId: string,
  actor: { userId: string },
  settings: SettingsSnapshot,
): Promise<CancelRunForOperatorResult> {
  const adapters = await createAdapters();
  const actorLabel = await getConnectedDashboardUserLabel(actor.userId);
  // The cancel AND the schedule-ledger settle: both live in cancelRunForOperator
  // so this path and the MCP tool cannot drift on what an operator cancel means.
  // The settle is best-effort in there, for the reason it always was: the run is
  // already torn down, so a failed ledger write must never turn a confirmed
  // cancel into an error.
  return cancelConnectedRunForOperator(runId, {
    actorLabel,
    runRegistry: adapters.runRegistry,
    // Optional, as it is to the cancel itself: a deployment with no usable
    // tracker can still stop a run. Reading the throwing getter here refused
    // every dashboard cancel on such a deployment with a server error.
    issueTracker: issueTrackerIfConnected(adapters),
    settings,
  });
}
