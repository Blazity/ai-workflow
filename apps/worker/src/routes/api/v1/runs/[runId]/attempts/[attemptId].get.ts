import {
  createError,
  defineEventHandler,
} from "h3";
import type { WorkflowReplayAttemptDetail } from "@shared/contracts";

import { getDb } from "../../../../../../db/client.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../../lib/auth/request-context.js";
import {
  getRunReplayAttempt,
  RunObservationStoreError,
} from "../../../../../../run-observability/store.js";
import {
  parseReplayAttemptId,
  parseReplayRunId,
  setReplayNoStore,
} from "../../replay-route.js";

export default defineEventHandler(
  async (event): Promise<WorkflowReplayAttemptDetail | undefined> => {
    setReplayNoStore(event);
    try {
      const actor = await requireDashboardActor(event);
      const attempt = await getRunReplayAttempt({
        db: getDb(),
        organizationId: actor.organizationId,
        runId: parseReplayRunId(event),
        attemptId: parseReplayAttemptId(event),
      });
      if (!attempt) {
        throw createError({
          statusCode: 404,
          statusMessage: "Attempt not found",
        });
      }
      return attempt;
    } catch (error) {
      if (error instanceof RunObservationStoreError) {
        throw createError({
          statusCode: error.statusCode,
          statusMessage: error.message,
        });
      }
      toHttpError(error);
    }
  },
);
