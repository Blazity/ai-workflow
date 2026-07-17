import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterPendingLayoutSave,
  createPendingLayoutSave,
  type LayoutSaveTimer,
} from "./layout-save.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("flushes pending layout before semantic Save Draft continues", async () => {
  let timerCallback: (() => void) | null = null;
  let timerCancelled = false;
  const timer: LayoutSaveTimer = (callback) => {
    timerCallback = callback;
    return () => {
      timerCancelled = true;
      timerCallback = null;
    };
  };
  const pending = deferred<boolean>();
  const events: string[] = [];
  const layoutSave = createPendingLayoutSave({ timer });
  layoutSave.schedule(async () => {
    events.push("layout started");
    const saved = await pending.promise;
    events.push("layout finished");
    return saved;
  });

  const saveDraft = afterPendingLayoutSave(layoutSave, async () => {
    events.push("draft saved");
  });

  assert.equal(timerCancelled, true);
  assert.equal(timerCallback, null);
  assert.deepEqual(events, ["layout started"]);

  pending.resolve(true);
  assert.equal(await saveDraft, true);
  assert.deepEqual(events, ["layout started", "layout finished", "draft saved"]);
});

test("flushes pending layout before switching definitions", async () => {
  const events: string[] = [];
  const layoutSave = createPendingLayoutSave({ timer: () => () => undefined });
  layoutSave.schedule(async () => {
    events.push("layout saved");
    return true;
  });

  const switched = await afterPendingLayoutSave(layoutSave, async () => {
    events.push("definition loaded");
  });

  assert.equal(switched, true);
  assert.deepEqual(events, ["layout saved", "definition loaded"]);
});

test("does not continue when the pending layout cannot be saved", async () => {
  let attempts = 0;
  const layoutSave = createPendingLayoutSave({ timer: () => () => undefined });
  layoutSave.schedule(async () => {
    attempts += 1;
    return false;
  });

  let continued = false;
  assert.equal(
    await afterPendingLayoutSave(layoutSave, async () => {
      continued = true;
    }),
    false,
  );
  assert.equal(continued, false);

  assert.equal(await layoutSave.flush(), false);
  assert.equal(attempts, 2);
});
