import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import { getDb } from "../../../../db/client.js";
import { createAdapters } from "../../../../lib/adapters.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { collectBlockStatuses } from "../../../../lib/overview/collect-block-statuses.js";
import type { RunBlockStatusesResponse } from "@shared/contracts";

export default defineEventHandler(
  async (event): Promise<RunBlockStatusesResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      await requireDashboardActor(event);
      const adapters = createAdapters();
      const parsed = Number(getQuery(event).definitionId);
      const definitionId =
        Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;

      return {
        generatedAt: new Date().toISOString(),
        run: await collectBlockStatuses({
          registry: adapters.runRegistry,
          db: getDb(),
          definitionId,
        }),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
