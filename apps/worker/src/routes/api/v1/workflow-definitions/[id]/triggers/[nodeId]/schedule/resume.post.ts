import type { ScheduleResumeResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/index.js";
import { resumeTriggerSchedule } from "../../../../../../../../services/workflow-definitions/index.js";
import { parseScheduleTarget, requireScheduleActor } from "./config.get.js";

/**
 * Resume a paused schedule. Per resumeSchedule's own contract (schedule-store.ts)
 * this parks the evaluation watermark one catch-up-grace window behind the
 * resume instant, not at "now" and not where the pause left it: an occurrence
 * that falls inside that window is still caught up, exactly as it would be after
 * a scheduler outage of the same length, and anything older is forgotten.
 *
 * Idempotent. Resuming a schedule that is not paused is already the caller's
 * desired end state, so it reports success rather than failing.
 */
export default defineEventHandler(
  async (event): Promise<ScheduleResumeResponse | undefined> => {
    try {
      await requireScheduleActor(event, true);
      const target = parseScheduleTarget(event);

      const resumed = await resumeTriggerSchedule(target);
      if (!resumed.found) {
        throw createError({ statusCode: 404, statusMessage: "Unknown schedule" });
      }
      if (resumed.row.pausedAt) {
        throw createError({ statusCode: 409, statusMessage: "Resume did not take effect" });
      }

      // The evaluation watermark resumeSchedule just moved is an internal
      // engine cursor the contract forbids showing to a user, so it is not
      // part of the response even though this route could see it.
      return { scheduleId: resumed.row.id };
    } catch (error) {
      toHttpError(error);
    }
  },
);
