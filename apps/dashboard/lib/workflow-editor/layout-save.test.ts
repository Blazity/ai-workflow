import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterInvalidatingLayoutSave,
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
  const pending = deferred<number>();
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

  pending.resolve(1);
  assert.equal(await saveDraft, true);
  assert.deepEqual(events, ["layout started", "layout finished", "draft saved"]);
});

test("sequences queued layout saves with the revision returned by the previous save", async () => {
  const firstSave = deferred<number>();
  const events: string[] = [];
  const layoutSave = createPendingLayoutSave({
    initialLayoutRevision: 3,
    timer: () => () => undefined,
  });

  layoutSave.schedule(async (expectedLayoutRevision) => {
    events.push(`first:${expectedLayoutRevision}`);
    return firstSave.promise;
  });
  const flushing = layoutSave.flush();

  layoutSave.schedule(async (expectedLayoutRevision) => {
    events.push(`second:${expectedLayoutRevision}`);
    return 5;
  });
  const saveDraft = afterPendingLayoutSave(layoutSave, async () => {
    events.push("draft saved");
  });

  firstSave.resolve(4);
  assert.equal(await flushing, true);
  assert.equal(await saveDraft, true);
  assert.deepEqual(events, ["first:3", "second:4", "draft saved"]);
});

test("flushes pending layout before switching definitions", async () => {
  const events: string[] = [];
  const layoutSave = createPendingLayoutSave({ timer: () => () => undefined });
  layoutSave.schedule(async () => {
    events.push("layout saved");
    return 1;
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

test("invalidates an in-flight layout save before a selected-definition deletion switches", async () => {
  const response = deferred<false>();
  const events: string[] = [];
  let attempts = 0;
  const layoutSave = createPendingLayoutSave({ timer: () => () => undefined });
  layoutSave.schedule(async () => {
    attempts += 1;
    events.push("layout started");
    const saved = await response.promise;
    events.push("layout settled");
    return saved;
  });
  const inFlight = layoutSave.flush();

  const switched = afterInvalidatingLayoutSave(layoutSave, async () => {
    events.push("definition loaded");
  });

  assert.deepEqual(events, ["layout started"]);

  response.resolve(false);
  assert.equal(await inFlight, true);
  await switched;

  assert.deepEqual(events, ["layout started", "layout settled", "definition loaded"]);
  assert.equal(await layoutSave.flush(), true);
  assert.equal(attempts, 1);
});
