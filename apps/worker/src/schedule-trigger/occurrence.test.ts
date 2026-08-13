import { describe, expect, it } from "vitest";
import {
  compileSchedulePreset,
  dueOccurrence,
  EVERY_N_HOURS_STEPS,
  EVERY_N_MINUTES_STEPS,
  MAX_SUGGESTED_GRACE_MINUTES,
  MIN_SUGGESTED_GRACE_MINUTES,
  MINIMUM_PERIOD_MS,
  nextRuns,
  parseSchedule,
  suggestedGraceMinutes,
  violatesMinimumPeriod,
  type SchedulePreset,
  type Weekday,
} from "./occurrence.js";

/**
 * Every instant here is a hand-built Date and every function under test is given
 * `now` explicitly. No fake timers: the module has no ambient clock to fake, and
 * a frozen system clock would hide the one class of bug these tests exist for,
 * an occurrence computed against the host timezone instead of the schedule's.
 *
 * Europe/Warsaw 2026 transitions, which the daylight-saving cases turn on:
 *   - spring forward, 2026-03-29: 02:00 CET becomes 03:00 CEST, so local
 *     02:00-02:59 does not exist that day;
 *   - fall back, 2026-10-25: 03:00 CEST becomes 02:00 CET, so local 02:00-02:59
 *     happens twice, first at 00:00-00:59Z (UTC+2), then at 01:00-01:59Z (UTC+1).
 */

const WARSAW = "Europe/Warsaw";
const KOLKATA = "Asia/Kolkata";

/** Renders an instant on a wall clock, so a pinned assertion reads like the user's view. */
function localClock(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(instant);
}

const at = (iso: string): Date => new Date(iso);

describe("parseSchedule", () => {
  it("accepts a valid expression with an IANA timezone", () => {
    expect(parseSchedule("30 9 * * 1-5", WARSAW)).toEqual({
      ok: true,
      schedule: { cron: "30 9 * * 1-5", timezone: WARSAW },
    });
  });

  it("rejects a malformed expression", () => {
    const result = parseSchedule("every tuesday", "UTC");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-expression",
    );
  });

  it("rejects an out-of-range field", () => {
    const result = parseSchedule("99 * * * *", "UTC");
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-expression",
    );
  });

  it("rejects an unknown timezone instead of falling back to UTC", () => {
    const result = parseSchedule("0 9 * * *", "Europe/Warszawa");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-timezone",
    );
  });

  it("rejects a blank timezone, which croner would read as the host zone", () => {
    for (const blank of ["", "   "]) {
      const result = parseSchedule("0 9 * * *", blank);
      expect(result.ok === false && result.problem.reason).toBe(
        "invalid-timezone",
      );
      expect(result.ok === false && result.problem.message).toContain(
        "no default",
      );
    }
  });

  it("blames the timezone, not the expression, when both are wrong", () => {
    const result = parseSchedule("nonsense", "Mars/Olympus_Mons");
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-timezone",
    );
  });

  it("rejects a fixed offset, which Intl accepts and which does not follow daylight saving", () => {
    // The failure being prevented: an author types +02:00 meaning Poland,
    // everything agrees all summer, and from the last Sunday of October every run
    // is an hour off. The preview cannot show it, because the preview uses the
    // same offset, and no log line distinguishes it from a correct setup.
    for (const offset of ["+05:30", "-08:00", "+02:00", "GMT+5", "UTC+2"]) {
      const result = parseSchedule("0 9 * * *", offset);
      expect(result.ok, offset).toBe(false);
      expect(result.ok === false && result.problem.reason, offset).toBe(
        "invalid-timezone",
      );
      expect(result.ok === false && result.problem.message, offset).toContain(
        "daylight saving",
      );
    }
  });

  it("rejects the Etc family, whose sign is inverted from how it reads", () => {
    // Etc/GMT+5 is UTC-5. Nobody picks it deliberately, so accepting it only
    // turns a typo into a silent five-hour shift. Pinned because it is an easy
    // rule to delete by accident.
    const shifted = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Etc/GMT+5",
      timeStyle: "short",
      hour12: false,
    }).format(at("2026-08-05T12:00:00.000Z"));
    expect(shifted).toBe("07:00");

    for (const zone of ["Etc/GMT+5", "Etc/GMT-5", "Etc/UTC", "etc/gmt+5"]) {
      const result = parseSchedule("0 9 * * *", zone);
      expect(result.ok, zone).toBe(false);
      expect(result.ok === false && result.problem.reason, zone).toBe(
        "invalid-timezone",
      );
    }
  });

  it("accepts UTC and regional names, the zones that do follow daylight saving", () => {
    for (const zone of [
      "UTC",
      "utc",
      WARSAW,
      KOLKATA,
      "America/Santiago",
      "Australia/Lord_Howe",
      "Pacific/Chatham",
    ]) {
      expect(parseSchedule("0 9 * * *", zone).ok, zone).toBe(true);
    }
  });

  it("keeps the unknown-name message for a genuine misspelling", () => {
    const result = parseSchedule("0 9 * * *", "Europe/Warszawa");
    expect(result.ok === false && result.problem.message).toContain(
      "Unknown IANA timezone",
    );
  });
});

describe("violatesMinimumPeriod", () => {
  const NOW = at("2026-08-05T12:00:00.000Z");

  it("accepts a schedule exactly at the floor", () => {
    expect(violatesMinimumPeriod("*/15 * * * *", WARSAW, NOW)).toBeNull();
    expect(MINIMUM_PERIOD_MS).toBe(15 * 60 * 1000);
  });

  it("accepts hourly and daily schedules", () => {
    expect(violatesMinimumPeriod("0 * * * *", WARSAW, NOW)).toBeNull();
    expect(violatesMinimumPeriod("30 2 * * *", WARSAW, NOW)).toBeNull();
  });

  it("rejects a schedule below the floor and reports the measured gap", () => {
    const problem = violatesMinimumPeriod("*/5 * * * *", "UTC", NOW);
    expect(problem?.reason).toBe("below-minimum-period");
    expect(problem?.minGapMs).toBe(5 * 60 * 1000);
  });

  it("catches a short gap that only the third occurrence reveals", () => {
    // "0,1" looks like two occurrences an hour and is really a one-minute gap
    // followed by a fifty-nine minute one, which comparing the first two
    // occurrences alone would call a fifty-nine minute period.
    const problem = violatesMinimumPeriod("0,1 * * * *", "UTC", NOW);
    expect(problem?.reason).toBe("below-minimum-period");
    expect(problem?.minGapMs).toBe(60 * 1000);
  });

  it("catches the wrap-around gap of a step that does not divide the hour", () => {
    // :00 :25 :50 then :00 again, so the real minimum is ten minutes.
    const problem = violatesMinimumPeriod("*/25 * * * *", "UTC", NOW);
    expect(problem?.reason).toBe("below-minimum-period");
    expect(problem?.minGapMs).toBe(10 * 60 * 1000);
  });

  it("reports an expression that can never fire", () => {
    const problem = violatesMinimumPeriod("0 0 30 2 *", "UTC", NOW);
    expect(problem?.reason).toBe("never-occurs");
  });

  it("propagates a bad timezone rather than measuring in the host zone", () => {
    expect(violatesMinimumPeriod("0 * * * *", "Nowhere/Nothing", NOW)?.reason).toBe(
      "invalid-timezone",
    );
  });
});

