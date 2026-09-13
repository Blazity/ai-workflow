import assert from "node:assert/strict";
import test from "node:test";

import { formatDateTime, isOlderThanHours } from "./date-time";

test("formatDateTime uses one readable month-first format", () => {
  const formatted = formatDateTime("2026-08-21T13:56:30.000Z");
  assert.match(formatted, /Aug 21, 2026/);
  assert.match(formatted, /\d{1,2}:56:30/);
  assert.equal(formatDateTime("not-a-date"), "not-a-date");
});

test("isOlderThanHours distinguishes a stale scan from a current one", () => {
  const now = Date.parse("2026-08-22T14:00:00.000Z");
  assert.equal(isOlderThanHours("2026-08-21T13:56:30.000Z", 24, now), true);
  assert.equal(isOlderThanHours("2026-08-22T13:56:30.000Z", 24, now), false);
  assert.equal(isOlderThanHours("not-a-date", 24, now), false);
});
