import type { SchedulePauseResponse } from "@shared/contracts";
import { createError, defineEventHandler } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/request-context.js";
import {
  pauseTriggerSchedule,
} from "../../../../../../../../services/workflow-definitions/trigger-schedules.js";
import { parseScheduleTarget, requireScheduleActor } from "./config.get.js";

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

      const paused = await pauseTriggerSchedule(target);
      if (!paused.found) {
        throw createError({ statusCode: 404, statusMessage: "Unknown schedule" });
      }
      if (!paused.row.pausedAt) {
        // Same defensive shape as resume's own guard: a 404 here would be
        // indistinguishable from "the row never existed", when what actually
        // happened is the write did not take effect on a row that does.
        throw createError({ statusCode: 409, statusMessage: "Pause did not take effect" });
      }

      return { scheduleId: paused.row.id, pausedAt: paused.row.pausedAt.toISOString() };
    } catch (error) {
      toHttpError(error);
    }
  },
);
