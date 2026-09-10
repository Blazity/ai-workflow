import type {
  SchedulePreset,
  SchedulePreviewResponse,
} from "@shared/contracts";
import { parseRequestBody, schedulePreviewRequestSchema } from "@shared/contracts";
import { createError, defineEventHandler, readBody } from "h3";
import { toHttpError } from "../../../../../../../../services/auth/index.js";
import {
  compileSchedulePreset,
  nextRuns,
  suggestedGraceMinutes,
  violatesMinimumPeriod,
  type EveryNHoursStep,
  type EveryNMinutesStep,
  type SchedulePreset as OccurrenceSchedulePreset,
  type Weekday as OccurrenceWeekday,
} from "../../../../../../../../services/schedule-trigger/index.js";
import { parseScheduleTarget, requireScheduleActor } from "./config.get.js";

/** How many upcoming occurrences the editor shows. Fixed, not client-supplied:
 *  the preview length is "the next three occurrences" by requirement, not a
 *  configurable display choice. */
const PREVIEW_COUNT = 3;

/**
 * "If this cron and timezone were live, when would it next fire" without
 * touching any schedule row: this is a pure function of the request body, so it
 * works for a draft node that has never been deployed. Every cron computation
 * in this feature goes through occurrence.ts, this route included, so the
 * editor never carries its own evaluator.
 *
 * Also where a preset becomes a cron expression: compileSchedulePreset is the
 * only place that happens, so a preset can never mean something the raw
 * expression field would not.
 */
export default defineEventHandler(
  async (event): Promise<SchedulePreviewResponse | undefined> => {
    try {
      await requireScheduleActor(event, false);
      parseScheduleTarget(event);

      const parsed = parseRequestBody(
        schedulePreviewRequestSchema,
        await readBody(event).catch(() => null),
      );
      if (!parsed.ok) {
        throw createError({ statusCode: 400, statusMessage: parsed.message });
      }
      const body = parsed.value;

      // Presets may not keep the requested zone: compileSchedulePreset overrides
      // an interval preset ("every N minutes/hours" below a day) to UTC and
      // returns that as the effective zone, because an interval has no clock
      // meaning and a named zone only harms it once a year, across a
      // daylight-saving transition. A raw expression always keeps the zone the
      // caller asked for, since a hand-written cron might mean either.
      let cron: string;
      let timezone: string;
      if (body.source === "preset") {
        const compiled = compileSchedulePreset(toOccurrencePreset(body.preset), body.timezone);
        if (!compiled.ok) return { ok: false, problem: compiled.problem };
        cron = compiled.cron;
        timezone = compiled.timezone;
      } else {
        cron = body.cron;
        timezone = body.timezone;
      }

      const now = new Date();
      const periodProblem = violatesMinimumPeriod(cron, timezone, now);
      if (periodProblem) return { ok: false, problem: periodProblem };

      const result = nextRuns({ cron, timezone, from: now, count: PREVIEW_COUNT });
      if (!result.ok) return { ok: false, problem: result.problem };

      return {
        ok: true,
        cron,
        timezone,
        runs: result.runs.map((run) => run.toISOString()),
        // A prefill suggestion only: the editor offers it, the runtime never
        // calls this function, see suggestedGraceMinutes's own doc comment.
        suggestedGraceMinutes: suggestedGraceMinutes(cron, timezone, now),
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);

/**
 * The wire shape (contracts' SchedulePreset, plain numbers) to occurrence.ts's
 * own type (literal-union steps and weekdays). Only a type-level bridge: the
 * literal casts below prove nothing, compileSchedulePreset is what actually
 * checks each value is one of the allowed steps, an hour 0-23, a minute 0-59 or
 * a weekday 0-6, and rejects otherwise.
 */
function toOccurrencePreset(preset: SchedulePreset): OccurrenceSchedulePreset {
  switch (preset.kind) {
    case "every-n-minutes":
      return { kind: "every-n-minutes", minutes: preset.minutes as EveryNMinutesStep };
    case "every-n-hours":
      return { kind: "every-n-hours", hours: preset.hours as EveryNHoursStep };
    case "daily":
      return { kind: "daily", hour: preset.hour, minute: preset.minute };
    case "weekly":
      return {
        kind: "weekly",
        weekdays: preset.weekdays as OccurrenceWeekday[],
        hour: preset.hour,
        minute: preset.minute,
      };
  }
}