describe("compileSchedulePreset", () => {
  // [preset, expected cron, expected timezone]. The zone is half the output:
  // interval presets compile in UTC no matter what the author picked, because an
  // interval has no clock meaning and a zone can only damage it on a transition
  // day. Clock-anchored kinds keep the author's zone.
  const cases: ReadonlyArray<[SchedulePreset, string, string]> = [
    [{ kind: "every-n-minutes", minutes: 15 }, "*/15 * * * *", "UTC"],
    [{ kind: "every-n-minutes", minutes: 20 }, "*/20 * * * *", "UTC"],
    [{ kind: "every-n-minutes", minutes: 30 }, "*/30 * * * *", "UTC"],
    [{ kind: "every-n-minutes", minutes: 60 }, "0 * * * *", "UTC"],
    [{ kind: "every-n-hours", hours: 1 }, "0 */1 * * *", "UTC"],
    [{ kind: "every-n-hours", hours: 6 }, "0 */6 * * *", "UTC"],
    [{ kind: "every-n-hours", hours: 24 }, "0 0 * * *", WARSAW],
    [{ kind: "daily", hour: 9, minute: 30 }, "30 9 * * *", WARSAW],
    [{ kind: "daily", hour: 0, minute: 0 }, "0 0 * * *", WARSAW],
    [{ kind: "daily", hour: 23, minute: 59 }, "59 23 * * *", WARSAW],
    [
      { kind: "weekly", weekdays: [1, 3, 5], hour: 8, minute: 15 },
      "15 8 * * 1,3,5",
      WARSAW,
    ],
    [{ kind: "weekly", weekdays: [0], hour: 22, minute: 0 }, "0 22 * * 0", WARSAW],
  ];

  it.each(cases)("compiles %j to %s in %s", (preset, cron, timezone) => {
    expect(compileSchedulePreset(preset, WARSAW)).toEqual({
      ok: true,
      cron,
      timezone,
    });
  });

  it("pins an interval preset to UTC even when the author picked a zone with transitions", () => {
    // The failure this prevents, measured in Europe/Warsaw on 2026-10-25: with
    // the author's zone, croner resolves each repeated local time to its second
    // reading, so a 15-minute interval still fires 96 times but its largest gap
    // grows from 15 minutes to 75, and nothing reports it because those instants
    // were never occurrences. Triage that runs every 15 minutes would stand still
    // from 01:45 to 03:00 local with no log line.
    for (const zone of [WARSAW, "America/Santiago", "Australia/Lord_Howe"]) {
      expect(
        compileSchedulePreset({ kind: "every-n-minutes", minutes: 15 }, zone),
      ).toEqual({ ok: true, cron: "*/15 * * * *", timezone: "UTC" });
    }

    // And the proof that it matters. Measured: the stall runs from the last
    // firing at 2026-10-24T23:45Z to the next at 2026-10-25T01:00Z, so the
    // preview has to start before 23:45Z to contain it.
    const gaps = (timezone: string) => {
      const runs = nextRuns({
        cron: "*/15 * * * *",
        timezone,
        from: at("2026-10-24T23:00:00.000Z"),
        count: 12,
      });
      if (!runs.ok) throw new Error("preview failed");
      return runs.runs
        .slice(1)
        .map((run, index) =>
          Math.round(
            (run.getTime() - (runs.runs[index] as Date).getTime()) / 60000,
          ),
        );
    };
    expect(Math.max(...gaps("UTC"))).toBe(15);
    expect(Math.max(...gaps(WARSAW))).toBe(75);
  });

  it("keeps the author's zone for clock-anchored presets, where the wall time is the point", () => {
    expect(
      compileSchedulePreset({ kind: "daily", hour: 9, minute: 0 }, "Asia/Kolkata"),
    ).toEqual({ ok: true, cron: "0 9 * * *", timezone: "Asia/Kolkata" });
    expect(
      compileSchedulePreset({ kind: "every-n-hours", hours: 24 }, "Asia/Kolkata"),
    ).toEqual({ ok: true, cron: "0 0 * * *", timezone: "Asia/Kolkata" });
  });

  it("rejects an unusable zone on a clock-anchored preset, and ignores it on an interval", () => {
    const bad = compileSchedulePreset(
      { kind: "daily", hour: 9, minute: 0 },
      "+05:30",
    );
    expect(bad.ok === false && bad.problem.reason).toBe("invalid-timezone");

    // An interval never reads the zone, so a bad one cannot fail a preset whose
    // output does not contain it.
    expect(
      compileSchedulePreset({ kind: "every-n-minutes", minutes: 30 }, "+05:30"),
    ).toEqual({ ok: true, cron: "*/30 * * * *", timezone: "UTC" });
  });

  it("sorts and de-duplicates weekdays so one preset has one expression", () => {
    expect(
      compileSchedulePreset(
        { kind: "weekly", weekdays: [5, 1, 5, 0], hour: 8, minute: 15 },
        WARSAW,
      ),
    ).toEqual({ ok: true, cron: "15 8 * * 0,1,5", timezone: WARSAW });
  });

  it("never compiles to a schedule the evaluator would refuse, in any zone or season", () => {
    // Previously this checked one zone at one instant, and the invariant it
    // claimed was false: `*/20` in Australia/Lord_Howe, whose shift is thirty
    // minutes, really has a ten-minute gap on the transition day, under the
    // floor. Compiling intervals in UTC is what makes the invariant true, so the
    // test now sweeps the zones and the instants that used to break it.
    const zones = [
      "UTC",
      WARSAW,
      KOLKATA,
      "Australia/Lord_Howe",
      "America/Santiago",
      "Pacific/Chatham",
    ];
    const instants = [
      at("2026-01-15T12:00:00.000Z"),
      at("2026-03-29T00:30:00.000Z"),
      at("2026-04-05T03:30:00.000Z"),
      at("2026-08-05T12:00:00.000Z"),
      // Lord Howe springs forward by thirty minutes here, which is the instant
      // that used to break this invariant. Without it the sweep proves nothing.
      at("2026-10-03T12:00:00.000Z"),
      at("2026-10-25T00:30:00.000Z"),
    ];

    for (const zone of zones) {
      for (const [preset] of cases) {
        const compiled = compileSchedulePreset(preset, zone);
        expect(compiled.ok, `${JSON.stringify(preset)} @ ${zone}`).toBe(true);
        if (!compiled.ok) continue;
        expect(parseSchedule(compiled.cron, compiled.timezone).ok).toBe(true);
        for (const now of instants) {
          expect(
            violatesMinimumPeriod(compiled.cron, compiled.timezone, now),
            `${compiled.cron} @ ${compiled.timezone} at ${now.toISOString()}`,
          ).toBeNull();
        }
      }
    }
  }, 30_000);

  it("shows the invariant has teeth by failing for the same preset in the author's zone", () => {
    // Not a rule, a demonstration: this is exactly what the compiler avoids by
    // returning UTC. If someone "simplifies" it to pass the author's zone
    // through, the sweep above starts failing on this expression. Measured: Lord
    // Howe springs forward thirty minutes on 2026-10-03, so local :40 is followed
    // ten real minutes later by local :00.
    const problem = violatesMinimumPeriod(
      "*/20 * * * *",
      "Australia/Lord_Howe",
      at("2026-10-03T12:00:00.000Z"),
    );
    expect(problem?.reason).toBe("below-minimum-period");
    expect(problem?.minGapMs).toBe(10 * 60 * 1000);
  });

  it("rejects a sub-floor step as below the minimum period", () => {
    const result = compileSchedulePreset(
      { kind: "every-n-minutes", minutes: 5 as unknown as 15 },
      WARSAW,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.reason).toBe(
      "below-minimum-period",
    );
  });

  it("rejects a step that would leave uneven gaps even when it clears the floor", () => {
    // 45 minutes is well above the floor and its shortest gap is exactly the
    // floor, so this is not a period violation: it fires at :00 :45 then :00
    // again, and a preset that says "every 45 minutes" while behaving like
    // "every 45 minutes, then every 15" is a lie the editor should not offer.
    const result = compileSchedulePreset(
      { kind: "every-n-minutes", minutes: 45 as unknown as 15 },
      WARSAW,
    );
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-expression",
    );
    expect(result.ok === false && result.problem.message).toContain(
      EVERY_N_MINUTES_STEPS.join(", "),
    );
  });

  it("calls a step whose wrap-around gap is sub-floor a period violation, not a style problem", () => {
    // A 25 minute step reads as comfortably above the 15 minute floor and is not:
    // it fires at :00 :25 :50 then :00, a real minimum of ten minutes. Reporting
    // that as "uneven gaps" would file a floor violation under the wrong reason
    // and hand the author a message about tidiness instead of about capacity.
    const result = compileSchedulePreset(
      { kind: "every-n-minutes", minutes: 25 as unknown as 15 },
      WARSAW,
    );
    expect(result.ok === false && result.problem.reason).toBe(
      "below-minimum-period",
    );
    expect(result.ok === false && result.problem.minGapMs).toBe(10 * 60 * 1000);
  });

  it("rejects an hour step that does not divide a day", () => {
    const result = compileSchedulePreset(
      { kind: "every-n-hours", hours: 7 as unknown as 1 },
      WARSAW,
    );
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-expression",
    );
    expect(result.ok === false && result.problem.message).toContain(
      EVERY_N_HOURS_STEPS.join(", "),
    );
  });

  it("rejects an out-of-range or fractional time of day", () => {
    for (const [hour, minute] of [
      [24, 0],
      [-1, 0],
      [9, 60],
      [9, -1],
      [9.5, 0],
      [9, 30.5],
    ]) {
      const result = compileSchedulePreset(
        { kind: "daily", hour: hour as number, minute: minute as number },
        WARSAW,
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.problem.reason).toBe(
        "invalid-expression",
      );
    }
  });

  it("rejects a weekly preset with no weekdays and one with a bad weekday", () => {
    expect(
      compileSchedulePreset(
        { kind: "weekly", weekdays: [], hour: 8, minute: 0 },
        WARSAW,
      ),
    ).toEqual({
      ok: false,
      problem: {
        reason: "never-occurs",
        message: "A weekly schedule needs at least one weekday.",
      },
    });

    const result = compileSchedulePreset(
      { kind: "weekly", weekdays: [7 as unknown as Weekday], hour: 8, minute: 0 },
      WARSAW,
    );
    expect(result.ok === false && result.problem.reason).toBe(
      "invalid-expression",
    );
  });
});

