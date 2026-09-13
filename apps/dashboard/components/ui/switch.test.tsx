import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installTestDom } from "./test-dom";
import { Switch } from "./switch";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Switch toggles by click, Space, and Enter", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const changes: boolean[] = [];
  let root: Root | undefined;

  function Harness() {
    const [checked, setChecked] = useState(false);
    return (
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          changes.push(next);
          setChecked(next);
        }}
        aria-label="Enabled"
      />
    );
  }

  try {
    act(() => {
      root = createRoot(container);
      root.render(<Harness />);
    });
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(control);
    assert.equal(control.getAttribute("aria-checked"), "false");

    act(() => control.click());
    for (const key of [" ", "Enter"]) {
      act(() => {
        control.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }) as unknown as Event);
      });
    }
    assert.deepEqual(changes, [true, false, true]);
    assert.equal(control.getAttribute("aria-checked"), "true");
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
