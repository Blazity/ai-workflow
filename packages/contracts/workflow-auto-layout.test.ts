import assert from "node:assert/strict";
import test from "node:test";

import { autoLayoutPositions, positionsCarryNoLayout } from "./workflow-auto-layout";

const STEP = { x: 240, y: 120 };

/** The shape a definition written through the API arrives in. */
function unplaced(...ids: string[]) {
  return ids.map((id) => ({ id, x: 0, y: 0 }));
}

test("a graph nobody placed is recognised, whatever the shared point is", () => {
  assert.equal(positionsCarryNoLayout(unplaced("a", "b", "c")), true);
  assert.equal(
    positionsCarryNoLayout([
      { id: "a", x: 40, y: 40 },
      { id: "b", x: 40, y: 40 },
    ]),
    true,
  );
});

test("a graph somebody placed is left alone, even when one node sits at the origin", () => {
  assert.equal(
    positionsCarryNoLayout([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 240, y: 0 },
    ]),
    false,
  );
  // One node cannot be a pile, so there is nothing to rescue.
  assert.equal(positionsCarryNoLayout(unplaced("only")), false);
});

test("a chain is drawn left to right, one column per step", () => {
  const positions = autoLayoutPositions(
    unplaced("trigger", "prepare", "planning", "status"),
    [
      { from: "trigger", to: "prepare" },
      { from: "prepare", to: "planning" },
      { from: "planning", to: "status" },
    ],
    STEP,
  );
  assert.deepEqual(positions.get("trigger"), { x: 0, y: 0 });
  assert.deepEqual(positions.get("prepare"), { x: 240, y: 0 });
  assert.deepEqual(positions.get("planning"), { x: 480, y: 0 });
  assert.deepEqual(positions.get("status"), { x: 720, y: 0 });
});

test("no two nodes share a point, which is the whole reason this exists", () => {
  const positions = autoLayoutPositions(
    unplaced("trigger", "a", "b", "join"),
    [
      { from: "trigger", to: "a" },
      { from: "trigger", to: "b" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
    ],
    STEP,
  );
  const seen = new Set([...positions.values()].map((point) => `${point.x},${point.y}`));
  assert.equal(seen.size, 4, "two blocks landed on the same point and one would swallow the other's clicks");
});

test("a branch stacks inside its column and rejoins to the right of both arms", () => {
  const positions = autoLayoutPositions(
    unplaced("trigger", "a", "b", "join"),
    [
      { from: "trigger", to: "a" },
      { from: "trigger", to: "b" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
    ],
    STEP,
  );
  assert.deepEqual(positions.get("a"), { x: 240, y: 0 });
  assert.deepEqual(positions.get("b"), { x: 240, y: 120 });
  assert.deepEqual(positions.get("join"), { x: 480, y: 0 });
});

test("a node fed by an early and a late block is drawn after the late one", () => {
  // Shortest path would put "last" in column 1, with the edge from "slow"
  // pointing backwards across the canvas.
  const positions = autoLayoutPositions(
    unplaced("trigger", "slow", "last"),
    [
      { from: "trigger", to: "slow" },
      { from: "trigger", to: "last" },
      { from: "slow", to: "last" },
    ],
    STEP,
  );
  assert.equal(positions.get("slow")!.x, 240);
  assert.equal(positions.get("last")!.x, 480);
});

test("a loop is still drawn, to the right of everything that could be layered", () => {
  const positions = autoLayoutPositions(
    unplaced("trigger", "work", "check"),
    [
      { from: "trigger", to: "work" },
      { from: "work", to: "check" },
      { from: "check", to: "work" },
    ],
    STEP,
  );
  const seen = new Set([...positions.values()].map((point) => `${point.x},${point.y}`));
  assert.equal(seen.size, 3, "a cycle left blocks stacked on one another");
  assert.deepEqual(positions.get("trigger"), { x: 0, y: 0 });
});

test("an edge naming a node the graph does not hold cannot move anything", () => {
  const positions = autoLayoutPositions(
    unplaced("trigger", "prepare"),
    [
      { from: "trigger", to: "prepare" },
      { from: "prepare", to: "deleted" },
      { from: "ghost", to: "prepare" },
    ],
    STEP,
  );
  assert.deepEqual(positions.get("trigger"), { x: 0, y: 0 });
  assert.deepEqual(positions.get("prepare"), { x: 240, y: 0 });
});
