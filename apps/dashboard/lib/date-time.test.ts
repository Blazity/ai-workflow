import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { formatAgeMinutes, formatDateTime, isOlderThanHours } from "./date-time";

// Red when: the same instant reads differently on a server-rendered page and
// a client component (QA: two hours apart between /integrations and the
// connection page), or when no zone is named.
test("formatDateTime names its zone and does not depend on where it runs", () => {
  const formatted = formatDateTime("2026-08-21T13:56:30.000Z");
  assert.equal(formatted, "Aug 21, 2026, 1:56:30 PM UTC");
});

test("formatDateTime uses one readable month-first format", () => {
  const formatted = formatDateTime("2026-08-21T13:56:30.000Z");
  assert.match(formatted, /Aug 21, 2026/);
  assert.match(formatted, /\d{1,2}:56:30/);
  assert.equal(formatDateTime("not-a-date"), "not-a-date");
});

test("formatAgeMinutes moves from minutes to hours and days", () => {
  assert.equal(formatAgeMinutes(59), "59m ago");
  assert.equal(formatAgeMinutes(60), "1h ago");
  assert.equal(formatAgeMinutes(1383), "23h ago");
  assert.equal(formatAgeMinutes(2880), "2d ago");
  // A run parked four days ago, as QA read it on the runs list: "6998m ago".
  assert.equal(formatAgeMinutes(6998), "4d ago");
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Red when: a screen prints a run's age field (startedAtMin, askedAtMin) with a
// bare "m ago" instead of formatAgeMinutes. Seven places did, so the same run
// read "6998m ago" on the runs list and "4d ago" on the phone Overview.
test("no screen prints a run's age in raw minutes", () => {
  const root = join(import.meta.dirname, "..");
  const offenders = ["components", "app"].flatMap((dir) =>
    sourceFiles(join(root, dir)).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /AtMin\}m ago/.test(line) ? [`${relative(root, file)}:${index + 1}`] : [],
        ),
    ),
  );
  assert.deepEqual(offenders, [], "use formatAgeMinutes from lib/date-time.ts");
});

test("isOlderThanHours distinguishes a stale scan from a current one", () => {
  const now = Date.parse("2026-08-22T14:00:00.000Z");
  assert.equal(isOlderThanHours("2026-08-21T13:56:30.000Z", 24, now), true);
  assert.equal(isOlderThanHours("2026-08-22T13:56:30.000Z", 24, now), false);
  assert.equal(isOlderThanHours("not-a-date", 24, now), false);
});

// Red when: the zone's name is asked of the runtime (`timeZoneName: "short"`),
// which is free to call UTC "GMT" or something else (review of #511).
test("the UTC suffix is written by us, whatever the runtime calls the zone", async () => {
  const RealFormat = Intl.DateTimeFormat;
  // A runtime that names UTC "GMT" when asked for a zone name.
  const Renaming = function (locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
    const real = new RealFormat(locale, options);
    return options?.timeZoneName
      ? Object.assign(Object.create(real), { format: (date: Date) => real.format(date).replace("UTC", "GMT") })
      : real;
  } as unknown as typeof Intl.DateTimeFormat;
  Intl.DateTimeFormat = Renaming;
  try {
    const fresh = (await import(`./date-time.ts?renaming=${Date.now()}`)) as typeof import("./date-time");
    assert.equal(fresh.formatDateTime("2026-08-21T13:56:30.000Z"), "Aug 21, 2026, 1:56:30 PM UTC");
  } finally {
    Intl.DateTimeFormat = RealFormat;
  }
});
