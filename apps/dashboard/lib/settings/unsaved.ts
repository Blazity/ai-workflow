// apps/dashboard/lib/settings/unsaved.ts
//
// Unsaved settings edits, readable by the cockpit shell before it navigates.
//
// Same problem the Repository scripts screen already solved: the shell renders a
// screen as opaque `children` (a server component's rendered output), so there
// is no provider boundary to thread state through, and `router.push` never
// fires `beforeunload`. The difference is the count. One Repository scripts
// screen is ever mounted, so one module-level boolean is enough there; the
// Settings page mounts nine forms at once and the Memory page mounts a tenth,
// so this keeps a set of the dirty ones and answers "any".

const dirtyForms = new Set<string>();

/** Asked by the shell before a router.push leaves a screen holding edits. */
export function hasUnsavedSettings(): boolean {
  return dirtyForms.size > 0;
}

/**
 * Register or clear one form's dirty state, and return the cleanup that
 * unregisters it. Called from an effect, so a form that unmounts while dirty
 * (a navigation the user confirmed) never leaves the flag standing.
 */
export function trackUnsavedSettings(formId: string, dirty: boolean): () => void {
  if (dirty) dirtyForms.add(formId);
  else dirtyForms.delete(formId);
  return () => {
    dirtyForms.delete(formId);
  };
}

/** Test seam: the set outlives a test file's renders otherwise. */
export function resetUnsavedSettings(): void {
  dirtyForms.clear();
}
