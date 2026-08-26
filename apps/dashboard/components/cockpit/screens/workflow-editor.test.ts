import assert from "node:assert/strict";
import test from "node:test";

import type { FlowNodeDef } from "@/lib/flows";
import { nodeSaveIssues, nodesValid } from "./workflow-editor";

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

test("run_scripts with no group blocks Save: a block that runs no group verifies nothing", () => {
  const noGroups: FlowNodeDef = {
    id: "rs",
    type: "run_scripts",
    name: "Scripts",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  };
  const emptyGroups: FlowNodeDef = { ...noGroups, params: { groups: [] } };
  const oneGroup: FlowNodeDef = { ...noGroups, params: { groups: ["checks"] } };

  // The server has always refused these (v2RunScriptsConfiguration requires
  // min(1)); before this the rule only fired at Deploy, as a raw zod path.
  assert.equal(nodesValid([trigger(), noGroups]), false);
  assert.equal(nodesValid([trigger(), emptyGroups]), false);
  assert.equal(nodesValid([trigger(), oneGroup]), true);
});

test("a group name the server would refuse blocks Save on run_scripts and on run_checks", () => {
  const scripts: FlowNodeDef = {
    id: "rs",
    type: "run_scripts",
    name: "Scripts",
    x: 0,
    y: 0,
    params: { groups: ["Bad Name"] },
    inputs: {},
  };
  const checks: FlowNodeDef = {
    id: "rc",
    type: "run_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { groups: ["UPPER"] },
    inputs: {},
  };

  assert.equal(nodesValid([trigger(), scripts]), false);
  assert.equal(nodesValid([trigger(), checks]), false);
  assert.equal(
    nodesValid([trigger(), { ...scripts, params: { groups: ["e2e-smoke"] } }]),
    true,
  );
});

test("every blocking reason names its node so the header can jump to it", () => {
  const scripts: FlowNodeDef = {
    id: "rs",
    type: "run_scripts",
    name: "Scripts",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  };
  const checks: FlowNodeDef = {
    id: "rc",
    type: "run_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { commands: ["pnpm test"], groups: ["checks"] },
    inputs: {},
  };

  const issues = nodeSaveIssues([trigger(), scripts, checks]);
  assert.deepEqual(
    issues.map((issue) => issue.nodeId),
    ["rs", "rc"],
  );
  // A missing trigger is a workflow-level problem with no node to select, so it
  // stays out of the per-node list while still disabling Save.
  assert.deepEqual(nodeSaveIssues([trigger()]), []);
  assert.equal(nodesValid([trigger()]), true);
});

test("a Named run_checks node that picks no group blocks Save instead of quietly meaning the gate", () => {
  const emptyNamed: FlowNodeDef = {
    id: "rc",
    type: "run_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { groups: [] },
    inputs: {},
  };
  // Present-but-empty is the Named mode with nothing picked. Absent is the
  // gate selection, which is a valid block.
  assert.equal(nodesValid([trigger(), emptyNamed]), false);
  assert.deepEqual(nodeSaveIssues([trigger(), emptyNamed]), [
    { nodeId: "rc", message: "Named groups selected but none picked." },
  ]);
  assert.equal(nodesValid([trigger(), { ...emptyNamed, params: {} }]), true);
});
