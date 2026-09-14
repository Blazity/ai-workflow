import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NavItem } from "./index";
import { installTestDom } from "./test-dom";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("NavItem preserves active and inactive sidebar styles", () => {
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
    assert.match(active.className, /bg-mariner-100/);
    assert.match(active.className, /text-mariner/);
    assert.match(active.className, /font-semibold/);
    assert.match(active.className, /py-\[9px\]/);
    assert.match(active.className, /gap-\[10px\]/);
    assert.ok(active.querySelector("[data-nav-indicator]"));
    assert.match(active.querySelector<HTMLElement>('[aria-hidden="true"]')?.className ?? "", /text-mariner/);

    assert.equal(inactive.hasAttribute("aria-current"), false);
    assert.match(inactive.className, /bg-transparent/);
    assert.match(inactive.className, /text-neutral-800/);
    assert.match(inactive.className, /font-medium/);
    assert.match(inactive.className, /hover:bg-app-bg/);
    assert.doesNotMatch(inactive.className, /font-normal/);
    assert.match(inactive.querySelector<HTMLElement>('[aria-hidden="true"]')?.className ?? "", /text-neutral-700/);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
