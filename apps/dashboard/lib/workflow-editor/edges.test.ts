import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canOmitFromPort,
  defaultPort,
  edgeDeleteActionVisible,
  edgeDeleteTargetRadius,
  edgeInstanceKey,
  edgeKeyboardAction,
  edgeKey,
  isBackEdge,
  reconcileSelectedEdgeKey,
  removeEdge,
  resolvedPort,
  upsertEdge,
  visibleOutPorts,
} from "./edges.ts";
import type { FlowEdgeDef } from "../flows.ts";

test("defaultPort returns the first spec port per type", () => {
  assert.equal(defaultPort("open_pr"), "out");
  assert.equal(defaultPort("branch"), "true");
  assert.equal(defaultPort("loop"), "continue");
});

test("resolvedPort falls back to the type default when fromPort absent", () => {
  assert.equal(resolvedPort({ from: "a", to: "b" }, "open_pr"), "out");
  assert.equal(resolvedPort({ from: "a", to: "b" }, "branch"), "true");
  assert.equal(resolvedPort({ from: "a", to: "b", fromPort: "false" }, "branch"), "false");
});

test("edgeKey encodes from, port and to", () => {
  assert.equal(edgeKey({ from: "a", to: "b" }), '["a",null,"b"]');
  assert.equal(edgeKey({ from: "a", to: "b", fromPort: "failed" }), '["a","failed","b"]');
});

test("edgeKey cannot collide when edge fields contain separators", () => {
  assert.notEqual(
    edgeKey({ from: "a|out", to: "b" }),
    edgeKey({ from: "a", fromPort: "out", to: "|b" }),
  );
});

test("edgeInstanceKey distinguishes exact duplicate connections", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b" },
    { from: "a", to: "b" },
  ];
  assert.notEqual(edgeInstanceKey(edges, 0), edgeInstanceKey(edges, 1));
});

test("edgeInstanceKey uses a stable v2 edge id across reordering", () => {
  const original: FlowEdgeDef[] = [
    { id: "edge-a-b", from: "a", to: "b" },
    { id: "edge-b-c", from: "b", to: "c" },
  ];
  const reordered = [original[1], original[0]];

  assert.equal(edgeInstanceKey(original, 0), "edge-a-b");
  assert.equal(edgeInstanceKey(reordered, 1), "edge-a-b");
});

test("connection deletion removes only the exact edge", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b", fromPort: "true" },
    { from: "a", to: "b", fromPort: "false" },
    { from: "b", to: "c" },
  ];
  assert.deepEqual(removeEdge(edges, edgeInstanceKey(edges, 1)), [
    { from: "a", to: "b", fromPort: "true" },
    { from: "b", to: "c" },
  ]);
});

test("connection deletion targets a v2 edge by stable id", () => {
  const edges: FlowEdgeDef[] = [
    { id: "edge-true", from: "a", to: "b", fromPort: "true" },
    { id: "edge-false", from: "a", to: "b", fromPort: "false" },
  ];
  assert.deepEqual(removeEdge(edges, "edge-false"), [
    { id: "edge-true", from: "a", to: "b", fromPort: "true" },
  ]);
});

test("connection deletion removes only one exact duplicate", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b" },
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ];
  assert.deepEqual(removeEdge(edges, edgeInstanceKey(edges, 1)), [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
});

test("a selected connection reveals its delete action without mouse hover", () => {
  assert.equal(edgeDeleteActionVisible({ canEdit: true, hovered: false, selected: true }), true);
  assert.equal(edgeDeleteActionVisible({ canEdit: true, hovered: false, selected: false }), false);
  assert.equal(edgeDeleteActionVisible({ canEdit: false, hovered: true, selected: true }), false);
});

test("connection keyboard actions support selection and deletion", () => {
  assert.equal(edgeKeyboardAction("Enter", true), "select");
  assert.equal(edgeKeyboardAction(" ", true), "select");
  assert.equal(edgeKeyboardAction("Delete", true), "delete");
  assert.equal(edgeKeyboardAction("Backspace", true), "delete");
  assert.equal(edgeKeyboardAction("Delete", false), null);
  assert.equal(edgeKeyboardAction("ArrowRight", true), null);
});

