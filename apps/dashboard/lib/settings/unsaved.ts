// apps/dashboard/lib/settings/unsaved.ts
//
// Unsaved edits anywhere in the cockpit, readable by the shell before it
// navigates.
//
// The shell renders a screen as opaque `children` (a server component's
// rendered output), so there is no provider boundary to thread state through,
// and `router.push` never fires `beforeunload`. A set of dirty form ids rather
// than one boolean, because the Settings page mounts nine forms at once, the
// Memory page mounts a tenth, and a repository entry mounts one per tab.
//
// It lives under lib/settings because that is where the registry was written;
// it is not settings-only, and every screen that can hold an unsaved draft
// registers here rather than growing a second flag the shell would have to
// remember to ask.

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

/** Asked by the shell, the logout button and any screen guarding its own exit
 *  before an unsaved draft is thrown away. One sentence, so a user is never
 *  asked the same question in two different words. */
export const DISCARD_UNSAVED_PROMPT = "Discard unsaved changes?";