describe("nextRuns", () => {
  it("previews occurrences strictly after `from`", () => {
    const result = nextRuns({
      cron: "0 * * * *",
      timezone: "UTC",
      from: at("2026-08-05T12:00:00.000Z"),
      count: 3,
    });
    expect(result.ok && result.runs.map((run) => run.toISOString())).toEqual([
      "2026-08-05T13:00:00.000Z",
      "2026-08-05T14:00:00.000Z",
      "2026-08-05T15:00:00.000Z",
    ]);
  });

  it("keeps whole-hour assumptions out of a half-hour-offset timezone", () => {
    // Asia/Kolkata is UTC+5:30. A daily 09:45 local schedule lands on :15 past
    // the UTC hour, which any code that rounded to whole hours would miss.
    const result = nextRuns({
      cron: "45 9 * * *",
      timezone: KOLKATA,
      from: at("2026-06-01T00:00:00.000Z"),
      count: 2,
    });
    expect(result.ok && result.runs.map((run) => run.toISOString())).toEqual([
      "2026-06-01T04:15:00.000Z",
      "2026-06-02T04:15:00.000Z",
    ]);
    expect(
      result.ok && result.runs[0] && localClock(result.runs[0], KOLKATA),
    ).toBe("01/06/2026, 09:45");
  });

  it("clamps the count instead of buying unbounded work", () => {
    const result = nextRuns({
      cron: "*/15 * * * *",
      timezone: "UTC",
      from: at("2026-08-05T12:00:00.000Z"),
      count: 10_000,
    });
    expect(result.ok && result.runs.length).toBe(50);
  });

  it("returns nothing for an expression that never fires, and rejects bad input", () => {
    expect(
      nextRuns({
        cron: "0 0 30 2 *",
        timezone: "UTC",
        from: at("2026-08-05T12:00:00.000Z"),
        count: 3,
      }),
    ).toEqual({ ok: true, runs: [] });

    const bad = nextRuns({
      cron: "0 * * * *",
      timezone: "Nowhere/Nothing",
      from: at("2026-08-05T12:00:00.000Z"),
      count: 3,
    });
    expect(bad.ok === false && bad.problem.reason).toBe("invalid-timezone");
  });
});

