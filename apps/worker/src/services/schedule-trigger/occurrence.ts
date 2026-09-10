import { Cron } from "croner";

/**
 * Pure occurrence evaluator for schedule (cron) triggers.
 *
 * Every time semantic of the feature lives here, on purpose. A schedule trigger
 * gets its answers wrong silently: a missed run looks like an idle system and a
 * doubled run looks like a user clicking twice, so neither shows up as an error
 * anywhere. Concentrating the arithmetic in one pure module is what makes it
 * testable at the millisecond, which is the only way these bugs surface.
 *
 * Three rules the rest of the system depends on:
 *   - no ambient clock. Every function that needs the current time takes `now`,
 *     the same way webhook-trigger/rate-limit.ts and lib/run-start-lifecycle.ts
 *     do, because there is no injectable clock in this codebase;
 *   - bounded work per call, always. This runs inside the once-a-minute cron
 *     route next to about twenty other phases and has no time budget of its own;
 *   - an invalid expression or timezone is an error, never a silent fallback.
 *     A schedule that quietly ran in UTC instead of Europe/Warsaw would look
 *     correct in every log line and be wrong by an hour twice a year.
 *
 * `croner` is the only date library in this worker and is confined to this file.
 * Hand-writing daylight-saving arithmetic to satisfy "define daylight-saving
 * behaviour" is a trap, not a saving.
 */

/**
 * Shortest gap we allow between two consecutive occurrences of one schedule.
 *
 * Every occurrence starts a full agent run: 3 to 25 minutes of work that can
 * open pull requests. The sandbox pool is global, MAX_CONCURRENT_AGENTS, default
 * 3 (apps/worker/env.ts:98), and it is shared with the human ticket queue. So a
 * schedule that fires faster than its own runs finish does not merely queue
 * behind itself, it occupies the whole pool and starves the tickets people are
 * waiting on. Fifteen minutes keeps even the worst case (one schedule, always
 * firing) to a fraction of the pool while still reading as "often" to a user.
 */
export const MINIMUM_PERIOD_MS = 15 * 60 * 1000;

/**
 * How many upcoming occurrences the period check samples.
 *
 * Two occurrences are not enough: `0,1 * * * *` has a one-minute gap followed by
 * a fifty-nine minute one, and a twenty-five minute step fires at :00 :25 :50
 * and then :00 again, a ten-minute gap only the third pair reveals. A cron
 * expression cannot be analysed exactly in bounded time, so this is a guard
 * against obviously-too-frequent patterns rather than a proof over all time.
 * Thirty-two samples cover more than a full hour of the densest realistic
 * pattern, which is where every wrap-around gap of a minute or hour list shows
 * up.
 */
const MINIMUM_PERIOD_SAMPLE = 32;

/**
 * Ceiling on the reported count of dropped occurrences.
 *
 * Producing an exact count means enumerating the whole missed history. A
 * five-minute schedule paused for three weeks is six thousand occurrences, so an exact
 * counter would cost thousands of timezone conversions on the first tick after
 * it goes live, and if that tick dies before the watermark is written the
 * identical work repeats on the next tick, forever. Past this cap the result
 * says "at least this many" through a separate flag instead of inventing a
 * number that looks exact.
 */
const DROPPED_BACKLOG_CAP = 50;

/**
 * Hard ceiling on probes in the backwards search. The bisection below needs
 * about log2(now - watermark) of them, which is 31 for a three-week backlog and
 * 53 for a hundred years, so this is never reached in practice. It exists so the
 * loop is bounded by construction and not by an argument about its input.
 */
const MAX_BACKWARD_PROBES = 64;

/**
 * How far before the watermark the search starts.
 *
 * croner answers `nextRun` by converting to local fields, stepping, and
 * converting back. When the argument sits inside a local hour that the zone
 * repeats, that round trip is not faithful, and the result can be wrong in two
 * ways that both matter here. Measured:
 *
 *   Europe/Warsaw, `0 * * * *`, watermark 2026-10-25T00:15:00Z (local 02:15,
 *   the repeated hour): nextRun jumps to 02:00Z and steps straight over the real
 *   01:00Z occurrence.
 *
 *   America/Santiago, a five-minute step: nextRun(2026-04-05T03:00:00.000Z)
 *   returns
 *   2026-04-05T02:05:00.000Z, 55 minutes BEFORE its own argument. 3300 of 14401
 *   probed seconds that day go backwards.
 *
 * Anchoring the search two hours before the watermark puts the anchor outside
 * any real transition, including the thirty-minute shift in Lord Howe, so the
 * sequence the search sees is the same sequence a dispatcher in steady state
 * would produce. Everything is then filtered back to what is strictly after the
 * watermark, so widening the window cannot fire anything twice.
 *
 * Without this, an occurrence is not delayed, it is lost for good: the gate
 * concludes nothing is due, the watermark never moves, and the next tick repeats
 * the same conclusion. Measured loss windows are up to 60 minutes wide, and they
 * exist on the spring transition too, not only the autumn one.
 */
