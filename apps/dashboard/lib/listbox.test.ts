import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToEvent, listboxReducer, type ListboxState } from "./listbox.ts";

const closed: ListboxState = { open: false, activeIdx: 0 };
const openAt = (activeIdx: number): ListboxState => ({ open: true, activeIdx });

test("toggle from closed opens with active at selected index", () => {
  assert.deepEqual(listboxReducer(closed, { type: "toggle", selectedIdx: 2 }), { open: true, activeIdx: 2 });
});

test("toggle from closed clamps a missing selection to 0", () => {
  assert.deepEqual(listboxReducer(closed, { type: "toggle", selectedIdx: -1 }), { open: true, activeIdx: 0 });
});

test("toggle from open closes", () => {
  assert.deepEqual(listboxReducer(openAt(3), { type: "toggle", selectedIdx: 3 }), { open: false, activeIdx: 3 });
});

test("open sets active to selected index", () => {
  assert.deepEqual(listboxReducer(closed, { type: "open", selectedIdx: 4 }), { open: true, activeIdx: 4 });
});

test("open clamps a missing selection to 0", () => {
  assert.deepEqual(listboxReducer(closed, { type: "open", selectedIdx: -1 }), { open: true, activeIdx: 0 });
});

test("close sets open false and keeps active", () => {
  assert.deepEqual(listboxReducer(openAt(2), { type: "close" }), { open: false, activeIdx: 2 });
});

test("move down advances within range", () => {
  assert.deepEqual(listboxReducer(openAt(1), { type: "move", delta: 1, count: 5 }), { open: true, activeIdx: 2 });
});

test("move up retreats within range", () => {
  assert.deepEqual(listboxReducer(openAt(2), { type: "move", delta: -1, count: 5 }), { open: true, activeIdx: 1 });
});

test("move down clamps at the last row", () => {
  assert.deepEqual(listboxReducer(openAt(4), { type: "move", delta: 1, count: 5 }), { open: true, activeIdx: 4 });
});

test("move up clamps at the first row", () => {
  assert.deepEqual(listboxReducer(openAt(0), { type: "move", delta: -1, count: 5 }), { open: true, activeIdx: 0 });
});

test("move on an empty list keeps active at 0", () => {
  assert.deepEqual(listboxReducer(openAt(0), { type: "move", delta: 1, count: 0 }), { open: true, activeIdx: 0 });
});

test("activate points at a hovered row", () => {
  assert.deepEqual(listboxReducer(openAt(0), { type: "activate", idx: 3 }), { open: true, activeIdx: 3 });
});

test("activate clamps a negative index to 0", () => {
  assert.deepEqual(listboxReducer(openAt(2), { type: "activate", idx: -1 }), { open: true, activeIdx: 0 });
});

test("commit closes and keeps active for the component to read", () => {
  assert.deepEqual(listboxReducer(openAt(2), { type: "commit" }), { open: false, activeIdx: 2 });
});

test("ArrowDown opens when closed", () => {
  assert.deepEqual(keyToEvent("ArrowDown", closed, 5, 1), { type: "open", selectedIdx: 1 });
});

test("ArrowDown moves down when open", () => {
  assert.deepEqual(keyToEvent("ArrowDown", openAt(1), 5, 1), { type: "move", delta: 1, count: 5 });
});

test("ArrowUp opens when closed", () => {
  assert.deepEqual(keyToEvent("ArrowUp", closed, 5, 2), { type: "open", selectedIdx: 2 });
});

test("ArrowUp moves up when open", () => {
  assert.deepEqual(keyToEvent("ArrowUp", openAt(2), 5, 2), { type: "move", delta: -1, count: 5 });
});

test("Enter opens when closed", () => {
  assert.deepEqual(keyToEvent("Enter", closed, 5, 3), { type: "open", selectedIdx: 3 });
});

test("Enter commits when open", () => {
  assert.deepEqual(keyToEvent("Enter", openAt(3), 5, 3), { type: "commit" });
});

test("Space opens when closed", () => {
  assert.deepEqual(keyToEvent(" ", closed, 5, 0), { type: "open", selectedIdx: 0 });
});

test("Space commits when open", () => {
  assert.deepEqual(keyToEvent(" ", openAt(0), 5, 0), { type: "commit" });
});

test("Escape closes when open", () => {
  assert.deepEqual(keyToEvent("Escape", openAt(1), 5, 1), { type: "close" });
});

test("Escape does nothing when closed", () => {
  assert.equal(keyToEvent("Escape", closed, 5, 1), null);
});

test("Tab closes when open", () => {
  assert.deepEqual(keyToEvent("Tab", openAt(1), 5, 1), { type: "close" });
});

test("Tab does nothing when closed", () => {
  assert.equal(keyToEvent("Tab", closed, 5, 1), null);
});

test("unhandled keys return null", () => {
  assert.equal(keyToEvent("a", openAt(0), 5, 0), null);
  assert.equal(keyToEvent("Home", openAt(0), 5, 0), null);
});
