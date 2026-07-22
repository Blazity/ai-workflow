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
    definitionId: 7,
    definitionVersion: 4,
    blockStatuses: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

const editor = { definitionId: 7, version: 4 };

test("returns undefined when run is null", () => {
  assert.equal(deriveRunStatuses(null, editor), undefined);
});

test("returns undefined on definition mismatch", () => {
  assert.equal(deriveRunStatuses(snapshot({ definitionId: 3 }), editor), undefined);
  assert.equal(deriveRunStatuses(snapshot({ definitionId: null }), editor), undefined);
});

test("returns undefined on version mismatch", () => {
  assert.equal(deriveRunStatuses(snapshot({ definitionVersion: 3 }), editor), undefined);
  assert.equal(deriveRunStatuses(snapshot({ definitionVersion: null }), editor), undefined);
  assert.equal(deriveRunStatuses(snapshot(), { definitionId: 7, version: null }), undefined);
});

test("derives when the definition matches and both versions are null", () => {
  const derived = deriveRunStatuses(snapshot({ definitionVersion: null }), {
    definitionId: 7,
    version: null,
  });
  assert.deepEqual(derived, { statuses: {}, errors: {} });
});

test("passes statuses through including running", () => {
  const run = snapshot({
    blockStatuses: {
      n1: { status: "ok" },
      n2: { status: "running" },
      n3: { status: "fail", error: "boom" },
      n4: { status: "warn", error: "why?" },
      n5: { status: "pending" },
    },
  });
  const derived = deriveRunStatuses(run, editor);
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
    blockStatuses: {
      n1: { status: "ok" },
      n3: { status: "fail", error: "boom" },
      n4: { status: "warn", error: "why?" },
    },
  });
  const derived = deriveRunStatuses(run, editor);
  assert.deepEqual(derived?.errors, { n3: "boom", n4: "why?" });
});

test("execution errors include their diagnostic id without exposing internal detail", () => {
  const run = snapshot({
    blockStatuses: {
      n1: {
        status: "fail",
        error: "An external service could not complete this block.",
        diagnosticId: "AIW-DIAG-run-1-n1-1",
      },
    },
  });

  assert.deepEqual(deriveRunStatuses(run, editor)?.errors, {
    n1:
      "An external service could not complete this block. Diagnostic ID: AIW-DIAG-run-1-n1-1",
  });
});

test("empty blockStatuses yields empty maps", () => {
  const derived = deriveRunStatuses(snapshot({ blockStatuses: {} }), editor);
  assert.deepEqual(derived, { statuses: {}, errors: {} });
});