test("edge selection clears when a node is selected or the edge disappears", () => {
  const edges: FlowEdgeDef[] = [{ from: "a", to: "b" }];
  const selectedEdgeKey = edgeInstanceKey(edges, 0);

  assert.equal(reconcileSelectedEdgeKey(selectedEdgeKey, edges, null), selectedEdgeKey);
  assert.equal(reconcileSelectedEdgeKey(selectedEdgeKey, edges, "a"), null);
  assert.equal(reconcileSelectedEdgeKey(selectedEdgeKey, [], null), null);
});

test("delete target stays 44 screen pixels across canvas zoom levels", () => {
  assert.equal(edgeDeleteTargetRadius(1) * 2 * 1, 44);
  assert.equal(edgeDeleteTargetRadius(0.85) * 2 * 0.85, 44);
  assert.equal(edgeDeleteTargetRadius(0.45) * 2 * 0.45, 44);
});

test("visibleOutPorts appends failed only when allowed and used or revealed", () => {
  assert.deepEqual(visibleOutPorts("open_pr", false, false), ["out"]);
  assert.deepEqual(visibleOutPorts("open_pr", true, false), ["out", "failed"]);
  assert.deepEqual(visibleOutPorts("open_pr", false, true), ["out", "failed"]);
  assert.deepEqual(visibleOutPorts("branch", true, true), ["true", "false"]);
  assert.deepEqual(visibleOutPorts("terminate", false, true), []);
});

test("visibleOutPorts never exposes execution-failure ports for v2", () => {
  assert.deepEqual(visibleOutPorts("open_pr", true, true, 2), ["out"]);
});

test("upsertEdge omits fromPort for the default port", () => {
  const out = upsertEdge([], "a", "out", "b", "open_pr");
  assert.deepEqual(out, [{ from: "a", to: "b" }]);
});

test("upsertEdge keeps fromPort for a non-default port", () => {
  const out = upsertEdge([], "a", "false", "b", "branch");
  assert.deepEqual(out, [{ from: "a", to: "b", fromPort: "false" }]);
});

test("upsertEdge v2 appends distinct targets from the same port with stable ids", () => {
  let nextId = 0;
  const generateEdgeId = () => `edge-${++nextId}`;
  const first = upsertEdge([], "a", "out", "b", "open_pr", {
    schemaVersion: 2,
    generateEdgeId,
  });
  const second = upsertEdge(first, "a", "out", "c", "open_pr", {
    schemaVersion: 2,
    generateEdgeId,
  });

  assert.deepEqual(second, [
    { id: "edge-1", from: "a", to: "b" },
    { id: "edge-2", from: "a", to: "c" },
  ]);
});

test("upsertEdge v2 accepts a caller-generated stable id", () => {
  assert.deepEqual(
    upsertEdge([], "a", "false", "b", "branch", {
      schemaVersion: 2,
      edgeId: "edge-branch-false",
    }),
    [
      {
        id: "edge-branch-false",
        from: "a",
        to: "b",
        fromPort: "false",
      },
    ],
  );
});

test("upsertEdge v2 dedupes an exact connection without allocating a new id", () => {
  const edges: FlowEdgeDef[] = [
    { id: "edge-kept", from: "a", to: "b" },
    { id: "edge-duplicate", from: "a", to: "b", fromPort: "out" },
    { id: "edge-other", from: "a", to: "c" },
  ];
  let generatorCalls = 0;
  const out = upsertEdge(edges, "a", "out", "b", "open_pr", {
    schemaVersion: 2,
    generateEdgeId: () => {
      generatorCalls += 1;
      return "unused";
    },
  });

  assert.deepEqual(out, [
    { id: "edge-kept", from: "a", to: "b" },
    { id: "edge-other", from: "a", to: "c" },
  ]);
  assert.equal(generatorCalls, 0);
});

