import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installTestDom } from "./test-dom";
import { Checkbox } from "./checkbox";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Checkbox renders its label and applies indeterminate state", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Checkbox
          indeterminate
          label="Selected repositories"
          labelTitle="Selection help"
        />,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(input);
    assert.equal(input.indeterminate, true);
    assert.equal(input.getAttribute("aria-checked"), "mixed");
    const wrapper = container.querySelector("label");
    assert.equal(wrapper?.title, "Selection help");
    assert.match(container.textContent ?? "", /Selected repositories/);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
