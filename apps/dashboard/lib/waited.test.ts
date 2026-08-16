import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWaited } from "./waited";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

test("under a minute reads as such, never negative", () => {
  assert.equal(formatWaited("2026-08-16T11:59:30.000Z", NOW), "under a minute");
  // A queued_at fractionally in the future (clock skew) must not go negative.
  assert.equal(formatWaited("2026-08-16T12:00:05.000Z", NOW), "under a minute");
});

test("minutes below an hour", () => {
  assert.equal(formatWaited("2026-08-16T11:55:00.000Z", NOW), "5m");
  assert.equal(formatWaited("2026-08-16T11:01:00.000Z", NOW), "59m");
});

test("hours, with and without trailing minutes", () => {
  assert.equal(formatWaited("2026-08-16T10:00:00.000Z", NOW), "2h");
  assert.equal(formatWaited("2026-08-16T09:38:00.000Z", NOW), "2h 22m");
});
