import assert from "node:assert/strict";
import { test } from "node:test";
import { executionLimitsFromDefinition, setExecutionLimit } from "./execution-limits.ts";

test("execution limits can be set, changed, and cleared without defaults", () => {
  const empty = executionLimitsFromDefinition({ schemaVersion: 1, nodes: [], edges: [] });
  assert.deepEqual(empty, {});

  assert.deepEqual(
    executionLimitsFromDefinition({
      schemaVersion: 1,
      budgets: { maxDurationMs: 120_000, maxTokens: 25_000, maxCostUsd: 4.5 },
      nodes: [],
      edges: [],
    }),
    { maxDurationMs: 120_000, maxTokens: 25_000, maxCostUsd: 4.5 },
  );

  const set = setExecutionLimit(empty, "maxTokens", 25_000);
  assert.deepEqual(set, { maxTokens: 25_000 });

  const changed = setExecutionLimit(set, "maxTokens", 30_000);
  assert.deepEqual(changed, { maxTokens: 30_000 });

  const cleared = setExecutionLimit(changed, "maxTokens", undefined);
  assert.deepEqual(cleared, {});
});
