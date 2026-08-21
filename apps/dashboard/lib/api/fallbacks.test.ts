import assert from "node:assert/strict";
import test from "node:test";
import { runDetailFallback } from "./fallbacks";

test("run detail fallback carries a nullable analysis report", () => {
  assert.equal(runDetailFallback("now").analysisReport, null);
});
