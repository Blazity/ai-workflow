import assert from "node:assert/strict";
import test from "node:test";
import {
  dragSelectionNodeIds,
  EMPTY_CANVAS_SELECTION,
  reconcileCanvasSelection,
  selectCanvasEdge,
  selectCanvasNode,
} from "./canvas-selection.ts";

test("ordinary selection replaces the canvas selection", () => {
  const mixed = {
    nodeIds: ["one", "two"],
    edgeKeys: ["edge-a"],
    primaryNodeId: "two",
  };
  assert.deepEqual(selectCanvasNode(mixed, "three", false), {
    nodeIds: ["three"],
    edgeKeys: [],
    primaryNodeId: "three",
  });
  assert.deepEqual(selectCanvasEdge(mixed, "edge-b", false), {
    nodeIds: [],
    edgeKeys: ["edge-b"],
    primaryNodeId: null,
  });
});

test("additive selection toggles nodes and edges without losing the other kind", () => {
  const withNode = selectCanvasNode(EMPTY_CANVAS_SELECTION, "one", true);
  const mixed = selectCanvasEdge(withNode, "edge-a", true);
  assert.deepEqual(mixed, {
    nodeIds: ["one"],
    edgeKeys: ["edge-a"],
    primaryNodeId: "one",
  });
  assert.deepEqual(selectCanvasNode(mixed, "one", true), {
    nodeIds: [],
    edgeKeys: ["edge-a"],
    primaryNodeId: null,
  });
});

test("reconciliation removes deleted items and chooses the latest surviving primary", () => {
  assert.deepEqual(
    reconcileCanvasSelection(
      {
        nodeIds: ["gone", "kept"],
        edgeKeys: ["gone-edge", "kept-edge"],
        primaryNodeId: "gone",
      },
      new Set(["kept"]),
      new Set(["kept-edge"]),
    ),
    {
      nodeIds: ["kept"],
      edgeKeys: ["kept-edge"],
      primaryNodeId: "kept",
    },
  );
});

test("dragging any selected node moves the group; an unselected node moves alone", () => {
  const selection = {
    nodeIds: ["one", "two"],
    edgeKeys: [],
    primaryNodeId: "two",
  };
  assert.deepEqual(dragSelectionNodeIds(selection, "one"), ["one", "two"]);
  assert.deepEqual(dragSelectionNodeIds(selection, "three"), ["three"]);
});