const AMBIGUITY_BACKOFF_MS = 2 * 60 * 60 * 1000;

/**
 * Ceiling on the repair walk inside firstOccurrenceAfter.
 *
 * Not decorative, and not a guess. Measured across every 2026 transition in five
 * zones, the repair needs up to 59 steps, for a once-a-minute expression in
 * America/Santiago: croner hands back an instant an hour behind the argument and
 * the walk climbs a minute at a time until it is genuinely past it.
 *
 * It has to allow for a sub-floor expression because `dueOccurrence` cannot
 * assume the floor. The floor is enforced at deploy time only, against a sample
 * anchored at the moment of the deploy, so a definition stored before the gate
 * existed, or deployed on a day the sample happened to look acceptable, arrives
 * here firing every minute. Measured: at a limit of 4 this search returns the
 * wrong occurrence on 220 of 20,496 checked cases.
 */
const AMBIGUITY_REPAIR_LIMIT = 128;

/** Upper bound on the editor preview, so a bad `count` cannot buy unbounded work. */
const NEXT_RUNS_MAX = 50;

export type ScheduleProblemReason =
  | "invalid-expression"
  | "invalid-timezone"
  | "below-minimum-period"
  | "never-occurs";

export interface ScheduleProblem {
  reason: ScheduleProblemReason;
  /** Human-readable detail, safe to show in the editor next to the field. */
  message: string;
  /** Only on "below-minimum-period": the shortest gap actually measured. */
  minGapMs?: number;
}

export interface ParsedSchedule {
  cron: string;
  timezone: string;
}

export type ScheduleParseResult =
  | { ok: true; schedule: ParsedSchedule }
  | { ok: false; problem: ScheduleProblem };

/**
 * Validate a cron expression and an IANA timezone without throwing.
 *
 * The two checks are not symmetric, because croner is not. Measured: the
 * constructor validates the pattern and throws on a bad one, and it does not
 * validate the timezone at all. `new Cron("0 12 * * *", {timezone:
 * "Nowhere/Nothing"})` constructs happily, and the RangeError arrives later, out
 * of `nextRun`.
 *
 * So the Intl check below is not cosmetic and is not about which field gets
 * blamed. It is the only thing standing between a mistyped zone and an uncaught
 * RangeError thrown inside a route that runs once a minute, from a call that
 * looks like pure arithmetic. Do not remove it on the theory that croner already
 * covers it. It does not.
 *
 * It runs first for a second reason: croner reads an empty or missing zone as
 * "use the host zone" rather than failing. On Vercel the host zone is UTC, so a
 * blank field would look right everywhere in testing and be an hour out for half
 * the year for a European user.
 */
export function parseSchedule(
  cron: string,
  timezone: string,
): ScheduleParseResult {
  const timezoneProblem = validateTimezone(timezone);
  if (timezoneProblem) return { ok: false, problem: timezoneProblem };

  try {
    new Cron(cron, { timezone });
  } catch (error) {
    return {
      ok: false,
      problem: {
        reason: "invalid-expression",
        message: describeError(error),
      },
    };
  }

  return { ok: true, schedule: { cron, timezone } };
}

/**
 * Answer whether a schedule fires more often than the floor allows, returning
 * the problem to report or null when the schedule is acceptable.
 *
 * Also the place where "this expression never fires at all" is caught, for
 * example `0 0 30 2 *`: that is the same forward sample, and a schedule with no
 * occurrences is a deployment mistake rather than a period violation.
 *
 * The sample starts at `now` and is MINIMUM_PERIOD_SAMPLE long, so it only sees
 * the daylight-saving gaps of the coming hours, and the verdict therefore does
 * depend on when it is asked. Measured: in Australia/Lord_Howe, whose shift is
 * thirty minutes, `0,20,40 * * * *` moves between acceptable and
 * below-minimum-period depending on the day, its true minimum gap being ten
 * minutes on the transition. That is a known limit and not a bug to fix here:
 * this rejects patterns that are too frequent by construction, and no bounded
 * sample can prove a cron expression's minimum over all time.
 */
