import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "./field";
import { Select } from "./select";
import { Listbox } from "@/components/cockpit/listbox";
import { installTestDom } from "./test-dom";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const options = [
  { value: "dashboard", label: "Dashboard", hint: "Ready" },
  { value: "worker", label: "Worker", disabled: true },
  { value: "api", label: "API" },
];

test("Select composes Listbox without masking a visible Field label", () => {
  const element = Select({ value: "dashboard", onChange: () => undefined, options });
  assert.equal(element.type, Listbox);
  assert.deepEqual(element.props.options, options);
  const html = renderToStaticMarkup(<Field label="Repository">{element}</Field>);
  const controlId = html.match(/<label for="([^"]+)"/)?.[1];
  assert.ok(controlId);
  assert.match(html, new RegExp(`id="${controlId}"`));
  assert.match(html, /Dashboard/);
  assert.doesNotMatch(html, /aria-label=/);
  assert.match(html, /h-\[30px\]/);
  assert.doesNotMatch(html, /h-\[26px\]/);
});

test("Select forwards invalid, disabled, size, and accessible description", () => {
  const element = Select({
    value: "dashboard",
    onChange: () => undefined,
    options,
    size: "compact",
    invalid: true,
    disabled: true,
    "aria-label": "Repository",
    "aria-describedby": "repository-error",
  });
  const html = renderToStaticMarkup(element);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="Repository"/);
  assert.match(html, /aria-describedby="repository-error"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /h-\[26px\]/);
  assert.doesNotMatch(html, /h-\[30px\]/);
});

test("Select renders and chooses enabled options through the DOM", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const changes: string[] = [];
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Select
          value="dashboard"
          onChange={(value) => changes.push(value)}
          options={options}
          aria-label="Repository"
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);

    act(() => trigger.click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    assert.ok(listbox);
    const renderedOptions = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'));
    assert.equal(renderedOptions.length, 3);
    assert.equal(renderedOptions[0]?.getAttribute("aria-selected"), "true");
    assert.equal(renderedOptions[1]?.getAttribute("aria-selected"), "false");

    act(() => renderedOptions[1]?.click());
    assert.deepEqual(changes, []);
    assert.ok(document.querySelector('[role="listbox"]'));

    act(() => renderedOptions[2]?.click());
    assert.deepEqual(changes, ["api"]);
    assert.equal(document.querySelector('[role="listbox"]'), null);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Select keyboard navigation stays active on enabled options and Escape restores the trigger", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const keyboardOptions = [
    { value: "alpha", label: "Alpha" },
    { value: "bravo", label: "Bravo", disabled: true },
    { value: "charlie", label: "Charlie" },
    { value: "delta", label: "Delta" },
  ];
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(<Select value="charlie" onChange={() => undefined} options={keyboardOptions} />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);
    trigger.focus();
    act(() => trigger.click());

    const activeLabel = () => {
      const activeId = trigger.getAttribute("aria-activedescendant");
      return activeId
        ? document.querySelector<HTMLElement>(`[id="${activeId}"]`)?.textContent?.trim()
        : undefined;
    };
    const press = (key: string) => act(() => {
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }) as unknown as Event);
    });

    assert.equal(activeLabel(), "Charlie");
    press("ArrowDown");
    assert.equal(activeLabel(), "Delta");
    press("ArrowUp");
    assert.equal(activeLabel(), "Charlie");
    press("Home");
    assert.equal(activeLabel(), "Alpha");
    press("End");
    assert.equal(activeLabel(), "Delta");
    press("Escape");
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
