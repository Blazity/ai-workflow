import type { ScheduleResumeResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import { resumeSchedule } from "../../../../../../../../schedule-trigger/schedule-store.js";
import {
  parseScheduleTarget,
  requireScheduleActor,
  requireScheduleRow,
} from "./config.get.js";

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
      const db = getDb();
      const row = await requireScheduleRow(db, target);

      await resumeSchedule(db, row.id);
      const resumed = await requireScheduleRow(db, target);
      if (resumed.pausedAt) {
        throw createError({ statusCode: 409, statusMessage: "Resume did not take effect" });
      }

      // The evaluation watermark resumeSchedule just moved is an internal
      // engine cursor the contract forbids showing to a user, so it is not
      // part of the response even though this route can see it.
      return { scheduleId: row.id };
    } catch (error) {
      toHttpError(error);
    }
  },
);
