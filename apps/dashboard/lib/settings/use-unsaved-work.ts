import { useEffect } from "react";

import { trackUnsavedSettings } from "./unsaved";

/**
 * What a form holding a draft owes the person typing it, in one call.
 *
 * Two exits, two guards. Moving inside the cockpit goes through the shell's
 * `navigate`, which asks the dirty registry (`unsaved.ts`) because
 * `router.push` never fires `beforeunload`. Reloading, closing the tab or
 * following a plain link leaves the document, which only the browser's own
 * `beforeunload` prompt can stop. Each form owns its listener, installed here
 * while it is dirty; no history sentinel is pushed.
 *
 * One hook rather than two effects per form, because the connection form did
 * the first and not the second: every in-app move asked, and a reload took a
 * half-typed token without a word.
 */
export function useUnsavedWork(formId: string, dirty: boolean): void {
  useEffect(() => trackUnsavedSettings(formId, dirty), [formId, dirty]);

  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const w = window;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy prompt trigger, still required by Chrome and Edge before 119.
      event.returnValue = true;
    };
    w.addEventListener("beforeunload", onBeforeUnload);
    return () => w.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