describe("dueOccurrence", () => {
  const HOURLY = { cron: "0 * * * *", timezone: "UTC" } as const;

  it("fires the occurrence standing exactly at now", () => {
    expect(
      dueOccurrence({
        ...HOURLY,
        watermark: at("2026-08-05T11:00:00.000Z"),
        now: at("2026-08-05T12:00:00.000Z"),
        graceMs: 60_000,
      }),
    ).toEqual({
      kind: "due",
      occurrence: at("2026-08-05T12:00:00.000Z"),
      advanceWatermarkTo: at("2026-08-05T12:00:00.000Z"),
      droppedOlder: 0,
      droppedOlderAtLeast: false,
      oldestDroppedAt: null,
    });
  });

  it("does not fire and does not move the watermark when nothing is due", () => {
    // Watermark sitting on the last occurrence, one millisecond before the next.
    expect(
      dueOccurrence({
        ...HOURLY,
        watermark: at("2026-08-05T12:00:00.000Z"),
        now: at("2026-08-05T12:59:59.999Z"),
        graceMs: 60_000,
      }),
    ).toEqual({ kind: "nothing-due" });
  });

  it("fires exactly at the grace boundary and not one millisecond beyond", () => {
    const base = {
      ...HOURLY,
      watermark: at("2026-08-05T11:00:00.000Z"),
      graceMs: 90_000,
    };

    expect(
      dueOccurrence({ ...base, now: at("2026-08-05T12:01:30.000Z") }),
    ).toMatchObject({ kind: "due", occurrence: at("2026-08-05T12:00:00.000Z") });

    expect(
      dueOccurrence({ ...base, now: at("2026-08-05T12:01:30.001Z") }),
    ).toMatchObject({
      kind: "stale",
      occurrence: at("2026-08-05T12:00:00.000Z"),
      staleByMs: 1,
    });
  });

  it("advances the watermark past a stale occurrence, or the same instant retries forever", () => {
    // The invariant with teeth. A stale occurrence is never going to be worth
    // running, so if the caller were told to leave the watermark behind it, the
    // next tick would compute the same candidate, call it stale again, and the
    // schedule would be wedged on one instant for good.
    const stale = dueOccurrence({
      ...HOURLY,
      watermark: at("2026-08-05T11:00:00.000Z"),
      now: at("2026-08-05T12:30:00.000Z"),
      graceMs: 60_000,
    });

    expect(stale).toEqual({
      kind: "stale",
      occurrence: at("2026-08-05T12:00:00.000Z"),
      advanceWatermarkTo: at("2026-08-05T12:00:00.000Z"),
      staleByMs: 30 * 60 * 1000 - 60_000,
      // The number a caller should actually log. staleByMs says "one thing was
      // 29 minutes past its window", this says "the next attempt is at 13:00".
      nextOccurrenceAt: at("2026-08-05T13:00:00.000Z"),
      droppedOlder: 0,
      droppedOlderAtLeast: false,
      oldestDroppedAt: null,
    });

    // Feeding that watermark back leaves the skipped instant behind for good.
    expect(
      dueOccurrence({
        ...HOURLY,
        watermark:
          stale.kind === "stale" ? stale.advanceWatermarkTo : new Date(0),
        now: at("2026-08-05T12:30:00.000Z"),
        graceMs: 60_000,
      }),
    ).toEqual({ kind: "nothing-due" });
  });

  it("fires one occurrence instant at most once across consecutive evaluations", () => {
    const first = dueOccurrence({
      ...HOURLY,
      watermark: at("2026-08-05T11:00:00.000Z"),
      now: at("2026-08-05T12:00:00.000Z"),
      graceMs: 60_000,
    });
    expect(first.kind).toBe("due");
    const watermark =
      first.kind === "due" ? first.advanceWatermarkTo : new Date(0);

    expect(
      dueOccurrence({
        ...HOURLY,
        watermark,
        now: at("2026-08-05T12:00:00.000Z"),
        graceMs: 60_000,
      }),
    ).toEqual({ kind: "nothing-due" });

    expect(
      dueOccurrence({
        ...HOURLY,
        watermark,
        now: at("2026-08-05T13:00:00.000Z"),
        graceMs: 60_000,
      }),
    ).toMatchObject({
      kind: "due",
      occurrence: at("2026-08-05T13:00:00.000Z"),
    });
  });

  it("takes only the newest of a backlog and counts the ones it dropped", () => {
    expect(
      dueOccurrence({
        ...HOURLY,
        watermark: at("2026-08-05T00:00:00.000Z"),
        now: at("2026-08-05T05:30:00.000Z"),
        graceMs: 60 * 60 * 1000,
      }),
    ).toEqual({
      kind: "due",
      occurrence: at("2026-08-05T05:00:00.000Z"),
      advanceWatermarkTo: at("2026-08-05T05:00:00.000Z"),
      // 01:00 through 04:00 passed over. A recurring job carries no information
      // in its older occurrences that the newest one does not.
      droppedOlder: 4,
      droppedOlderAtLeast: false,
      // Sized, not just counted: "4 dropped" plus "the oldest was 01:00" tells an
      // operator how long the dispatcher was away.
      oldestDroppedAt: at("2026-08-05T01:00:00.000Z"),
    });
  });

  it("reports a backlog past the cap as a lower bound instead of an exact count", () => {
    // Five weeks of hourly occurrences, about 850 of them. The counter must not
    // enumerate them, and must not pretend the capped figure is the real one.
    const result = dueOccurrence({
      ...HOURLY,
      watermark: at("2026-07-01T00:00:00.000Z"),
      now: at("2026-08-05T12:30:00.000Z"),
      graceMs: 60 * 60 * 1000,
    });

    expect(result).toEqual({
      kind: "due",
      occurrence: at("2026-08-05T12:00:00.000Z"),
      advanceWatermarkTo: at("2026-08-05T12:00:00.000Z"),
      droppedOlder: 50,
      droppedOlderAtLeast: true,
      // Why the cap needs this alongside it: "at least 50" reads identically
      // whether the dispatcher was away 51 hours or eight months.
      oldestDroppedAt: at("2026-07-01T01:00:00.000Z"),
    });
  });

  it("still finds the newest occurrence after a three-week gap on a dense schedule", () => {
    // The case the backwards search exists for. Enumerating forward would be
    // six thousand timezone conversions inside a once-a-minute route.
    expect(
      dueOccurrence({
        cron: "*/5 * * * *",
        timezone: WARSAW,
        watermark: at("2026-07-15T12:00:00.000Z"),
        now: at("2026-08-05T12:03:21.500Z"),
        graceMs: 5 * 60 * 1000,
      }),
    ).toMatchObject({
      kind: "due",
      occurrence: at("2026-08-05T12:00:00.000Z"),
      droppedOlder: 50,
      droppedOlderAtLeast: true,
    });
  });

  it("keeps a half-hour-offset timezone exact", () => {
    expect(
      dueOccurrence({
        cron: "45 9 * * *",
        timezone: KOLKATA,
        watermark: at("2026-05-31T04:15:00.000Z"),
        now: at("2026-06-01T04:15:00.000Z"),
        graceMs: 60_000,
      }),
    ).toMatchObject({
      kind: "due",
      occurrence: at("2026-06-01T04:15:00.000Z"),
      droppedOlder: 0,
    });
  });

  it("rejects an invalid expression or timezone instead of throwing inside the tick", () => {
    const badCron = dueOccurrence({
      cron: "not a cron",
      timezone: "UTC",
      watermark: at("2026-08-05T11:00:00.000Z"),
      now: at("2026-08-05T12:00:00.000Z"),
      graceMs: 60_000,
    });
    expect(badCron).toMatchObject({
      kind: "invalid",
      problem: { reason: "invalid-expression" },
    });

    const badZone = dueOccurrence({
      cron: "0 * * * *",
      timezone: "Europe/Warszawa",
      watermark: at("2026-08-05T11:00:00.000Z"),
      now: at("2026-08-05T12:00:00.000Z"),
      graceMs: 60_000,
    });
    expect(badZone).toMatchObject({
      kind: "invalid",
      problem: { reason: "invalid-timezone" },
    });
  });

  it("treats a watermark at or after now as an empty window", () => {
    for (const now of [
      at("2026-08-05T12:00:00.000Z"),
      at("2026-08-05T11:59:59.999Z"),
    ]) {
      expect(
        dueOccurrence({
          ...HOURLY,
          watermark: at("2026-08-05T12:00:00.000Z"),
          now,
          graceMs: 60_000,
        }),
      ).toEqual({ kind: "nothing-due" });
    }
  });
});

