import assert from "node:assert/strict";
import test from "node:test";

import { formatCurrencyTick, niceScale } from "./chart-scale";

test("niceScale labels real gridline values and contains the largest point", () => {
  const scale = niceScale([0, 1.7, 3.39]);
  assert.deepEqual(scale.ticks, [0, 2, 4]);
  assert.ok(scale.max >= 3.39);
  assert.deepEqual(
    scale.ticks.map((tick) => formatCurrencyTick(tick, scale.step)),
    ["$0", "$2", "$4"],
  );
});

test("niceScale retains useful fractional ticks for sub-dollar data", () => {
  const scale = niceScale([0.19, 0.8]);
  assert.deepEqual(scale.ticks, [0, 0.5, 1]);
  assert.deepEqual(
    scale.ticks.map((tick) => formatCurrencyTick(tick, scale.step)),
    ["$0.0", "$0.5", "$1.0"],
  );
});

test("niceScale keeps distinct ticks for an all-zero series", () => {
  const scale = niceScale([0, 0]);
  assert.deepEqual(scale.ticks, [0, 1, 2]);
});