export function violatesMinimumPeriod(
  cron: string,
  timezone: string,
  now: Date,
): ScheduleProblem | null {
  const built = buildCron(cron, timezone);
  if (!built.ok) return built.problem;

  const upcoming = built.cron.nextRuns(MINIMUM_PERIOD_SAMPLE, now);
  if (upcoming.length === 0) {
    return {
      reason: "never-occurs",
      message: `Expression "${cron}" has no occurrences after ${now.toISOString()}.`,
    };
  }

  // A single upcoming occurrence has no gap to measure and cannot violate a
  // period floor, so it passes.
  let minGapMs = Number.POSITIVE_INFINITY;
  for (let index = 1; index < upcoming.length; index += 1) {
    const previous = upcoming[index - 1];
    const current = upcoming[index];
    if (previous === undefined || current === undefined) continue;
    minGapMs = Math.min(minGapMs, current.getTime() - previous.getTime());
  }

  if (minGapMs < MINIMUM_PERIOD_MS) {
    return {
      reason: "below-minimum-period",
      message: `Expression "${cron}" fires every ${formatMinutes(minGapMs)} at its closest, the minimum is ${formatMinutes(MINIMUM_PERIOD_MS)}.`,
      minGapMs,
    };
  }

  return null;
}

/** Bounds on the suggested catch-up window, see suggestedGraceMinutes. */
export const MIN_SUGGESTED_GRACE_MINUTES = 15;
export const MAX_SUGGESTED_GRACE_MINUTES = 12 * 60;

/**
 * A catch-up window that suits this schedule, in minutes, or null if the
 * schedule cannot be evaluated.
 *
 * For the editor to prefill when the schedule changes. Half the period, bounded,
 * because a flat default is wrong at both ends: 60 minutes is unreachable for a
 * 15-minute schedule, where the candidate is by construction less than a period
 * old and staleness therefore never triggers, and it is far too tight for a
 * weekly one, where missing the window by a minute costs a full week.
 *
 * THE RUNTIME MUST NOT CALL THIS. Only the stored value decides whether an
 * occurrence fires. Recomputing a grace window at evaluation time would mean the
 * stored definition no longer describes what runs, which is the same rule that
 * makes compileSchedulePreset return its timezone instead of implying one.
 *
 * Takes `now` for the same reason violatesMinimumPeriod does: the period is
 * measured from a forward sample, and this module has no ambient clock.
 */
export function suggestedGraceMinutes(
  cron: string,
  timezone: string,
  now: Date,
): number | null {
  const built = buildCron(cron, timezone);
  if (!built.ok) return null;

  const upcoming = built.cron.nextRuns(MINIMUM_PERIOD_SAMPLE, now);
  if (upcoming.length < 2) return null;

  // Half of the shortest gap, not the average: the shortest is the one that
  // decides whether a window can overlap the following occurrence.
  let minGapMs = Number.POSITIVE_INFINITY;
  for (let index = 1; index < upcoming.length; index += 1) {
    const previous = upcoming[index - 1];
    const current = upcoming[index];
    if (previous === undefined || current === undefined) continue;
    minGapMs = Math.min(minGapMs, current.getTime() - previous.getTime());
  }
  if (!Number.isFinite(minGapMs)) return null;

  const halfPeriodMinutes = Math.floor(minGapMs / 2 / 60_000);
  return Math.min(
    MAX_SUGGESTED_GRACE_MINUTES,
    Math.max(MIN_SUGGESTED_GRACE_MINUTES, halfPeriodMinutes),
  );
}

/**
 * Step sizes an "every N minutes" preset may use.
 *
 * Restricted to divisors of an hour so the gap is uniform. A step that does not
 * divide sixty wraps at the top of the hour and produces a short gap the user
 * never asked for: a twenty-five minute step fires at :00 :25 :50 :00, a
 * ten-minute gap, and a seven-minute step leaves four minutes.
 *
 * Given that restriction the gap equals the step, and the floor check reduces to
 * comparing the step against the floor, but only because interval presets
 * compile in UTC (see compileSchedulePreset). In a zone whose daylight-saving
 * jump is not a whole hour the equality is false: a twenty-minute step in
 * Australia/Lord_Howe, which shifts by thirty minutes, has a real minimum gap of
 * ten minutes, under the floor, and the deploy-time sample does not see it
 * because it only looks forward from the moment of the deploy.
 */
export const EVERY_N_MINUTES_STEPS = [15, 20, 30, 60] as const;

/** Step sizes an "every N hours" preset may use, divisors of a day for the same reason. */
export const EVERY_N_HOURS_STEPS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

export type EveryNMinutesStep = (typeof EVERY_N_MINUTES_STEPS)[number];
export type EveryNHoursStep = (typeof EVERY_N_HOURS_STEPS)[number];

/** 0 is Sunday, matching the cron day-of-week field. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The shapes the editor's preset builder can produce. Kept deliberately small:
 * anything richer belongs in a raw expression, which goes through exactly the
 * same evaluator.
 */
export type SchedulePreset =
  | { kind: "every-n-minutes"; minutes: EveryNMinutesStep }
  | { kind: "every-n-hours"; hours: EveryNHoursStep }
  | { kind: "daily"; hour: number; minute: number }
  | {
      kind: "weekly";
      weekdays: readonly Weekday[];
      hour: number;
      minute: number;
    };

