import type { SchedulePauseResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { getDb } from "../../../../../../../../db/client.js";
import { toHttpError } from "../../../../../../../../lib/auth/request-context.js";
import { pauseSchedule } from "../../../../../../../../schedule-trigger/schedule-store.js";
import {
  parseScheduleTarget,
  requireScheduleActor,
  requireScheduleRow,
} from "./config.get.js";

/**
 * Stop evaluating this schedule, keeping its history and its authored fields.
 * Terminal until an operator resumes it: no deploy undoes a pause, exactly like
 * a webhook revocation.
 *
 * Idempotent. Pausing an already paused schedule reports the first pause
 * instant rather than failing, since the caller's intent is already satisfied.
 */
export default defineEventHandler(
  async (event): Promise<SchedulePauseResponse | undefined> => {
    try {
      await requireScheduleActor(event, true);
      const target = parseScheduleTarget(event);
      const db = getDb();
      const row = await requireScheduleRow(db, target);

      await pauseSchedule(db, row.id);
      const paused = await requireScheduleRow(db, target);
      if (!paused.pausedAt) {
        // Same defensive shape as resume's own guard: a 404 here would be
        // indistinguishable from "the row never existed", when what actually
        // happened is the write did not take effect on a row that does.
        throw createError({ statusCode: 409, statusMessage: "Pause did not take effect" });
      }

      return { scheduleId: row.id, pausedAt: paused.pausedAt.toISOString() };
    } catch (error) {
      toHttpError(error);
    }
  },
);
