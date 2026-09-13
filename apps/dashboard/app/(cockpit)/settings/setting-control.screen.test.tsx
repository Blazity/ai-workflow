import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { findSettingDefinition } from "@shared/contracts";
import type { SettingsEntryView } from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import { SettingControl } from "./setting-control";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function rect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height: 18,
    right: width,
    bottom: 18,
    toJSON: () => ({}),
  } as DOMRect;
}

test("settings switch keeps its track width inside a stretch parent", () => {
  const dom = installTestDom();
  const style = document.createElement("style");
  style.textContent = [
    ".inline-flex{display:inline-flex}",
    ".w-fit{width:fit-content}",
    ".self-start{align-self:flex-start}",
    ".w-8{width:32px}",
  ].join("");
  document.head.append(style);
  const container = document.createElement("div");
  container.style.cssText = "display:flex;align-items:stretch;width:1418px";
  document.body.append(container);
  const definition = findSettingDefinition("ENABLE_REPO_MEMORY");
  assert.ok(definition);
  const entry: SettingsEntryView = {
    key: "ENABLE_REPO_MEMORY",
    value: false,
    default: definition.default,
    source: "default",
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    lastVersion: null,
  };
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <SettingControl
          entry={entry}
          value={false}
          disabled={false}
          invalid={false}
          onChange={() => undefined}
        />,
      );
    });
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]');
    const track = control?.querySelector<HTMLElement>("span");
    assert.ok(control);
    assert.ok(track);
    track.getBoundingClientRect = () => rect(32);
    control.getBoundingClientRect = () => {
      const style = getComputedStyle(control);
      return style.width === "fit-content" && style.alignSelf === "flex-start"
        ? track.getBoundingClientRect()
        : rect(1418);
    };
    assert.equal(
      control.getBoundingClientRect().width,
      track.getBoundingClientRect().width,
    );
  } finally {
    act(() => root?.unmount());
    container.remove();
    style.remove();
    dom.restore();
  }
});

test("settings switch toggles with Space and persists through the row change handler", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const definition = findSettingDefinition("ENABLE_REPO_MEMORY");
  assert.ok(definition);
  const entry: SettingsEntryView = {
    key: "ENABLE_REPO_MEMORY",
    value: false,
    default: definition.default,
    source: "default",
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    lastVersion: null,
  };
  const changes: boolean[] = [];
  let root: Root | undefined;

  function RowHarness() {
    const [value, setValue] = useState(false);
    return (
      <SettingControl
        entry={entry}
        value={value}
        disabled={false}
        invalid={false}
        onChange={(next) => {
          assert.equal(typeof next, "boolean");
          changes.push(next as boolean);
          setValue(next as boolean);
        }}
      />
    );
  }

  try {
    act(() => {
      root = createRoot(container);
      root.render(<RowHarness />);
    });
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(control);
    act(() => control.focus());
    assert.equal(document.activeElement, control);
    act(() => {
      control.dispatchEvent(new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.deepEqual(changes, [true]);
    assert.equal(control.getAttribute("aria-checked"), "true");
    assert.equal(control.textContent?.trim(), "on");
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