describe("dueOccurrence across the Europe/Warsaw spring-forward transition", () => {
  const DAILY_0230 = { cron: "30 2 * * *", timezone: WARSAW } as const;

  /**
   * OBSERVED CRONER BEHAVIOUR, pinned deliberately.
   *
   * On 2026-03-29 local 02:30 does not exist in Europe/Warsaw: the clock jumps
   * from 02:00 CET straight to 03:00 CEST. croner does not skip the day and does
   * not pull the run back to 03:00. It fires at 2026-03-29T01:30:00Z, which is
   * 03:30 on the local clock.
   *
   * In plain words, and ONLY for an expression naming a single hour: on the
   * spring-forward day a schedule set to a non-existent local time still runs,
   * exactly once, one hour later than configured by the wall clock (02:30 becomes
   * 03:30). The instant is the one you get by reading the configured local time
   * with the pre-transition (winter) offset.
   *
   * That sentence used to end "nothing is skipped and nothing is doubled", which
   * is false for a whole class of expressions. An hour list spanning the lost hour
   * loses firings, because the remapped instant collides with a real one and the
   * two merge. See the hour-list test below for the measurements. There is no fix
   * available here: the local hour genuinely does not exist, so the second
   * behaviour is pinned as observed rather than corrected.
   */
  it("runs a non-existent local time once, one hour later on the local clock", () => {
    const preview = nextRuns({
      ...DAILY_0230,
      from: at("2026-03-28T02:00:00.000Z"),
      count: 3,
    });

    expect(preview.ok && preview.runs.map((run) => run.toISOString())).toEqual([
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
    // The pinned surprise, spelled out on the wall clock the user reads.
    expect(
      preview.ok && preview.runs[0] && localClock(preview.runs[0], WARSAW),
    ).toBe("29/03/2026, 03:30");
    expect(
      preview.ok && preview.runs[1] && localClock(preview.runs[1], WARSAW),
    ).toBe("30/03/2026, 02:30");
  });

  it("holds nothing due until that instant, then fires it exactly once", () => {
    const base = {
      ...DAILY_0230,
      watermark: at("2026-03-28T01:30:00.000Z"),
      graceMs: 60_000,
    };

    expect(
      dueOccurrence({ ...base, now: at("2026-03-29T01:29:59.999Z") }),
    ).toEqual({ kind: "nothing-due" });

    const fired = dueOccurrence({
      ...base,
      now: at("2026-03-29T01:30:00.000Z"),
    });
    expect(fired).toEqual({
      kind: "due",
      occurrence: at("2026-03-29T01:30:00.000Z"),
      advanceWatermarkTo: at("2026-03-29T01:30:00.000Z"),
      droppedOlder: 0,
      droppedOlderAtLeast: false,
      oldestDroppedAt: null,
    });

    // The transition does not shake a second run out of the same day.
    expect(
      dueOccurrence({
        ...DAILY_0230,
        watermark: at("2026-03-29T01:30:00.000Z"),
        now: at("2026-03-29T23:59:59.999Z"),
        graceMs: 60_000,
      }),
    ).toEqual({ kind: "nothing-due" });
  });

  /**
   * SECOND OBSERVED CRONER BEHAVIOUR, pinned deliberately.
   *
   * An expression naming several hours loses firings on the spring-forward day.
   * The non-existent local time is remapped onto the instant a later, real entry
   * already occupies, and the two become one. Measured in Europe/Warsaw:
   *
   *   "30 2,3 * * *"          2 firings on a normal day, 1 on 2026-03-29
   *   "0 2,3 * * *"           2 firings on a normal day, 1 on 2026-03-29
   *   a 15 minute step over
   *   hours 2 and 3           8 firings on a normal day, 4 on 2026-03-29
   *
   * Not fixable in this module: those local times do not exist that day, so there
   * is no instant to fire at. Recorded so the behaviour is defined, which is what
   * the ticket asks for, and so nobody documents the single-hour rule as if it
   * generalised.
   */
  it("loses firings from an hour list that spans the non-existent hour, by merging them", () => {
    const firingsOn = (cron: string, dayStart: string): Date[] => {
      const preview = nextRuns({
        cron,
        timezone: WARSAW,
        from: at(dayStart),
        count: 20,
      });
      if (!preview.ok) throw new Error(`preview failed for ${cron}`);
      const dayEnd = at(dayStart).getTime() + 24 * 60 * 60 * 1000;
      return preview.runs.filter((run) => run.getTime() < dayEnd);
    };

    const transitionDay = "2026-03-29T00:00:00.000Z";
    const normalDay = "2026-03-22T00:00:00.000Z";

    for (const [cron, normal, transition] of [
      ["30 2,3 * * *", 2, 1],
      ["0 2,3 * * *", 2, 1],
      ["*/15 2,3 * * *", 8, 4],
    ] as const) {
      expect(firingsOn(cron, normalDay).length, `${cron} normal day`).toBe(
        normal,
      );
      expect(
        firingsOn(cron, transitionDay).length,
        `${cron} transition day`,
      ).toBe(transition);
    }

    // The surviving firing is the one at the later hour, and the 02:30 entry has
    // been absorbed into it rather than moved somewhere else.
    const survivor = firingsOn("30 2,3 * * *", transitionDay)[0] as Date;
    expect(survivor.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(localClock(survivor, WARSAW)).toBe("29/03/2026, 03:30");

    // A single-hour expression does not merge, which is why the rule above is
    // stated only for that case.
    expect(firingsOn("30 2 * * *", normalDay).length).toBe(1);
    expect(firingsOn("30 2 * * *", transitionDay).length).toBe(1);
  });
});

describe("dueOccurrence across the Europe/Warsaw fall-back transition", () => {
  const DAILY_0230 = { cron: "30 2 * * *", timezone: WARSAW } as const;

  /**
   * OBSERVED CRONER BEHAVIOUR, pinned deliberately.
   *
   * On 2026-10-25 local 02:30 happens twice, at 00:30Z (CEST, UTC+2) and again
   * at 01:30Z (CET, UTC+1). croner treats only the second, standard-time reading
   * as an occurrence. The first is not an occurrence at all, so a daily 02:30
   * schedule fires once on the fall-back day rather than twice.
   */
  it("both instants really are the same local time", () => {
    expect(localClock(at("2026-10-25T00:30:00.000Z"), WARSAW)).toBe(
      "25/10/2026, 02:30",
    );
    expect(localClock(at("2026-10-25T01:30:00.000Z"), WARSAW)).toBe(
      "25/10/2026, 02:30",
    );
  });

  it("fires once, not twice, across consecutive evaluations with the watermark advancing", () => {
    const graceMs = 60_000;
    let watermark = at("2026-10-24T00:30:00.000Z");

    // First evaluation, standing on the earlier of the two 02:30 instants.
    // croner does not count it, so nothing is due and the watermark holds.
    const atFirstReading = dueOccurrence({
      ...DAILY_0230,
      watermark,
      now: at("2026-10-25T00:30:00.000Z"),
      graceMs,
    });
    expect(atFirstReading).toEqual({ kind: "nothing-due" });

    // Second evaluation, an hour later, standing on the later 02:30. This one
    // fires, and it is the only firing of the day.
    const atSecondReading = dueOccurrence({
      ...DAILY_0230,
      watermark,
      now: at("2026-10-25T01:30:00.000Z"),
      graceMs,
    });
    expect(atSecondReading).toEqual({
      kind: "due",
      occurrence: at("2026-10-25T01:30:00.000Z"),
      advanceWatermarkTo: at("2026-10-25T01:30:00.000Z"),
      droppedOlder: 0,
      droppedOlderAtLeast: false,
      oldestDroppedAt: null,
    });

    // Third evaluation with the watermark advanced, past the repeated hour.
    watermark =
      atSecondReading.kind === "due"
        ? atSecondReading.advanceWatermarkTo
        : new Date(0);
    expect(
      dueOccurrence({
        ...DAILY_0230,
        watermark,
        now: at("2026-10-25T23:59:59.999Z"),
        graceMs: 24 * 60 * 60 * 1000,
      }),
    ).toEqual({ kind: "nothing-due" });

    // And the next day is business as usual.
    expect(
      dueOccurrence({
        ...DAILY_0230,
        watermark,
        now: at("2026-10-26T01:30:00.000Z"),
        graceMs,
      }),
    ).toMatchObject({
      kind: "due",
      occurrence: at("2026-10-26T01:30:00.000Z"),
    });
  });

  it("previews the repeated hour as a single occurrence", () => {
    const preview = nextRuns({
      ...DAILY_0230,
      from: at("2026-10-24T00:30:00.000Z"),
      count: 3,
    });
    expect(preview.ok && preview.runs.map((run) => run.toISOString())).toEqual([
      "2026-10-25T01:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
    ]);
  });

  it("finds the newest occurrence correctly on an hourly schedule through the repeated hour", () => {
    // The backwards search bisects the probe instant, and croner's nextRun is
    // not perfectly monotone around an ambiguous local time. This walks the
    // whole transition to prove the search still lands on the right occurrence.
    const hourly = { cron: "0 * * * *", timezone: WARSAW } as const;
    const expected: ReadonlyArray<[string, string]> = [
      ["2026-10-24T23:30:00.000Z", "2026-10-24T23:00:00.000Z"],
      ["2026-10-25T00:30:00.000Z", "2026-10-24T23:00:00.000Z"],
      ["2026-10-25T01:30:00.000Z", "2026-10-25T01:00:00.000Z"],
      ["2026-10-25T02:30:00.000Z", "2026-10-25T02:00:00.000Z"],
      ["2026-10-25T03:30:00.000Z", "2026-10-25T03:00:00.000Z"],
    ];

    for (const [now, occurrence] of expected) {
      expect(
        dueOccurrence({
          ...hourly,
          watermark: at("2026-10-24T20:00:00.000Z"),
          now: at(now),
          // Wide enough that every step below is judged on which occurrence the
          // search found, not on how late it was.
          graceMs: 3 * 60 * 60 * 1000,
        }),
      ).toMatchObject({ kind: "due", occurrence: at(occurrence) });
    }
  });
});

/**
 * The two ways croner's `nextRun` misleads a caller near a daylight-saving
 * transition, each pinned with the watermark that actually failed.
 *
 * Both were found by review, not by these tests, which is the reason they are
 * written as narrowly as they are: the fix is structural and cheap to "simplify"
 * later by someone who cannot see what it was for.
 */
describe("dueOccurrence never moves the watermark backwards (R1)", () => {
  const SANTIAGO = "America/Santiago";

  it("refuses an occurrence before the watermark on the Santiago fall-back hour", () => {
    // The measured repro. croner answers nextRun(2026-04-05T03:00:00.000Z) with
    // 2026-04-05T02:45:00.000Z for this expression, 15 minutes BEFORE its own
    // argument, because 03:00Z is inside a local hour Santiago repeats and the
    // round trip through local fields comes back with the wrong offset.
    //
    // Taken at face value that is not a late run, it is a second run: the
    // watermark moves backwards and the occurrence it lands on fires again.
    const watermark = at("2026-04-05T03:00:00.000Z");
    const result = dueOccurrence({
      cron: "*/15 * * * *",
      timezone: SANTIAGO,
      watermark,
      now: at("2026-04-05T03:30:00.000Z"),
      graceMs: 3 * 60 * 60 * 1000,
    });

    // There genuinely is no occurrence in this window, so the honest answer is
    // that nothing is due. What must never happen is an occurrence at or before
    // the watermark coming back as fireable.
    expect(result).toEqual({ kind: "nothing-due" });
  });

  it("never returns an occurrence at or before the watermark, anywhere in the transition", () => {
    for (const cron of ["*/15 * * * *", "*/5 * * * *", "0 * * * *"]) {
      for (
        let watermarkMs = at("2026-04-05T02:00:00.000Z").getTime();
        watermarkMs <= at("2026-04-05T04:30:00.000Z").getTime();
        watermarkMs += 5 * 60 * 1000
      ) {
        const watermark = new Date(watermarkMs);
        const result = dueOccurrence({
          cron,
          timezone: SANTIAGO,
          watermark,
          now: new Date(watermarkMs + 30 * 60 * 1000),
          graceMs: 3 * 60 * 60 * 1000,
        });
        if (result.kind === "nothing-due" || result.kind === "invalid") continue;
        const label = `${cron} wm=${watermark.toISOString()}`;
        expect(result.occurrence.getTime(), label).toBeGreaterThan(watermarkMs);
        expect(
          result.advanceWatermarkTo.getTime(),
          label,
        ).toBeGreaterThan(watermarkMs);
      }
    }
  });

  it("finds the true newest occurrence, not a stale one, when the probe lands in the repeated hour", () => {
    // Pins the repair itself rather than its depth. Without it the bisection is
    // steered by croner's backwards answers and settles 20 minutes early: it
    // returns 02:55Z here only because every probe is repaired into a genuine
    // "first occurrence after". Unrepaired it returns 02:35Z and reports 13
    // dropped instead of 17, so the run fires against a stale instant and the
    // operator is told a smaller backlog than there was.
    expect(
      dueOccurrence({
        cron: "*/5 * * * *",
        timezone: SANTIAGO,
        watermark: at("2026-04-05T01:25:00.000Z"),
        now: at("2026-04-05T03:35:00.000Z"),
        graceMs: 3 * 60 * 60 * 1000,
      }),
    ).toEqual({
      kind: "due",
      occurrence: at("2026-04-05T02:55:00.000Z"),
      advanceWatermarkTo: at("2026-04-05T02:55:00.000Z"),
      droppedOlder: 17,
      droppedOlderAtLeast: false,
      oldestDroppedAt: at("2026-04-05T01:30:00.000Z"),
    });
  });

  it("climbs out of a deep backwards answer on a once-a-minute schedule", () => {
    // Pins the repair depth. croner answers this watermark with an instant about
    // an hour behind it, so the walk has to step forward roughly sixty times
    // before it is genuinely past the argument. Measured worst case is 59 steps.
    //
    // A once-a-minute expression is below the deploy-time floor, and that is the
    // point: the floor is checked against a forward sample at deploy time only, so
    // a stored definition can and does arrive here sub-floor, and the evaluator
    // must still answer correctly. At a repair limit of 4 this returns
    // 2026-04-05T04:00:00.000Z, one occurrence short.
    expect(
      dueOccurrence({
        cron: "* * * * *",
        timezone: SANTIAGO,
        watermark: at("2026-04-05T01:55:00.000Z"),
        now: at("2026-04-05T04:05:00.000Z"),
        graceMs: 3 * 60 * 60 * 1000,
      }),
    ).toMatchObject({
      kind: "due",
      occurrence: at("2026-04-05T04:05:00.000Z"),
    });

    // And the case that returns nothing at all when the repair gives up early.
    expect(
      dueOccurrence({
        cron: "* * * * *",
        timezone: SANTIAGO,
        watermark: at("2026-04-05T05:00:00.000Z"),
        now: at("2026-04-05T05:05:00.000Z"),
        graceMs: 3 * 60 * 60 * 1000,
      }),
    ).toMatchObject({
      kind: "due",
      occurrence: at("2026-04-05T05:05:00.000Z"),
    });
  });

  it("fires no occurrence instant twice when evaluations are chained across the transition", () => {
    // 16 of 121 measured seeds fired one occurrence literally twice before the
    // fix. Two expensive agent runs for one schedule tick is the worst outcome
    // this module has, so the chain is walked rather than argued about.
    for (const cron of ["*/15 * * * *", "*/5 * * * *"]) {
      for (
        let seedMs = at("2026-04-05T02:00:00.000Z").getTime();
        seedMs <= at("2026-04-05T04:00:00.000Z").getTime();
        seedMs += 15 * 60 * 1000
      ) {
        let watermark = new Date(seedMs);
        const fired: number[] = [];
        for (
          let nowMs = seedMs + 5 * 60 * 1000;
          nowMs <= seedMs + 3 * 60 * 60 * 1000;
          nowMs += 5 * 60 * 1000
        ) {
          const result = dueOccurrence({
            cron,
            timezone: SANTIAGO,
            watermark,
            now: new Date(nowMs),
            graceMs: 3 * 60 * 60 * 1000,
          });
          if (result.kind === "nothing-due" || result.kind === "invalid") continue;
          const label = `${cron} seed=${new Date(seedMs).toISOString()}`;
          // The watermark is monotonic, which is what makes "at most once" hold.
          expect(
            result.advanceWatermarkTo.getTime(),
            label,
          ).toBeGreaterThan(watermark.getTime());
          if (result.kind === "due") fired.push(result.occurrence.getTime());
          watermark = result.advanceWatermarkTo;
        }
        expect(
          fired.length,
          `${cron} seed=${new Date(seedMs).toISOString()} fired ${JSON.stringify(fired.map((ms) => new Date(ms).toISOString()))}`,
        ).toBe(new Set(fired).size);
      }
    }
  }, 30_000);
});

describe("dueOccurrence loses no occurrence to a watermark inside a repeated hour (R2)", () => {
  /**
   * A watermark parked in a local hour the zone repeats made croner step over the
   * real occurrence completely, so the gate concluded nothing was due, the
   * watermark never moved, and every later tick reached the same conclusion. Not
   * a delayed run, a permanently lost one, with no error anywhere.
   *
   * Each row is the window of watermarks that failed, swept end to end. The
   * spring row matters most: the earlier framing of this module claimed only the
   * autumn transition was exposed, and that was wrong.
   */
  const rows: ReadonlyArray<{
    zone: string;
    cron: string;
    transition: string;
    windowFrom: string;
    windowTo: string;
    now: string;
    occurrence: string;
  }> = [
    {
      zone: WARSAW,
      cron: "0 * * * *",
      transition: "autumn",
      windowFrom: "2026-10-25T00:00:00.000Z",
      windowTo: "2026-10-25T00:59:00.000Z",
      now: "2026-10-25T01:05:00.000Z",
      occurrence: "2026-10-25T01:00:00.000Z",
    },
    {
      zone: WARSAW,
      cron: "*/15 * * * *",
      transition: "autumn",
      windowFrom: "2026-10-25T00:00:00.000Z",
      windowTo: "2026-10-25T00:59:00.000Z",
      now: "2026-10-25T01:05:00.000Z",
      occurrence: "2026-10-25T01:00:00.000Z",
    },
    {
      zone: WARSAW,
      cron: "30 2 * * *",
      transition: "autumn",
      windowFrom: "2026-10-25T00:30:00.000Z",
      windowTo: "2026-10-25T00:59:00.000Z",
      now: "2026-10-25T01:35:00.000Z",
      occurrence: "2026-10-25T01:30:00.000Z",
    },
    {
      zone: WARSAW,
      cron: "30 2 * * *",
      transition: "spring",
      windowFrom: "2026-03-29T01:00:00.000Z",
      windowTo: "2026-03-29T01:29:00.000Z",
      now: "2026-03-29T01:35:00.000Z",
      occurrence: "2026-03-29T01:30:00.000Z",
    },
    {
      zone: "Australia/Sydney",
      cron: "0 * * * *",
      transition: "autumn",
      windowFrom: "2026-04-04T15:00:00.000Z",
      windowTo: "2026-04-04T15:59:00.000Z",
      now: "2026-04-04T16:05:00.000Z",
      occurrence: "2026-04-04T16:00:00.000Z",
    },
    {
      zone: "Australia/Lord_Howe",
      cron: "*/15 * * * *",
      transition: "autumn",
      windowFrom: "2026-04-04T14:30:00.000Z",
      windowTo: "2026-04-04T14:59:00.000Z",
      now: "2026-04-04T15:35:00.000Z",
      occurrence: "2026-04-04T15:30:00.000Z",
    },
  ];

  it.each(rows)(
    "finds $occurrence for $cron in $zone with the watermark anywhere in the $transition window",
    ({ zone, cron, windowFrom, windowTo, now, occurrence }) => {
      const from = at(windowFrom).getTime();
      const to = at(windowTo).getTime();
      // Every minute of the window, not just its edges: the failing range was
      // continuous and a sampled sweep would have missed which part broke.
      for (let watermarkMs = from; watermarkMs <= to; watermarkMs += 60 * 1000) {
        const result = dueOccurrence({
          cron,
          timezone: zone,
          watermark: new Date(watermarkMs),
          now: at(now),
          graceMs: 60 * 60 * 1000,
        });
        expect(
          result,
          `${cron} @ ${zone} watermark=${new Date(watermarkMs).toISOString()}`,
        ).toMatchObject({ kind: "due", occurrence: at(occurrence) });
      }
    },
  );

  it("still reports nothing due when the window really is empty", () => {
    // The backed-off search must not invent an occurrence out of the two hours it
    // reaches back into. This watermark is past the day's only occurrence.
    expect(
      dueOccurrence({
        cron: "30 2 * * *",
        timezone: WARSAW,
        watermark: at("2026-10-25T01:30:00.000Z"),
        now: at("2026-10-25T03:00:00.000Z"),
        graceMs: 60 * 60 * 1000,
      }),
    ).toEqual({ kind: "nothing-due" });
  });
});

describe("suggestedGraceMinutes", () => {
  const NOW = at("2026-08-05T12:00:00.000Z");

  it("suggests half the period, bounded at both ends", () => {
    // A flat default is wrong at both extremes, which is the whole reason this
    // exists: 60 minutes is unreachable for a 15-minute schedule, where the
    // candidate is by construction less than a period old, and it throws away a
    // week on a weekly one.
    expect(suggestedGraceMinutes("*/15 * * * *", "UTC", NOW)).toBe(
      MIN_SUGGESTED_GRACE_MINUTES,
    );
    expect(suggestedGraceMinutes("*/30 * * * *", "UTC", NOW)).toBe(15);
    expect(suggestedGraceMinutes("0 * * * *", "UTC", NOW)).toBe(30);
    expect(suggestedGraceMinutes("0 */4 * * *", "UTC", NOW)).toBe(120);
  });

  it("clamps a daily schedule to the ceiling and a weekly one to the same", () => {
    expect(suggestedGraceMinutes("0 9 * * *", WARSAW, NOW)).toBe(
      MAX_SUGGESTED_GRACE_MINUTES,
    );
    expect(suggestedGraceMinutes("0 9 * * 1", WARSAW, NOW)).toBe(
      MAX_SUGGESTED_GRACE_MINUTES,
    );
    expect(MAX_SUGGESTED_GRACE_MINUTES).toBe(12 * 60);
  });

  it("returns null rather than a guess for a schedule it cannot evaluate", () => {
    expect(suggestedGraceMinutes("not a cron", "UTC", NOW)).toBeNull();
    expect(suggestedGraceMinutes("0 9 * * *", "+05:30", NOW)).toBeNull();
    expect(suggestedGraceMinutes("0 0 30 2 *", "UTC", NOW)).toBeNull();
  });
});
