import type { RunCancelResponse } from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
} from "h3";
import { getDb } from "../../../../../db/client.js";
import { createAdapters } from "../../../../../lib/adapters.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../lib/auth/request-context.js";
import { canDispatchWorkflowRuns } from "../../../../../lib/auth/roles.js";
import { cancelRunById } from "../../../../../lib/cancel-run.js";
import { logger } from "../../../../../lib/logger.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";
import { settleScheduleOccurrenceOnCancel } from "../../../../../schedule-trigger/occurrence-store.js";

/**
 * Operator cancel-by-id: an authenticated dispatcher stops ANY in-flight run,
 * including a ticketless webhook or schedule run no ticket-column cancel path can
 * reach. The heavy lifting (Workflow cancel, sandbox cleanup, exact claim
 * release, blocked settle) lives in the frozen cancelRunById; this route only
 * gates on the dispatch role, drives it, best-effort settles the schedule ledger,
 * and maps the outcome to an honest HTTP response.
 */
export default defineEventHandler(
  async (event): Promise<RunCancelResponse | undefined> => {
    try {
      const actor = await requireDashboardActor(event);
      if (!canDispatchWorkflowRuns(actor.role)) {
        throw createError({ statusCode: 403, statusMessage: "Forbidden" });
      }
      const runId = getRouterParam(event, "runId")?.trim();
      if (!runId) {
        throw createError({ statusCode: 404, statusMessage: "Unknown run" });
      }

      const db = getDb();
      const adapters = createAdapters();
      const actorLabel = await dashboardUserLabel(db, actor.userId);
      const result = await cancelRunById(db, runId, {
        actorLabel,
        runRegistry: adapters.runRegistry,
      });

      switch (result.outcome) {
        case "cancelled": {
          // Best-effort schedule-ledger settle. The run is already cancelled and
          // its subject released, so a failed or no-op settle must never turn a
          // confirmed cancel into an error (same convention as the cancel-core
          // best-effort settles). It is a no-op for non-schedule runs.
          try {
            const settled = await settleScheduleOccurrenceOnCancel(db, runId);
            if (!settled && result.subjectKey?.startsWith("schedule:")) {
              // No started occurrence carried this run id: the cancel landed in
              // the bind-to-started window. Warn so the miss is observed; the
              // drain's re-dispatch self-remedies.
              logger.warn(
                { runId, subjectKey: result.subjectKey },
                "schedule_run_cancel_occurrence_unsettled",
              );
            }
          } catch (error) {
            logger.warn(
              {
                runId,
                subjectKey: result.subjectKey ?? null,
                error: (error as Error).message,
              },
              "schedule_run_cancel_occurrence_unsettled",
            );
          }
          setResponseStatus(event, 200);
          return {
            outcome: "cancelled",
            runId,
            subjectKey: result.subjectKey ?? null,
          };
        }
        case "already_terminal":
          // Honest: the run ended on its own. status MAY be non-terminal or
          // absent because workflow_runs can lag the registry, so report it as
          // observed.
          setResponseStatus(event, 200);
          return {
            outcome: "already_terminal",
            runId,
            runStatus: result.status ?? null,
          };
        case "unconfirmed":
          // The live cancel could not be confirmed this attempt; the claim is
          // retained, so the operator retries.
          setResponseStatus(event, 409);
          return { outcome: "unconfirmed", runId };
        case "not_found":
          throw createError({ statusCode: 404, statusMessage: "Unknown run" });
      }
    } catch (error) {
      // Mirror the sibling run routes: translate a typed dashboard-auth error to
      // its HTTP status and rethrow everything else unchanged.
      toHttpError(error);
    }
  },
);