test("upsertEdge v2 retries generated id collisions", () => {
  const edges: FlowEdgeDef[] = [{ id: "edge-used", from: "a", to: "b" }];
  const candidates = ["edge-used", "", "edge-fresh"];
  const out = upsertEdge(edges, "a", "out", "c", "open_pr", {
    schemaVersion: 2,
    generateEdgeId: () => candidates.shift() as string,
  });

  assert.deepEqual(out, [
    { id: "edge-used", from: "a", to: "b" },
    { id: "edge-fresh", from: "a", to: "c" },
  ]);
});

test("upsertEdge v2 rejects a missing or reused stable id", () => {
  const edges: FlowEdgeDef[] = [{ id: "edge-used", from: "a", to: "b" }];

  assert.throws(
    () =>
      upsertEdge(
        edges,
        "a",
        "out",
        "c",
        "open_pr",
        { schemaVersion: 2 } as never,
      ),
    /requires an edge id or id generator/,
  );
  assert.throws(
    () =>
      upsertEdge(edges, "a", "out", "c", "open_pr", {
        schemaVersion: 2,
        edgeId: "edge-used",
      }),
    /already in use/,
  );
});

test("upsertEdge replaces the existing edge from the same port", () => {
  const edges: FlowEdgeDef[] = [{ from: "a", to: "b" }];
  const out = upsertEdge(edges, "a", "out", "c", "open_pr");
  assert.deepEqual(out, [{ from: "a", to: "c" }]);
});

test("upsertEdge keeps the array position when replacing an existing edge", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b" },
    { from: "c", to: "d" },
    { from: "e", to: "f" },
  ];
  assert.deepEqual(upsertEdge(edges, "a", "out", "z", "open_pr"), [
    { from: "a", to: "z" },
    { from: "c", to: "d" },
    { from: "e", to: "f" },
  ]);
});

test("upsertEdge re-upserting the same connection is byte-identical", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b", fromPort: "false" },
    { from: "a", to: "c", fromPort: "true" },
    { from: "c", to: "d" },
  ];
  assert.deepEqual(upsertEdge(edges, "a", "false", "b", "branch"), edges);
  assert.equal(JSON.stringify(upsertEdge(edges, "a", "false", "b", "branch")), JSON.stringify(edges));
});

test("upsertEdge drops stray duplicates from the same port", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b" },
    { from: "c", to: "d" },
    { from: "a", to: "x" },
  ];
  assert.deepEqual(upsertEdge(edges, "a", "out", "z", "open_pr"), [
    { from: "a", to: "z" },
    { from: "c", to: "d" },
  ]);
});

test("upsertEdge leaves other ports intact when replacing one", () => {
  const edges: FlowEdgeDef[] = [{ from: "a", to: "x", fromPort: "false" }];
  const out = upsertEdge(edges, "a", "true", "y", "branch");
  assert.deepEqual(out, [
    { from: "a", to: "x", fromPort: "false" },
    { from: "a", to: "y", fromPort: "true" },
  ]);
});

test("upsertEdge keeps fromPort for a multi-port default port", () => {
  assert.deepEqual(upsertEdge([], "a", "true", "b", "branch"), [
    { from: "a", to: "b", fromPort: "true" },
  ]);
  assert.deepEqual(upsertEdge([], "a", "continue", "b", "loop"), [
    { from: "a", to: "b", fromPort: "continue" },
  ]);
});

test("canOmitFromPort only for the sole port of a single-port source", () => {
  assert.equal(canOmitFromPort("open_pr", "out"), true);
  assert.equal(canOmitFromPort("open_pr", "failed"), false);
  assert.equal(canOmitFromPort("branch", "true"), false);
  assert.equal(canOmitFromPort("loop", "continue"), false);
});

test("upsertEdge blocks self-loops", () => {
  const edges: FlowEdgeDef[] = [{ from: "a", to: "b" }];
  assert.deepEqual(upsertEdge(edges, "a", "out", "a", "open_pr"), edges);
});

test("isBackEdge is false for a forward edge", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ];
  assert.equal(isBackEdge(edges, { from: "a", to: "b" }), false);
});

test("isBackEdge is true when the target can already reach the source", () => {
  const edges: FlowEdgeDef[] = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ];
  assert.equal(isBackEdge(edges, { from: "c", to: "a" }), true);
});
