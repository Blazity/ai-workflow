import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installTestDom } from "./test-dom";
import { RouteTabs } from "./route-tabs";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("RouteTabs marks the active route and reports tab changes", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const changes: string[] = [];
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <RouteTabs
          aria-label="Repository sections"
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "rules", label: "Rules" },
          ]}
          active="overview"
          onChange={(id) => changes.push(id)}
        />,
      );
    });
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    assert.equal(tabs[0]?.getAttribute("aria-current"), "page");
    assert.equal(tabs[1]?.hasAttribute("aria-current"), false);
    act(() => tabs[1]?.click());
    assert.deepEqual(changes, ["rules"]);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("a tab with an href is a link, and a plain click still reaches onChange", () => {
  // Anything that changes the URL should behave like a link: a right address
  // bar, a working back button, cmd-click opening a tab. The handler is what
  // keeps an in-cockpit move inside whatever guard the caller owns, which for
  // an area tab is the unsaved-work prompt.
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const changes: string[] = [];
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <RouteTabs
          aria-label="Demo pages"
          tabs={[
            { id: "overview", label: "Overview", href: "/integrations/demo/overview" },
            { id: "connection", label: "Connection", href: "/integrations/demo/connection" },
            { id: "later", label: "Later", href: "/nope", disabled: true },
          ]}
          active="overview"
          onChange={(id) => changes.push(id)}
        />,
      );
    });
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
    assert.equal(links.length, 2, "a disabled tab stays a button, which an anchor cannot be");
    assert.equal(links[0]?.getAttribute("href"), "/integrations/demo/overview");
    assert.equal(links[0]?.getAttribute("aria-current"), "page");
    act(() => links[1]?.click());
    assert.deepEqual(changes, ["connection"], "a plain click is handled by the caller");
    assert.equal(container.querySelectorAll("button").length, 1);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
