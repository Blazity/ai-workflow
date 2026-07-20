import assert from "node:assert/strict";
import test from "node:test";
import { createEditorResponseGuard } from "./response-guard";

test("an editor response remains current until the user mutates the editor", () => {
  const guard = createEditorResponseGuard();
  const requestRevision = guard.capture();

  assert.equal(guard.isCurrent(requestRevision), true);

  guard.invalidate();

  assert.equal(guard.isCurrent(requestRevision), false);
});

test("each request can capture the latest editor revision independently", () => {
  const guard = createEditorResponseGuard();
  const firstRequest = guard.capture();
  guard.invalidate();
  const secondRequest = guard.capture();

  assert.equal(guard.isCurrent(firstRequest), false);
  assert.equal(guard.isCurrent(secondRequest), true);
});
