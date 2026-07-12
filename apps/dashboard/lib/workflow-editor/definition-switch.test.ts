import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceDefinitionSwitch, type DefinitionSwitchState } from "./definition-switch.ts";

const idle: DefinitionSwitchState = { kind: "idle" };
const confirming: DefinitionSwitchState = { kind: "confirming", targetId: 7 };

test("clean request switches immediately", () => {
  const t = reduceDefinitionSwitch(idle, { type: "request", targetId: 7, dirty: false });
  assert.deepEqual(t, { state: { kind: "idle" }, switchTo: 7 });
});

test("dirty request enters confirming without switching", () => {
  const t = reduceDefinitionSwitch(idle, { type: "request", targetId: 7, dirty: true });
  assert.deepEqual(t, { state: { kind: "confirming", targetId: 7 }, switchTo: null });
});

test("confirm proceeds with the pending target", () => {
  const t = reduceDefinitionSwitch(confirming, { type: "confirm" });
  assert.deepEqual(t, { state: { kind: "idle" }, switchTo: 7 });
});

test("cancel aborts the pending switch", () => {
  const t = reduceDefinitionSwitch(confirming, { type: "cancel" });
  assert.deepEqual(t, { state: { kind: "idle" }, switchTo: null });
});

test("confirm without a pending switch is a no-op", () => {
  const t = reduceDefinitionSwitch(idle, { type: "confirm" });
  assert.deepEqual(t, { state: { kind: "idle" }, switchTo: null });
});

test("dirty request while confirming replaces the target", () => {
  const t = reduceDefinitionSwitch(confirming, { type: "request", targetId: 9, dirty: true });
  assert.deepEqual(t, { state: { kind: "confirming", targetId: 9 }, switchTo: null });
});
