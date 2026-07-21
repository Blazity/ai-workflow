export type DialogFocusTarget = { focus: () => void };

export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function initialDialogFocusTarget<T extends DialogFocusTarget>(
  preferred: T | null,
  focusable: readonly T[],
  dialog: T,
): T {
  return preferred ?? focusable[0] ?? dialog;
}

export function trappedDialogTabTarget<T extends DialogFocusTarget>(
  focusable: readonly T[],
  active: DialogFocusTarget | null,
  backwards: boolean,
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeIndex = focusable.indexOf(active as T);
  if (activeIndex === -1) return backwards ? last : first;
  if (backwards && active === first) return last;
  if (!backwards && active === last) return first;
  return null;
}

export function promptEditorModalCapabilities(
  disabled: boolean,
  hasContent: boolean,
  variant: "field" | "library" = "field",
) {
  return {
    canEdit: !disabled,
    canInsert: !disabled,
    // "Save to library" lifts a block field's text into a new library prompt;
    // in library mode the prompt already lives there, so the button hides.
    canSave: !disabled && hasContent && variant === "field",
  };
}
