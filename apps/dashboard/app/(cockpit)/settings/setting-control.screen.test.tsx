import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { settingDefinition } from "@integrations/registry";
import type { SettingsEntryView } from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import { SettingControl } from "./setting-control";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("settings switch toggles with Space and persists through the row change handler", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const definition = settingDefinition("ENABLE_REPO_MEMORY");
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
