import assert from "node:assert/strict";
import { test } from "node:test";
import {
  workflowEditorKeyboardAction,
  workflowKeyboardTargetOwnsInput,
  workflowShortcutLabel,
  wrappedDialogTabIndex,
} from "./keyboard-actions.ts";

function target(input: {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}): EventTarget {
  return input as unknown as EventTarget;
}

test("maps the specified canvas shortcuts", () => {
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(
      workflowEditorKeyboardAction(
        { key: "z", ...modifier },
        { canEdit: true },
      ),
      "undo",
    );
    assert.equal(
      workflowEditorKeyboardAction(
        { key: "Z", shiftKey: true, ...modifier },
        { canEdit: true },
      ),
      "redo",
    );
    assert.equal(
      workflowEditorKeyboardAction(
        { key: "c", ...modifier },
        { canEdit: true },
      ),
      "copy",
    );
    assert.equal(
      workflowEditorKeyboardAction(
        { key: "v", ...modifier },
        { canEdit: true },
      ),
      "paste",
    );
  }
  assert.equal(
    workflowEditorKeyboardAction({ key: "Delete" }, { canEdit: true }),
    "delete",
  );
  assert.equal(
    workflowEditorKeyboardAction({ key: "Backspace" }, { canEdit: true }),
    "delete",
  );
});

test("read-only editors may copy but cannot mutate history or the graph", () => {
  assert.equal(
    workflowEditorKeyboardAction(
      { key: "c", metaKey: true },
      { canEdit: false },
    ),
    "copy",
  );
  for (const event of [
    { key: "v", metaKey: true },
    { key: "z", metaKey: true },
    { key: "z", metaKey: true, shiftKey: true },
    { key: "Delete" },
  ]) {
    assert.equal(
      workflowEditorKeyboardAction(event, { canEdit: false }),
      null,
    );
  }
});

test("native fields, Tiptap surfaces, and dialogs retain every shortcut", () => {
  const nativeTargets = [
    target({ tagName: "INPUT" }),
    target({ tagName: "textarea" }),
    target({ tagName: "SELECT" }),
    target({ tagName: "DIV", isContentEditable: true }),
    target({
      tagName: "SPAN",
      closest: (selector) =>
        selector.includes("contenteditable") ? {} : null,
    }),
    target({
      tagName: "BUTTON",
      closest: (selector) => (selector.includes("dialog") ? {} : null),
    }),
  ];
  for (const nativeTarget of nativeTargets) {
    assert.equal(workflowKeyboardTargetOwnsInput(nativeTarget), true);
    assert.equal(
      workflowEditorKeyboardAction(
        { key: "z", metaKey: true, target: nativeTarget },
        { canEdit: true },
      ),
      null,
    );
    assert.equal(
      workflowEditorKeyboardAction(
        { key: "Backspace", target: nativeTarget },
        { canEdit: true },
      ),
      null,
    );
  }
});

test("ignores modified deletes and Alt shortcuts", () => {
  assert.equal(
    workflowEditorKeyboardAction(
      { key: "Delete", shiftKey: true },
      { canEdit: true },
    ),
    null,
  );
  assert.equal(
    workflowEditorKeyboardAction(
      { key: "z", metaKey: true, altKey: true },
      { canEdit: true },
    ),
    null,
  );
});

test("exposes accessible platform-specific shortcut labels", () => {
  assert.equal(workflowShortcutLabel("undo", "mac"), "Cmd+Z");
  assert.equal(workflowShortcutLabel("redo", "other"), "Ctrl+Shift+Z");
  assert.equal(workflowShortcutLabel("copy", "other"), "Ctrl+C");
  assert.equal(workflowShortcutLabel("paste", "mac"), "Cmd+V");
});

test("wraps keyboard focus within a confirmation dialog", () => {
  assert.equal(
    wrappedDialogTabIndex({
      activeIndex: 1,
      focusableCount: 2,
      shiftKey: false,
    }),
    0,
  );
  assert.equal(
    wrappedDialogTabIndex({
      activeIndex: 0,
      focusableCount: 2,
      shiftKey: true,
    }),
    1,
  );
  assert.equal(
    wrappedDialogTabIndex({
      activeIndex: -1,
      focusableCount: 2,
      shiftKey: false,
    }),
    0,
  );
  assert.equal(
    wrappedDialogTabIndex({
      activeIndex: 0,
      focusableCount: 2,
      shiftKey: false,
    }),
    null,
  );
});
