import assert from "node:assert/strict";
import test from "node:test";
import {
  initialDialogFocusTarget,
  promptEditorModalCapabilities,
  promptEditorSurface,
  trappedDialogTabTarget,
} from "./prompt-editor-modal-contract";

type FocusTarget = { focus: () => void };

function target(): FocusTarget {
  return { focus() {} };
}

test("initial dialog focus prefers the explicit initial target", () => {
  const first = target();
  const close = target();
  const dialog = target();

  assert.equal(initialDialogFocusTarget(close, [first, close], dialog), close);
  assert.equal(initialDialogFocusTarget(null, [first], dialog), first);
  assert.equal(initialDialogFocusTarget(null, [], dialog), dialog);
});

test("Tab and Shift+Tab wrap at dialog boundaries and recover escaped focus", () => {
  const first = target();
  const middle = target();
  const last = target();
  const outside = target();
  const focusable = [first, middle, last];

  assert.equal(trappedDialogTabTarget(focusable, last, false), first);
  assert.equal(trappedDialogTabTarget(focusable, first, true), last);
  assert.equal(trappedDialogTabTarget(focusable, middle, false), null);
  assert.equal(trappedDialogTabTarget(focusable, outside, false), first);
  assert.equal(trappedDialogTabTarget(focusable, outside, true), last);
});

test("read-only modal capabilities allow inspection but no mutation", () => {
  assert.deepEqual(promptEditorModalCapabilities(true, true), {
    canEdit: false,
    canInsert: false,
    canSave: false,
  });
  assert.deepEqual(promptEditorModalCapabilities(false, true), {
    canEdit: true,
    canInsert: true,
    canSave: true,
  });
  assert.deepEqual(promptEditorModalCapabilities(false, false), {
    canEdit: true,
    canInsert: true,
    canSave: false,
  });
});

test("library variant keeps editing but never offers save-to-library", () => {
  assert.deepEqual(promptEditorModalCapabilities(false, true, "library"), {
    canEdit: true,
    canInsert: true,
    canSave: false,
  });
});

test("v2 uses one continuous prompt while v1 retains section composition", () => {
  assert.equal(promptEditorSurface("v2"), "continuous");
  assert.equal(promptEditorSurface("v1"), "sections");
});
