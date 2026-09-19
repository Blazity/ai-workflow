/**
 * The little the visibility views ask of a browser, for the test runner, which
 * has no DOM: the live poll asks the document whether the tab is visible and
 * subscribes to focus, and the URL writer asks the window where it is.
 *
 * Returns the undo, which has to run AFTER the tree unmounts: the poll's own
 * cleanup asks the document again on the way out.
 */
export function installBrowser(): () => void {
  const previous = {
    window: (globalThis as { window?: unknown }).window,
    document: (globalThis as { document?: unknown }).document,
  };
  const listeners = { addEventListener: () => {}, removeEventListener: () => {} };
  (globalThis as { window?: unknown }).window = {
    ...listeners,
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState: () => {} },
  };
  (globalThis as { document?: unknown }).document = { ...listeners, visibilityState: "visible" };
  return () => {
    if (previous.window === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous.window;
    if (previous.document === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = previous.document;
  };
}
