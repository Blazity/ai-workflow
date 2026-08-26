import assert from "node:assert/strict";
import test from "node:test";

import type { FlowNodeDef } from "@/lib/flows";
import { nodesValid } from "./workflow-editor";

function trigger(): FlowNodeDef {
  return { id: "t1", type: "trigger_ticket_ai", name: "Ticket", x: 0, y: 0, params: {}, inputs: {} };
}

test("an out-of-range legacy maxFixCycles no longer disables Save: the repair loop it configured is gone", () => {
  const node: FlowNodeDef = {
    id: "checks",
    type: "run_pre_pr_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { maxFixCycles: 99 },
    inputs: {},
  };
  assert.equal(nodesValid([trigger(), node]), true);
});

test("a negative legacy maxFixCycles also no longer disables Save", () => {
  const node: FlowNodeDef = {
    id: "checks",
    type: "run_pre_pr_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { maxFixCycles: -1 },
    inputs: {},
  };
  assert.equal(nodesValid([trigger(), node]), true);
});

test("nodesValid still requires a trigger and a valid update_ticket_status target", () => {
  const noTrigger: FlowNodeDef = {
    id: "u1",
    type: "update_ticket_status",
    name: "Update",
    x: 0,
    y: 0,
    params: { target: "done" },
    inputs: {},
  };
  assert.equal(nodesValid([noTrigger]), false);

  const badTarget: FlowNodeDef = { ...noTrigger, params: {} };
  assert.equal(nodesValid([trigger(), badTarget]), false);

  const goodTarget: FlowNodeDef = { ...noTrigger, params: { target: "done" } };
  assert.equal(nodesValid([trigger(), goodTarget]), true);
});

test("run_checks with both commands and groups filled blocks Save, mirroring the server's mutual-exclusion rule", () => {
  const node: FlowNodeDef = {
    id: "rc",
    type: "run_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { commands: ["pnpm test"], groups: ["checks"] },
    inputs: {},
  };
  assert.equal(nodesValid([trigger(), node]), false);
});

test("run_checks with only commands or only groups filled stays valid", () => {
  const onlyCommands: FlowNodeDef = {
    id: "rc",
    type: "run_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { commands: ["pnpm test"] },
    inputs: {},
  };
  const onlyGroups: FlowNodeDef = { ...onlyCommands, params: { groups: ["checks"] } };
  const neither: FlowNodeDef = { ...onlyCommands, params: {} };

  assert.equal(nodesValid([trigger(), onlyCommands]), true);
  assert.equal(nodesValid([trigger(), onlyGroups]), true);
  assert.equal(nodesValid([trigger(), neither]), true);
});
