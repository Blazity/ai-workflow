import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { BlazityLogo } from "../ui";
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

test("BlazityLogo pins the flame geometry", () => {
  const html = renderToString(<BlazityLogo size={22} showWord={false} />);

  assert.match(html, /viewBox="0 0 246 257"/);
  assert.match(
    html,
    /d="M128\.528 50\.6272C114\.492 42\.8058 104\.235 38\.3392 104\.235 38\.3392L115\.695 65\.5526L0 0L61\.8541 124\.931L33\.3877 112\.562C33\.3877 112\.562 37\.6218 120\.293 42\.6744 131\.843C51\.6579 152\.377 58\.3274 170\.809 65\.2495 190\.696C77\.7597 226\.6 111\.865 256\.683 153\.731 256\.683C204\.671 256\.683 245\.971 215\.464 245\.971 164\.614C245\.971 125\.881 222\.002 92\.7256 188\.058 79\.134C167\.615 70\.9488 147\.759 61\.359 128\.518 50\.6373L128\.528 50\.6272Z"/,
  );
});
