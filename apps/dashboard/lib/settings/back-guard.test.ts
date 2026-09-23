import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom } from "@/components/ui/test-dom";

import { guardHistoryTraversal } from "./back-guard";
import { DISCARD_UNSAVED_PROMPT } from "./unsaved";

const SCREEN = "http://localhost/integrations/jira/connection";
const PREVIOUS = "http://localhost/integrations";
const SCREEN_STATE = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["connection"] };

/**
 * A document on the connection screen, with the router's own popstate
 * listener registered first, as the App Router registers it at mount, and a
 * Back that has already moved the URL, as the browser's does before popstate.
 */
function onScreen(t: TestContext, options: { unsaved: boolean; answer: boolean }) {
  const dom = installTestDom();
  t.after(() => dom.restore());
  const win = dom.window as unknown as Window;
  win.history.replaceState(SCREEN_STATE, "", SCREEN);

  const routed: string[] = [];
  win.addEventListener("popstate", () => routed.push(win.location.href));
  const asked: string[] = [];
  (win as unknown as { confirm: (message: string) => boolean }).confirm = (message) => {
    asked.push(message);
    return options.answer;
  };
  let agreed = 0;
  const guard = guardHistoryTraversal(win as never, {
    holdsUnsavedWork: () => options.unsaved,
    agreedToLeave: () => {
      agreed += 1;
    },
  });
  t.after(() => guard.dispose());
  guard.remember();

  const back = () => {
    win.history.replaceState({ __NA: true }, "", PREVIOUS);
    win.dispatchEvent(new (win as unknown as { PopStateEvent: typeof PopStateEvent }).PopStateEvent("popstate", { state: { __NA: true } }));
  };
  return { win, routed, asked, back, agreed: () => agreed };
}

test("Back with a half-typed token asks first, and a no keeps the screen and its URL", (t) => {
  // The in-page links and a reload already asked; the browser's Back and a
  // phone's back gesture threw the pasted token away without a word.
  const screen = onScreen(t, { unsaved: true, answer: false });
  screen.back();

  assert.deepEqual(screen.asked, [DISCARD_UNSAVED_PROMPT]);
  assert.deepEqual(screen.routed, [], "the router never heard the Back");
  assert.equal(screen.win.location.href, SCREEN, "the address bar is back on the screen");
  assert.deepEqual(screen.win.history.state, SCREEN_STATE, "with the router's own entry");
});

test("a yes lets the router go back, and says so once", (t) => {
  const screen = onScreen(t, { unsaved: true, answer: true });
  screen.back();

  assert.deepEqual(screen.routed, [PREVIOUS]);
  assert.equal(screen.agreed(), 1);
});

test("with nothing unsaved, Back is the router's and nobody is asked", (t) => {
  const screen = onScreen(t, { unsaved: false, answer: false });
  screen.back();

  assert.deepEqual(screen.asked, []);
  assert.deepEqual(screen.routed, [PREVIOUS]);
});
