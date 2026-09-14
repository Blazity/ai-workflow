import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NavItem } from "./index";
import { installTestDom } from "./test-dom";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("NavItem marks the active sidebar destination", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <>
          <NavItem label="Workflow runs" icon={<svg />} active />
          <NavItem label="Approvals" icon={<svg />} />
        </>,
      );
    });

    const active = container.querySelector<HTMLButtonElement>('[aria-label="Workflow runs"]');
    const inactive = container.querySelector<HTMLButtonElement>('[aria-label="Approvals"]');
    assert.ok(active);
    assert.ok(inactive);
    assert.equal(active.getAttribute("aria-current"), "page");
    assert.equal(inactive.hasAttribute("aria-current"), false);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