export type PresetCompileResult =
  | { ok: true; cron: string; timezone: string }
  | { ok: false; problem: ScheduleProblem };

/**
 * The zone interval presets compile into, regardless of what the user picked.
 * Exported so a caller can recognise a compiled interval preset without
 * re-deriving the rule.
 */
export const INTERVAL_PRESET_TIMEZONE = "UTC";

/**
 * Turn a structured preset into a cron expression and the zone it must run in.
 *
 * The point is that the backend has one evaluation path. The editor's preset
 * builder is sugar that compiles down to an expression here and then goes
 * through the same parse, floor and occurrence code as a hand-written one, so a
 * preset can never mean something the raw expression would not.
 *
 * WHY THIS RETURNS A TIMEZONE, which is the whole reason presets are not just
 * strings. "Every 15 minutes" has no clock meaning. An interval is the same
 * interval in every zone, so the zone is irrelevant to it on all but one day a
 * year, when it is actively harmful. Under a zone with a fall-back transition,
 * croner resolves each ambiguous local time to its second, standard-time
 * reading, which is right for a fixed-clock job and an outage for an interval:
 * measured in Europe/Warsaw on 2026-10-25, a 15-minute interval keeps its 96
 * firings but its largest gap becomes 75 minutes, a 30-minute interval 90, and
 * hourly 120. Every gap grows by exactly the length of the repeated hour, and
 * nothing reports it, because those instants were never occurrences: the dropped
 * counter and the stale counter both stay at zero. A customer running triage
 * every 15 minutes gets a queue that stands still from 01:45 to 03:00 local with
 * no log line anywhere. Compiling intervals in UTC removes the transition from
 * the arithmetic entirely.
 *
 * Clock-anchored kinds (daily, weekly, and every-24-hours, which is daily at
 * midnight) keep the user's zone, because for them the wall-clock time is the
 * entire point of the configuration and "once, not twice" is the correct answer.
 *
 * What is stored is what runs: this returns the zone, the editor saves it, and
 * nothing recomputes it at evaluation time. An evaluator that silently
 * substituted a zone would make the stored definition a lie.
 */
export function compileSchedulePreset(
  preset: SchedulePreset,
  timezone: string,
): PresetCompileResult {
  switch (preset.kind) {
    case "every-n-minutes": {
      const { minutes } = preset;
      if (!isAllowedStep(minutes, EVERY_N_MINUTES_STEPS)) {
        return { ok: false, problem: stepProblem(minutes, "minute") };
      }
      // `timezone` is deliberately ignored, see above. 60 is a full hour:
      // `*/60` is accepted by croner but reads as a mistake, and the plain
      // hourly form is what a user recognises in a preview.
      return {
        ok: true,
        cron: minutes === 60 ? "0 * * * *" : `*/${minutes} * * * *`,
        timezone: INTERVAL_PRESET_TIMEZONE,
      };
    }

    case "every-n-hours": {
      const { hours } = preset;
      if (!isAllowedStep(hours, EVERY_N_HOURS_STEPS)) {
        return { ok: false, problem: stepProblem(hours, "hour") };
      }
      // 24 hours is daily at midnight, so it is clock-anchored and keeps the
      // user's zone. Everything below 24 is an interval and compiles in UTC.
      if (hours === 24) {
        const zone = validateTimezone(timezone);
        if (zone) return { ok: false, problem: zone };
        return { ok: true, cron: "0 0 * * *", timezone: timezone.trim() };
      }
      return {
        ok: true,
        cron: `0 */${hours} * * *`,
        timezone: INTERVAL_PRESET_TIMEZONE,
      };
    }

    case "daily": {
      const clock = validateClock(preset.hour, preset.minute);
      if (clock) return { ok: false, problem: clock };
      const zone = validateTimezone(timezone);
      if (zone) return { ok: false, problem: zone };
      return {
        ok: true,
        cron: `${preset.minute} ${preset.hour} * * *`,
        timezone: timezone.trim(),
      };
    }

    case "weekly": {
      const clock = validateClock(preset.hour, preset.minute);
      if (clock) return { ok: false, problem: clock };

      const weekdays = [...new Set(preset.weekdays)].sort((a, b) => a - b);
      if (weekdays.length === 0) {
        return {
          ok: false,
          problem: {
            reason: "never-occurs",
            message: "A weekly schedule needs at least one weekday.",
          },
        };
      }
      if (
        !weekdays.every(
          (day) => Number.isInteger(day) && day >= 0 && day <= 6,
        )
      ) {
        return {
          ok: false,
          problem: {
            reason: "invalid-expression",
            message: `Weekdays must be whole numbers 0 (Sunday) to 6 (Saturday), got ${JSON.stringify(preset.weekdays)}.`,
          },
        };
      }
      const zone = validateTimezone(timezone);
      if (zone) return { ok: false, problem: zone };
      return {
        ok: true,
        cron: `${preset.minute} ${preset.hour} * * ${weekdays.join(",")}`,
        timezone: timezone.trim(),
      };
    }

    default: {
      // Reachable only from untyped input, which is exactly where it matters.
      const unknown: never = preset;
      return {
        ok: false,
        problem: {
          reason: "invalid-expression",
          message: `Unknown schedule preset ${JSON.stringify(unknown)}.`,
        },
      };
    }
  }
}

