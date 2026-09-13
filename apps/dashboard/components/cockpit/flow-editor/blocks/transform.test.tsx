import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkflowDataCatalogEntry } from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import {
  defaultTransformConfiguration,
  TransformFields,
} from "./transform";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const values: WorkflowDataCatalogEntry[] = [{
  reference: "steps.entry.output.text",
  label: "Trigger · text",
  description: "Text",
  schema: { type: "string" },
  source: { kind: "trigger", nodeId: "entry" },
  presence: "required",
  availability: { state: "available", guarantee: "Guaranteed." },
  compatibleInputNames: [],
}];

test("creates all seven canonical operations", () => {
  assert.deepEqual(defaultTransformConfiguration("format_text"), {
    operation: "format_text",
    template: "",
  });
  assert.equal(defaultTransformConfiguration("build_object").operation, "build_object");
  assert.equal(defaultTransformConfiguration("parse_json").operation, "parse_json");
});

test("renders every approved action and the selected output shape", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <TransformFields
          configuration={{
            operation: "replace_text",
            source: "steps.entry.output.text",
            mode: "plain",
            pattern: "a",
            replacement: "b",
            ignoreCase: false,
          }}
          availableValues={values}
          canEdit
          onChange={() => undefined}
        />,
      );
    });
    const action = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Action"]');
    assert.ok(action);
    act(() => action.click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    assert.ok(listbox);
    assert.deepEqual(
      Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).map(
        (option) => option.textContent?.trim(),
      ),
      [
        "Format text",
        "Trim text",
        "Replace text",
        "Text to number",
        "Number to text",
        "Parse JSON",
        "Build object",
      ],
    );
    assert.match(container.textContent ?? "", /Output shape/);
    assert.match(container.textContent ?? "", /Ignore capitalization/);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
