import { createError, defineEventHandler, getRouterParam } from "h3";
import { env } from "../../../../../../env.js";
import { getDb } from "../../../../../db/client.js";
import { createAdapters } from "../../../../../lib/adapters.js";
import { cancelRun, cancelSubjectRun } from "../../../../../lib/cancel-run.js";
import { drainOldestPendingTrigger } from "../../../../../lib/dispatch-trigger.js";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { canCancelWorkflowRuns } from "../../../../../lib/auth/roles.js";

export default defineEventHandler(async (event) => {
  try {
    const actor = await requireDashboardActor(event);
    if (!canCancelWorkflowRuns(actor.role)) {
      throw createError({ statusCode: 403, statusMessage: "Forbidden" });
    }
    const runId = getRouterParam(event, "runId");
    if (!runId) throw createError({ statusCode: 400, statusMessage: "Missing run id" });

    const adapters = createAdapters();
    const entry = (await adapters.runRegistry.listAll()).find(
      (candidate) =>
        (candidate.state === "bound" ||
          candidate.state === "parking" ||
          candidate.state === "parked" ||
          candidate.state === "cancelling") &&
        candidate.runId === runId,
    );
    if (!entry) throw createError({ statusCode: 404, statusMessage: "Active run not found" });

    const onReleased = async (subjectKey: string) => {
      await drainOldestPendingTrigger(subjectKey, {
        db: getDb(),
        runRegistry: adapters.runRegistry,
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      });
    };
    const cancelled = entry.ticketKey
      ? await cancelRun(
          entry.ticketKey,
          { ownerToken: entry.ownerToken, runId },
          adapters.runRegistry,
          adapters.issueTracker,
          env.JIRA_BACKLOG_TRANSITION_ID
            ? { name: env.COLUMN_BACKLOG, transitionId: env.JIRA_BACKLOG_TRANSITION_ID }
            : env.COLUMN_BACKLOG,
          onReleased,
        )
      : await cancelSubjectRun(
          entry.subjectKey,
          { ownerToken: entry.ownerToken, runId },
          adapters.runRegistry,
          onReleased,
        );
    if (!cancelled) {
      throw createError({ statusCode: 503, statusMessage: "Cancellation not confirmed" });
    }
    return { status: "cancelled", runId, subjectKey: entry.subjectKey };
  } catch (error) {
    toHttpError(error);
  }
});
