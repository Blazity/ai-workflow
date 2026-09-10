import type { RunCancelResponse } from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
} from "h3";
import {
  canDispatchWorkflowRuns,
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/index.js";
import { cancelRunAsOperator } from "../../../../../services/run-lifecycle/index.js";

/**
 * Operator cancel-by-id: an authenticated dispatcher stops ANY in-flight run,
 * including a ticketless webhook or schedule run no ticket-column cancel path can
 * reach. This route only gates on the dispatch role, drives the cancel, and maps
 * the outcome to an honest HTTP response.
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

      const result = await cancelRunAsOperator(runId, { userId: actor.userId });

      switch (result.outcome) {
        case "cancelled": {
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
