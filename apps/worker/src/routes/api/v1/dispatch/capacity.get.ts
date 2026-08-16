import { defineEventHandler, setResponseHeader } from "h3";
import { env } from "../../../../../env.js";
import { getDb } from "../../../../db/client.js";
import { createAdapters } from "../../../../lib/adapters.js";
import {
  requireDashboardActor,
  toHttpError,
} from "../../../../lib/auth/request-context.js";
import { capacityConsumerCount } from "../../../../lib/dispatch.js";
import { listQueued } from "../../../../dispatch-queue/at-capacity-queue.js";
import type { DispatchCapacityResponse } from "@shared/contracts";

/**
 * Dispatch-capacity snapshot for the Overview. occupiedSlots is counted through
 * the exact helper the refusal path counts against (listCapacityConsumers, so
 * parked claims and fresh reservations are included) — a full pool with zero
 * executing runs must read as full, not idle. queued is the at-capacity waiting
 * list written by the poll.
 */
export default defineEventHandler(
  async (event): Promise<DispatchCapacityResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      await requireDashboardActor(event);

      const adapters = createAdapters();
      const [occupiedSlots, queued] = await Promise.all([
        capacityConsumerCount(adapters.runRegistry),
        listQueued(getDb()),
      ]);

      return {
        generatedAt: new Date().toISOString(),
        occupiedSlots,
        maxSlots: env.MAX_CONCURRENT_AGENTS,
        queued,
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
