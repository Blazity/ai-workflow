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
import { cancelRunForOperator } from "../../../../../lib/cancel-run.js";
import { dashboardUserLabel } from "../../../../../pre-pr-checks/store.js";

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
      // The cancel AND the schedule-ledger settle: both live in cancelRunForOperator
      // so this route and the MCP tool cannot drift on what an operator cancel means.
      // The settle is best-effort in there, for the reason it always was: the run is
      // already torn down, so a failed ledger write must never turn a confirmed
      // cancel into an error.
      const result = await cancelRunForOperator(db, runId, {
        actorLabel,
        runRegistry: adapters.runRegistry,
        issueTracker: adapters.issueTracker,
      });

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