export interface NextRunsInput {
  cron: string;
  timezone: string;
  /** Occurrences returned are strictly after this instant. */
  from: Date;
  count: number;
}

export type NextRunsResult =
  | { ok: true; runs: Date[] }
  | { ok: false; problem: ScheduleProblem };

/**
 * The next `count` occurrences, for the editor's preview.
 *
 * The editor lives in another package and must not get its own cron library:
 * two implementations of "when does this fire" is how a preview ends up
 * disagreeing with the runtime, which is the single most confusing failure this
 * feature can have. This is the only source of truth for that preview.
 *
 * Can return fewer than `count`, or none at all, when the expression runs out of
 * occurrences. `count` is clamped rather than rejected: the preview length is a
 * display choice, not a property of the schedule.
 */
export function nextRuns(input: NextRunsInput): NextRunsResult {
  const built = buildCron(input.cron, input.timezone);
  if (!built.ok) return { ok: false, problem: built.problem };

  const count = Math.min(
    Math.max(1, Math.floor(input.count) || 1),
    NEXT_RUNS_MAX,
  );
  return { ok: true, runs: built.cron.nextRuns(count, input.from) };
}

export interface DueOccurrenceInput {
  cron: string;
  timezone: string;
  /**
   * Newest occurrence already accounted for. Occurrences at or before it never
   * fire again, which is what makes one occurrence instant fire at most once.
   */
  watermark: Date;
  now: Date;
  /** How late an occurrence may be and still be worth starting. */
  graceMs: number;
}

interface DroppedOlder {
  /** Occurrences older than the candidate that were passed over. */
  droppedOlder: number;
  /** True when `droppedOlder` is a floor, not the exact number. */
  droppedOlderAtLeast: boolean;
  /**
   * Oldest occurrence that was passed over, null when none was.
   *
   * The cap and its flag are honest but not informative on their own: "at least
   * 50" reads the same whether the dispatcher stalled for 51 hours or for eight
   * months on an hourly schedule. This is the first element of a sample that is
   * already computed, so it costs no extra work and turns the count into
   * something an operator can size.
   */
  oldestDroppedAt: Date | null;
}

export type DueOccurrenceResult =
  | { kind: "invalid"; problem: ScheduleProblem }
  | { kind: "nothing-due" }
  | ({
      kind: "due";
      occurrence: Date;
      /** Always the fired occurrence. Named separately so a call site reads the contract. */
      advanceWatermarkTo: Date;
    } & DroppedOlder)
  | ({
      kind: "stale";
      occurrence: Date;
      /**
       * Set even though nothing fired. The occurrence is past its grace and will
       * never be worth running, so leaving the watermark behind it means the
       * next tick reaches the same conclusion about the same instant, forever.
       */
      advanceWatermarkTo: Date;
      staleByMs: number;
      /**
       * When the schedule will next fire, null if it never will.
       *
       * `staleByMs` measures the wrong thing on its own, because it is the miss
       * against the grace window and not the cost of the miss. A weekly schedule
       * that misses by one minute reports staleByMs = 60000 while the next real
       * run is 168 hours away, four orders of magnitude apart. A caller logging a
       * skip needs this number, not that one.
       */
      nextOccurrenceAt: Date | null;
    } & DroppedOlder);

/**
 * Decide which single occurrence, if any, should fire on this tick.
 *
 * Semantics, exactly:
 *   - only occurrences strictly after `watermark` and at or before `now` count;
 *   - if there are none, nothing fires and the watermark does not move;
 *   - of the ones that count, only the newest is a candidate. A schedule that
 *     was paused, or whose deploy was broken for a week, must not stampede a
 *     week of runs when it comes back, and older occurrences of a recurring job
 *     carry no information the newest one does not;
 *   - the candidate fires only if it is at most `graceMs` late;
 *   - either way the caller is told what to store as the new watermark.
 *
 * A NOTE ON "stale" BEING UNREACHABLE FOR DENSE SCHEDULES, which is correct and
 * not a gap. Because the candidate is the newest occurrence no later than `now`,
 * the candidate is always less than one period old. So any schedule whose period
 * is shorter than `graceMs` can never produce a stale verdict: measured, an
 * eight-day window with a three-day dispatcher outage yields zero stale verdicts
 * for 15-minute, 30-minute, hourly and two-hourly schedules. There is nothing to
 * protect against there, since firing the newest occurrence is exactly right.
 * Staleness only bites when the period is longer than the grace window, which is
 * the daily-and-longer case, and that is the case it exists for.
 */
