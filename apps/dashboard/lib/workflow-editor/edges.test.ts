import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canOmitFromPort,
  defaultPort,
  edgeKey,
  isBackEdge,
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
  assert.equal(edgeKey({ from: "a", to: "b" }), "a||b");
  assert.equal(edgeKey({ from: "a", to: "b", fromPort: "failed" }), "a|failed|b");
});

test("visibleOutPorts appends failed only when allowed and used or revealed", () => {
  assert.deepEqual(visibleOutPorts("open_pr", false, false), ["out"]);
  assert.deepEqual(visibleOutPorts("open_pr", true, false), ["out", "failed"]);
  assert.deepEqual(visibleOutPorts("open_pr", false, true), ["out", "failed"]);
  assert.deepEqual(visibleOutPorts("branch", true, true), ["true", "false"]);
  assert.deepEqual(visibleOutPorts("terminate", false, true), []);
});

test("upsertEdge omits fromPort for the default port", () => {
  const out = upsertEdge([], "a", "out", "b", "open_pr");
  assert.deepEqual(out, [{ from: "a", to: "b" }]);
});

test("upsertEdge keeps fromPort for a non-default port", () => {
  const out = upsertEdge([], "a", "false", "b", "branch");
  assert.deepEqual(out, [{ from: "a", to: "b", fromPort: "false" }]);
});

test("upsertEdge replaces the existing edge from the same port", () => {
  const edges: FlowEdgeDef[] = [{ from: "a", to: "b" }];
  const out = upsertEdge(edges, "a", "out", "c", "open_pr");
  assert.deepEqual(out, [{ from: "a", to: "c" }]);
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
