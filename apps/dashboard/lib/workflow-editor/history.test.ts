import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEditorHistory,
  editorHistoryCanRedo,
  editorHistoryCanUndo,
  editorHistoryIsDirty,
  finishEditingSurfaceTransaction,
  reduceEditorHistory,
} from "./history.ts";

interface Snapshot {
  semantic: string;
  x: number;
}

const initial: Snapshot = { semantic: "initial", x: 0 };

test("records ordinary edits and walks undo and redo in order", () => {
  let state = createEditorHistory(initial, { savedSemanticKey: "initial" });
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "one", x: 0 },
  });
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "two", x: 0 },
  });

  assert.equal(editorHistoryCanUndo(state), true);
  state = reduceEditorHistory(state, { type: "undo" });
  assert.equal(state.present.semantic, "one");
  state = reduceEditorHistory(state, { type: "undo" });
  assert.deepEqual(state.present, initial);
  assert.equal(editorHistoryCanUndo(state), false);
  assert.equal(editorHistoryCanRedo(state), true);

  state = reduceEditorHistory(state, { type: "redo" });
  assert.equal(state.present.semantic, "one");
  state = reduceEditorHistory(state, { type: "redo" });
  assert.equal(state.present.semantic, "two");
  assert.equal(editorHistoryCanRedo(state), false);
});

test("coalesces a completed drag into one entry", () => {
  let state = createEditorHistory(initial);
  state = reduceEditorHistory(state, { type: "begin_transaction" });
  for (const x of [4, 12, 28, 44]) {
    state = reduceEditorHistory(state, {
      type: "update_transaction",
      value: { ...state.present, x },
    });
  }

  assert.equal(state.past.length, 0);
  assert.equal(editorHistoryCanUndo(state), false);
  state = reduceEditorHistory(state, { type: "commit_transaction" });
  assert.equal(state.past.length, 1);
  assert.equal(state.present.x, 44);

  state = reduceEditorHistory(state, { type: "undo" });
  assert.equal(state.present.x, 0);
});

test("pointer cancellation restores the transaction start without adding history", () => {
  let state = createEditorHistory(initial);
  state = reduceEditorHistory(state, { type: "begin_transaction" });
  state = reduceEditorHistory(state, {
    type: "update_transaction",
    value: { ...state.present, x: 64 },
  });
  state = reduceEditorHistory(state, { type: "cancel_transaction" });

  assert.deepEqual(state.present, initial);
  assert.equal(state.past.length, 0);
  assert.equal(state.future.length, 0);
  assert.equal(state.transaction, null);
});

test("a no-op transaction preserves redo history", () => {
  let state = createEditorHistory(initial);
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "changed", x: 0 },
  });
  state = reduceEditorHistory(state, { type: "undo" });
  assert.equal(state.future.length, 1);

  state = reduceEditorHistory(state, { type: "begin_transaction" });
  state = reduceEditorHistory(state, {
    type: "update_transaction",
    value: { ...state.present, x: 10 },
  });
  state = reduceEditorHistory(state, {
    type: "update_transaction",
    value: { ...state.present, x: 0 },
  });
  state = reduceEditorHistory(state, { type: "commit_transaction" });

  assert.equal(state.past.length, 0);
  assert.equal(state.future.length, 1);
});

test("successful Save updates the baseline without clearing undo history", () => {
  let state = createEditorHistory(initial, { savedSemanticKey: "initial" });
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "saved", x: 0 },
  });
  state = reduceEditorHistory(state, {
    type: "mark_saved",
    savedSemanticKey: "saved",
  });

  assert.equal(editorHistoryIsDirty(state, "saved"), false);
  assert.equal(state.past.length, 1);

  state = reduceEditorHistory(state, { type: "undo" });
  assert.equal(state.present.semantic, "initial");
  assert.equal(editorHistoryIsDirty(state, "initial"), true);
  state = reduceEditorHistory(state, { type: "redo" });
  assert.equal(editorHistoryIsDirty(state, "saved"), false);
});

test("authoritative replacement resets history and the saved baseline", () => {
  let state = createEditorHistory(initial, { savedSemanticKey: "initial" });
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "local", x: 10 },
  });
  state = reduceEditorHistory(state, {
    type: "reset",
    value: { semantic: "remote", x: 20 },
    savedSemanticKey: "remote",
  });

  assert.deepEqual(state.present, { semantic: "remote", x: 20 });
  assert.equal(state.past.length, 0);
  assert.equal(state.future.length, 0);
  assert.equal(editorHistoryIsDirty(state, "remote"), false);
});

test("retains only the configured number of undo entries", () => {
  let state = createEditorHistory(initial, { limit: 3 });
  for (let index = 1; index <= 6; index += 1) {
    state = reduceEditorHistory(state, {
      type: "apply",
      value: { semantic: String(index), x: index },
    });
  }

  assert.deepEqual(
    state.past.map((entry) => entry.semantic),
    ["3", "4", "5"],
  );
  for (let index = 0; index < 3; index += 1) {
    state = reduceEditorHistory(state, { type: "undo" });
  }
  assert.equal(state.present.semantic, "3");
  assert.equal(editorHistoryCanUndo(state), false);
});

test("ignores workflow undo and redo while a native editor transaction is open", () => {
  let state = createEditorHistory(initial);
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "before typing", x: 0 },
  });
  state = reduceEditorHistory(state, { type: "begin_transaction" });
  state = reduceEditorHistory(state, {
    type: "update_transaction",
    value: { semantic: "typing", x: 0 },
  });

  assert.equal(
    reduceEditorHistory(state, { type: "undo" }),
    state,
  );
  assert.equal(
    reduceEditorHistory(state, { type: "redo" }),
    state,
  );
});

test("a canvas drag takes transaction ownership from a focused editor", () => {
  let state = createEditorHistory(initial, { savedSemanticKey: "initial" });
  let editingSurfaceActive = true;
  state = reduceEditorHistory(state, { type: "begin_transaction" });
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "typed", x: 0 },
  });

  assert.equal(
    finishEditingSurfaceTransaction({
      hasActiveSurface: () => editingSurfaceActive,
      clearActiveSurface: () => {
        editingSurfaceActive = false;
      },
      commitTransaction: () => {
        state = reduceEditorHistory(state, { type: "commit_transaction" });
      },
    }),
    true,
  );
  state = reduceEditorHistory(state, { type: "begin_transaction" });

  // The inspector blur arrives after pointerdown, but ownership was cleared,
  // so it must not commit the canvas transaction.
  if (editingSurfaceActive) {
    state = reduceEditorHistory(state, { type: "commit_transaction" });
  }
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "typed", x: 10 },
  });
  state = reduceEditorHistory(state, {
    type: "apply",
    value: { semantic: "typed", x: 20 },
  });
  state = reduceEditorHistory(state, { type: "commit_transaction" });

  assert.deepEqual(state.past, [
    initial,
    { semantic: "typed", x: 0 },
  ]);
  state = reduceEditorHistory(state, { type: "undo" });
  assert.deepEqual(state.present, { semantic: "typed", x: 0 });
  state = reduceEditorHistory(state, { type: "undo" });
  assert.deepEqual(state.present, initial);
});