export function dueOccurrence(
  input: DueOccurrenceInput,
): DueOccurrenceResult {
  const built = buildCron(input.cron, input.timezone);
  if (!built.ok) return { kind: "invalid", problem: built.problem };

  const { watermark, now, graceMs } = input;
  const nowMs = now.getTime();
  const watermarkMs = watermark.getTime();
  // A watermark at or after now leaves an empty window. Reachable through clock
  // skew between instances, so it is answered rather than asserted.
  if (!(watermarkMs < nowMs)) return { kind: "nothing-due" };

  const candidate = newestOccurrenceAtOrBefore(built.cron, watermark, now);
  if (candidate === null) return { kind: "nothing-due" };

  // Only now is the backlog sample worth paying for. Fifteen ticks out of
  // sixteen have nothing due, and at about 92 microseconds per croner call a
  // fifty-one element sample is roughly 4.7ms per schedule per tick, charged
  // whether or not anything fires. The poll iterates over every schedule and has
  // no time budget, so the sample belongs behind the answer, not in front of it.
  const dropped = countDroppedBetween(built.cron, watermark, candidate);
  const lateBy = nowMs - candidate.getTime();

  if (lateBy <= graceMs) {
    return {
      kind: "due",
      occurrence: candidate,
      advanceWatermarkTo: candidate,
      ...dropped,
    };
  }

  return {
    kind: "stale",
    occurrence: candidate,
    advanceWatermarkTo: candidate,
    staleByMs: lateBy - graceMs,
    // One extra croner call, on the path that skips a run. Worth it: this is the
    // number the caller has to put in front of a human, see the field's comment.
    nextOccurrenceAt: built.cron.nextRun(candidate),
    ...dropped,
  };
}

/**
 * The first occurrence strictly after `afterMs`, which is not what `nextRun`
 * gives you.
 *
 * `nextRun` is documented as "find next runtime, based on supplied date" and is
 * that for almost every argument, but it converts to local fields, steps, and
 * converts back, so an argument inside a local hour the zone repeats can come
 * back *before* itself. Measured, America/Santiago, a five-minute step:
 * nextRun(2026-04-05T03:00:00.000Z) = 2026-04-05T02:05:00.000Z, 55 minutes
 * backwards, and 3300 of 14401 probed seconds that day do the same.
 *
 * Left alone that is not a rounding error, it is a duplicate run: a candidate
 * before the watermark moves the watermark backwards, and the occurrence it
 * points at fires a second time. Measured on chained arbitrary watermarks for
 * a five-minute step, 55 of 121 seeds walked the watermark backwards by up to 55
 * minutes and 16 of 121 fired one occurrence twice. Two expensive agent runs for
 * one schedule tick is the worst outcome this module has.
 *
 * So the value is repaired rather than trusted: step forward until it really is
 * past the argument, and give up rather than return something that is not. Every
 * caller here goes through this instead of calling `nextRun` directly.
 */
function firstOccurrenceAfter(cron: Cron, afterMs: number): Date | null {
  let run = cron.nextRun(new Date(afterMs));
  if (run === null) return null;

  for (let step = 0; run.getTime() <= afterMs; step += 1) {
    if (step >= AMBIGUITY_REPAIR_LIMIT) return null;
    const later = cron.nextRun(run);
    // No forward progress means croner cannot get past this instant, so there is
    // no honest answer to give. Better a missed tick than a backwards watermark.
    if (later === null || later.getTime() <= run.getTime()) return null;
    run = later;
  }
  return run;
}

