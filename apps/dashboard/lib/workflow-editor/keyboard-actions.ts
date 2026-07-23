export type WorkflowEditorKeyboardAction =
  | "undo"
  | "redo"
  | "copy"
  | "paste"
  | "delete";

export interface WorkflowEditorKeyboardEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

function asElementLike(target: EventTarget | null | undefined): ElementLike | null {
  return target && typeof target === "object"
    ? (target as unknown as ElementLike)
    : null;
}

/** Native text surfaces and every control inside a dialog keep ownership of
 * keyboard input. In particular, Cmd/Ctrl+Z must reach Tiptap while focused. */
export function workflowKeyboardTargetOwnsInput(
  target: EventTarget | null | undefined,
): boolean {
  const element = asElementLike(target);
  if (!element) return false;
  if (element.closest?.('[role="dialog"]')) return true;
  if (element.isContentEditable) return true;
  const tagName = element.tagName?.toLowerCase();
  if (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  ) {
    return true;
  }
  return Boolean(
    element.closest?.(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  );
}

export function workflowEditorKeyboardAction(
  event: WorkflowEditorKeyboardEvent,
  options: { canEdit: boolean },
): WorkflowEditorKeyboardAction | null {
  if (workflowKeyboardTargetOwnsInput(event.target)) return null;
  if (event.altKey) return null;

  const modifier = Boolean(event.metaKey || event.ctrlKey);
  const key = event.key.toLowerCase();
  if (modifier) {
    if (key === "c" && !event.shiftKey) return "copy";
    if (!options.canEdit) return null;
    if (key === "v" && !event.shiftKey) return "paste";
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    return null;
  }
  if (
    options.canEdit &&
    !event.shiftKey &&
    (event.key === "Delete" || event.key === "Backspace")
  ) {
    return "delete";
  }
  return null;
}

export function workflowShortcutLabel(
  action: Exclude<WorkflowEditorKeyboardAction, "delete">,
  platform: "mac" | "other",
): string {
  const modifier = platform === "mac" ? "Cmd" : "Ctrl";
  switch (action) {
    case "undo":
      return `${modifier}+Z`;
    case "redo":
      return `${modifier}+Shift+Z`;
    case "copy":
      return `${modifier}+C`;
    case "paste":
      return `${modifier}+V`;
  }
}

export function wrappedDialogTabIndex(options: {
  activeIndex: number;
  focusableCount: number;
  shiftKey: boolean;
}): number | null {
  if (options.focusableCount < 1) return null;
  if (options.activeIndex < 0) {
    return options.shiftKey ? options.focusableCount - 1 : 0;
  }
  if (options.shiftKey && options.activeIndex === 0) {
    return options.focusableCount - 1;
  }
  if (
    !options.shiftKey &&
    options.activeIndex === options.focusableCount - 1
  ) {
    return 0;
  }
  return null;
}
