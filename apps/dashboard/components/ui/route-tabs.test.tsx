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