/**
 * Newest occurrence in (watermark, now], found by bisecting the probe instant
 * rather than by enumerating forward.
 *
 * croner has no backwards method. `previousRun()` exists but only reports the
 * last time a live job actually triggered, it computes nothing, so a backwards
 * walk has to be built. Since `firstOccurrenceAfter` is genuinely the first
 * occurrence after its argument, it is non-decreasing, which makes
 *
 *     P(t) := an occurrence exists in (t, now]
 *
 * true for small `t` and false for large `t`, flipping at the newest occurrence
 * L: at `t = L - 1ms` the first occurrence after `t` is L itself, at `t = L` it
 * is the one after L, which is past now. So the largest `t` with P(t) true gives
 * L directly.
 *
 * This is the whole reason the module is cheap. A five-minute schedule that sat
 * unwatched for three weeks costs about 33 probes against 6048 for a forward
 * walk, and the cost follows the *width* of the window, not how many occurrences
 * it holds, so a misconfigured schedule cannot make the tick expensive.
 *
 * The monotonicity is only real because `firstOccurrenceAfter` repairs croner's
 * answer, so do not replace it with a bare `nextRun` here. And the search starts
 * at `watermark - AMBIGUITY_BACKOFF_MS` rather than at the watermark, because a
 * watermark inside a repeated local hour makes croner step over the real
 * occurrence entirely and the gate would then conclude nothing is due, forever.
 * Everything is filtered back to strictly after the watermark at the end, so the
 * wider window cannot fire anything early or twice.
 *
 * With those two, the bisection is exact and needs no forward repair after it.
 * There was a confirmation walk here to absorb undershoot; it was removed after
 * measuring that it never advanced once across 20,496 cases spanning every 2026
 * transition in eight zones, and that removing it changes no answer. Undershoot
 * was a symptom of the unfaithful predicate, not of the bisection.
 */
function newestOccurrenceAtOrBefore(
  cron: Cron,
  watermark: Date,
  now: Date,
): Date | null {
  const nowMs = now.getTime();
  const watermarkMs = watermark.getTime();
  const searchFromMs = watermarkMs - AMBIGUITY_BACKOFF_MS;

  const hasOccurrenceBeforeNow = (probeMs: number): boolean => {
    const run = firstOccurrenceAfter(cron, probeMs);
    return run !== null && run.getTime() <= nowMs;
  };

  // Establishes the bisection's left invariant. It is also the whole gate: no
  // occurrence in (searchFrom, now] means none in the narrower (watermark, now].
  if (!hasOccurrenceBeforeNow(searchFromMs)) return null;

  let low = searchFromMs;
  let high = nowMs;
  for (let probe = 0; probe < MAX_BACKWARD_PROBES && high - low > 1; probe += 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (hasOccurrenceBeforeNow(middle)) low = middle;
    else high = middle;
  }

  const candidate = firstOccurrenceAfter(cron, low);
  if (candidate === null || candidate.getTime() > nowMs) return null;

  // The one rule the caller's correctness rests on. The search window reaches
  // back before the watermark on purpose, so this is where that widening is paid
  // back: an occurrence at or before the watermark has already been accounted
  // for, and returning it would move the watermark backwards and fire it twice.
  return candidate.getTime() > watermarkMs ? candidate : null;
}

/**
 * Occurrences passed over between the watermark and the candidate, capped.
 *
 * Enumerated from the same backed-off anchor as the search, for the same reason,
 * then filtered to the half-open window the caller actually cares about. The cap
 * is what keeps this bounded: an exact count means walking the whole missed
 * history, which for a five-minute schedule idle for three weeks is six thousand
 * conversions on the tick that can least afford them.
 *
 * "Exact" is decided honestly. If the sample ran out, or if it reached past the
 * candidate, then nothing before the candidate is missing from it. Otherwise the
 * count is a floor and says so, because turning three weeks of missed runs into a
 * confident "50" is worse than admitting the number is a lower bound.
 */
function countDroppedBetween(
  cron: Cron,
  watermark: Date,
  candidate: Date,
): DroppedOlder {
  const watermarkMs = watermark.getTime();
  const candidateMs = candidate.getTime();

  // Anchored on the first real occurrence after the watermark, not on the
  // watermark itself. Two reasons: the watermark can sit inside a repeated local
  // hour, where croner steps over occurrences, and an occurrence anchor means all
  // of the sampled slots land inside the window being counted. Anchoring on
  // `watermark - AMBIGUITY_BACKOFF_MS` instead would spend them on already
  // accounted for history, which on a five-minute schedule is 24 of 51 slots and
  // silently weakens the reported floor from 50 to 27.
  const first = firstOccurrenceAfter(cron, watermarkMs);
  if (first === null || first.getTime() >= candidateMs) {
    return {
      droppedOlder: 0,
      droppedOlderAtLeast: false,
      oldestDroppedAt: null,
    };
  }

  const sample = [first, ...cron.nextRuns(DROPPED_BACKLOG_CAP, first)];
  const dropped = sample.filter((occurrence) => {
    const ms = occurrence.getTime();
    return ms > watermarkMs && ms < candidateMs;
  });

  const last = sample[sample.length - 1];
  const reachedCandidate = last !== undefined && last.getTime() >= candidateMs;
  const exact = sample.length <= DROPPED_BACKLOG_CAP || reachedCandidate;

  return {
    droppedOlder: Math.min(dropped.length, DROPPED_BACKLOG_CAP),
    droppedOlderAtLeast: !exact,
    oldestDroppedAt: dropped[0] ?? null,
  };
}

type BuiltCron =
  | { ok: true; cron: Cron }
  | { ok: false; problem: ScheduleProblem };

