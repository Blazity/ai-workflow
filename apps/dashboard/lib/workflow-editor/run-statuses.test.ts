import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunStatuses } from "./run-statuses.ts";
import type { RunBlockStatusSnapshot } from "@shared/contracts";

function snapshot(overrides: Partial<RunBlockStatusSnapshot> = {}): RunBlockStatusSnapshot {
  return {
    runId: "run-1",
    ticketKey: "PROJ-1",
    source: "live",
    status: "running",
    definitionId: null,
    definitionVersion: 4,
    blockStatuses: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

test("returns undefined when run is null", () => {
  assert.equal(deriveRunStatuses(null, 4), undefined);
});

test("returns undefined on version mismatch", () => {
  assert.equal(deriveRunStatuses(snapshot({ definitionVersion: 3 }), 4), undefined);
  assert.equal(deriveRunStatuses(snapshot({ definitionVersion: null }), 4), undefined);
  assert.equal(deriveRunStatuses(snapshot({ definitionVersion: 4 }), null), undefined);
});

test("derives when both versions are null", () => {
  const derived = deriveRunStatuses(snapshot({ definitionVersion: null }), null);
  assert.deepEqual(derived, { statuses: {}, errors: {} });
});

test("passes statuses through including running", () => {
  const run = snapshot({
    definitionVersion: 4,
    blockStatuses: {
      n1: { status: "ok" },
      n2: { status: "running" },
      n3: { status: "fail", error: "boom" },
      n4: { status: "warn", error: "why?" },
      n5: { status: "pending" },
    },
  });
  const derived = deriveRunStatuses(run, 4);
  assert.deepEqual(derived?.statuses, {
    n1: "ok",
    n2: "running",
    n3: "fail",
    n4: "warn",
    n5: "pending",
  });
});

test("errors map contains only entries with an error", () => {
  const run = snapshot({
    definitionVersion: 4,
    blockStatuses: {
      n1: { status: "ok" },
      n3: { status: "fail", error: "boom" },
      n4: { status: "warn", error: "why?" },
    },
  });
  const derived = deriveRunStatuses(run, 4);
  assert.deepEqual(derived?.errors, { n3: "boom", n4: "why?" });
});

test("empty blockStatuses yields empty maps", () => {
  const derived = deriveRunStatuses(snapshot({ definitionVersion: 4, blockStatuses: {} }), 4);
  assert.deepEqual(derived, { statuses: {}, errors: {} });
});
