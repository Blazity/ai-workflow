import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { installTestDom } from "@/components/ui/test-dom";
import { MoreSheet } from "./more-sheet";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const ROUTER = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
};

// Red when: Sign out lives only in the laptop top bar, which a phone never
// shows, so a phone cannot sign out (QA).
test("the phone's More sheet offers Sign out", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <AppRouterContext.Provider value={ROUTER as never}>
          <MoreSheet open onClose={() => {}} active="runs" onNav={() => {}} />
        </AppRouterContext.Provider>,
      );
    });
    const buttons = [...document.body.querySelectorAll("button")].map((node) => node.textContent);
    assert.ok(buttons.includes("Sign out"), `buttons: ${buttons.join(", ")}`);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