/**
 * Build a croner instance or report why not. Passing no callback means no timer
 * and no entry in croner's global `scheduledJobs`, so this stays a pure
 * calculator: constructing one has no effect a caller has to undo.
 */
function buildCron(cron: string, timezone: string): BuiltCron {
  const parsed = parseSchedule(cron, timezone);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  return { ok: true, cron: new Cron(cron, { timezone }) };
}

/**
 * Reject a timezone before croner sees it.
 *
 * Three separate refusals, because Intl alone is too weak an authority here.
 *
 * Blank, which croner reads as "use the host zone" instead of failing. A
 * schedule that runs in the host zone because a field was empty is
 * indistinguishable from a correct one in every log line.
 *
 * A fixed offset, which Intl accepts: `+05:30` and `-08:00` both parse. A user
 * types `+02:00` meaning Poland, everything agrees all summer, and from the last
 * Sunday of October every single run is an hour off. The preview cannot show it
 * because the preview uses the same offset, and nothing in the log distinguishes
 * it from a correct configuration. A zone that does not observe its own
 * daylight-saving rule is a bug with a delay fuse, so it is refused at
 * authoring time with a message that says why.
 *
 * The whole `Etc/*` family, for the same reason plus a sign trap: `Etc/GMT+5`
 * means UTC-5, inverted against everyone's intuition. Nobody picks it on
 * purpose, so accepting it only converts a typo into a silent five-hour shift.
 *
 * What is left, plain `UTC` and the regional `Area/Location` names, is exactly
 * the set that tracks daylight saving. Membership of that set is still Intl's
 * call, so genuinely misspelled names keep the "unknown" message.
 */
function validateTimezone(timezone: string): ScheduleProblem | null {
  if (typeof timezone !== "string" || timezone.trim() === "") {
    return {
      reason: "invalid-timezone",
      message: "A timezone is required, there is no default.",
    };
  }

  const candidate = timezone.trim();
  const isUtc = candidate.toUpperCase() === "UTC";
  if (!isUtc && !candidate.includes("/")) {
    return {
      reason: "invalid-timezone",
      message: `"${timezone}" is not a named timezone. Use "UTC" or a regional name such as "Europe/Warsaw": a fixed offset does not observe daylight saving, so a schedule set that way drifts by an hour twice a year.`,
    };
  }
  if (candidate.toLowerCase().startsWith("etc/")) {
    return {
      reason: "invalid-timezone",
      message: `"${timezone}" is a fixed-offset zone, and its sign is inverted from what it looks like ("Etc/GMT+5" means UTC-5). Use "UTC" or a regional name such as "Europe/Warsaw", which follows daylight saving.`,
    };
  }

  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate });
  } catch {
    return {
      reason: "invalid-timezone",
      message: `Unknown IANA timezone "${timezone}".`,
    };
  }
  return null;
}

function isAllowedStep<T extends number>(
  value: number,
  allowed: readonly T[],
): value is T {
  return (allowed as readonly number[]).includes(value);
}

function stepProblem(value: number, unit: "minute" | "hour"): ScheduleProblem {
  const allowed =
    unit === "minute" ? EVERY_N_MINUTES_STEPS : EVERY_N_HOURS_STEPS;
  const wheel = unit === "minute" ? 60 : 24;
  const unitMs = unit === "minute" ? 60_000 : 3_600_000;

  // The real minimum gap of a step, which is not the step itself when the step
  // does not divide the wheel: the last firing before the wheel turns over sits
  // short by the remainder. A 25 minute step fires at :00 :25 :50 and then :00,
  // so its true minimum is ten minutes, under the floor. Reporting that as
  // merely "uneven" would file a floor violation as a style complaint.
  const minGapMs =
    Number.isInteger(value) && value > 0 && value < wheel
      ? Math.min(value, wheel - value * Math.floor((wheel - 1) / value)) * unitMs
      : value * unitMs;

  if (minGapMs < MINIMUM_PERIOD_MS) {
    return {
      reason: "below-minimum-period",
      message: `Every ${value} ${unit}s puts occurrences as little as ${formatMinutes(minGapMs)} apart, the minimum is ${formatMinutes(MINIMUM_PERIOD_MS)}.`,
      minGapMs,
    };
  }
  return {
    reason: "invalid-expression",
    message: `Every ${value} ${unit}s would leave uneven gaps, pick one of ${allowed.join(", ")}.`,
  };
}

function validateClock(hour: number, minute: number): ScheduleProblem | null {
  const valid =
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59;
  if (valid) return null;
  return {
    reason: "invalid-expression",
    message: `Time of day must be a whole hour 0-23 and minute 0-59, got ${hour}:${minute}.`,
  };
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  const rounded = Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(2));
  return `${rounded} minute${rounded === 1 ? "" : "s"}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
