import {
  createError,
  defineEventHandler,
  getQuery,
} from "h3";
import type { WorkflowRunReplayResponse } from "@shared/contracts";

import {
  requireDashboardActor,
  toHttpError,
} from "../../../../../services/auth/index.js";
import {
  RunObservationStoreError,
  readRunReplay,
} from "../../../../../services/run-lifecycle/index.js";
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
      return await readRunReplay({
        organizationId: actor.organizationId,
        runId,
        ...parseReplayPageQuery(getQuery(event)),
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
