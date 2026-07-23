import {
  createError,
  defineEventHandler,
  getQuery,
} from "h3";
import type { WorkflowRunReplayResponse } from "@shared/contracts";

import { getDb } from "../../../../../db/client.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../lib/auth/request-context.js";
import {
  getRunReplay,
  RunObservationStoreError,
} from "../../../../../run-observability/store.js";
import { parseReplayPageQuery } from "../replay-query.js";
import {
  parseReplayRunId,
  setReplayNoStore,
} from "../replay-route.js";

export default defineEventHandler(
  async (event): Promise<WorkflowRunReplayResponse | undefined> => {
    setReplayNoStore(event);
    try {
      const actor = await requireDashboardActor(event);
      const runId = parseReplayRunId(event);
      const page = parseReplayPageQuery(getQuery(event));
      return getRunReplay({
        db: getDb(),
        organizationId: actor.organizationId,
        runId,
        ...page,
      });
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
