import assert from "node:assert/strict";
import { test } from "node:test";
import {
  automaticEdgeBendPoint,
  canvasGridMetrics,
  edgeBezierPath,
  nudgeEdgeGeometry,
  offsetEdgeGeometry,
  resetWorkflowEdgeBend,
  setWorkflowEdgeBend,
} from "./layout-geometry.ts";

test("automatic routing keeps the existing cubic path", () => {
  assert.equal(
    edgeBezierPath({ x: 0, y: 10 }, { x: 200, y: 90 }),
    "M 0 10 C 90 10, 110 90, 200 90",
  );
  assert.deepEqual(
    automaticEdgeBendPoint({ x: 0, y: 10 }, { x: 200, y: 90 }),
    { x: 100, y: 50 },
  );
});

test("authored routing produces a smooth path through the bend", () => {
  assert.equal(
    edgeBezierPath(
      { x: 0, y: 10 },
      { x: 200, y: 90 },
      { bend: { x: 80, y: 140 } },
    ),
    "M 0 10 C 36 10, 44 140, 80 140 C 134 140, 146 90, 200 90",
  );
});

test("nudge starts at automatic geometry and offset supports pasted edges", () => {
  assert.deepEqual(
    nudgeEdgeGeometry(undefined, { x: 1, y: -2 }, { x: 100, y: 50 }),
    { bend: { x: 101, y: 48 } },
  );
  assert.deepEqual(
    offsetEdgeGeometry(
      { bend: { x: 101, y: 48 } },
      { x: 32, y: 32 },
    ),
    { bend: { x: 133, y: 80 } },
  );
});

test("set and reset are immutable and reset restores automatic routing", () => {
  const original = {
    nodes: { trigger: { x: 0, y: 0 } },
    edges: {},
  };
  const bent = setWorkflowEdgeBend(
    original,
    "edge-stable",
    { x: 100, y: 60 },
  );
  assert.deepEqual(bent.edges, {
    "edge-stable": { bend: { x: 100, y: 60 } },
  });
  assert.deepEqual(original.edges, {});
  assert.deepEqual(resetWorkflowEdgeBend(bent, "edge-stable"), original);
  assert.equal(resetWorkflowEdgeBend(original, "missing"), original);
});

test("grid spacing and origin follow both zoom and pan", () => {
  assert.deepEqual(canvasGridMetrics({ x: 13, y: -7 }, 0.5), {
    size: 10,
    offset: { x: 3, y: 3 },
  });
  assert.deepEqual(canvasGridMetrics({ x: 23, y: 44 }, 2), {
    size: 40,
    offset: { x: 23, y: 4 },
  });
  assert.throws(
    () => canvasGridMetrics({ x: 0, y: 0 }, 0),
    /positive and finite/,
  );
});
