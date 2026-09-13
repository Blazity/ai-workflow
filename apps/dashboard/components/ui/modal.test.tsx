import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal } from "./modal";
import { installTestDom } from "./test-dom";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Modal wires its title and description to an aria modal dialog", () => {
  const html = renderToStaticMarkup(
    <Modal open onClose={() => undefined} title="Start run" description="Review the ticket." footer={<button>Confirm</button>}>
      Run AIW-284 from main.
    </Modal>,
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /Start run/);
  assert.match(html, /Confirm/);
});

test("Modal renders all canonical panel widths", () => {
  for (const [size, width] of [["sm", "476"], ["md", "680"], ["lg", "1240"]] as const) {
    const html = renderToStaticMarkup(<Modal open size={size} onClose={() => undefined} title="Dialog">Body</Modal>);
    assert.match(html, new RegExp(`max-w-\\[${width}px\\]`));
  }
});

test("Modal renders the drawer variant against the viewport edge", () => {
  const html = renderToStaticMarkup(
    <Modal open variant="drawer" onClose={() => undefined} title="Drawer">Body</Modal>,
  );
  assert.match(html, /data-variant="drawer"/);
  assert.match(html, /justify-end/);
  assert.match(html, /max-w-\[620px\]/);
  assert.match(html, /rounded-none/);
});

test("Modal moves focus inside, traps Tab in both directions, and restores prior focus", () => {
  const dom = installTestDom();
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const container = document.createElement("div");
  document.body.append(container);
  const initialFocusRef = createRef<HTMLButtonElement>();
  let root: Root | undefined;
  const render = (open: boolean) => (
    <Modal open={open} onClose={() => undefined} title="Dialog" initialFocusRef={initialFocusRef}>
      <button>First</button>
      <button ref={initialFocusRef}>Initial</button>
      <button>Last</button>
    </Modal>
  );

  try {
    act(() => {
      root = createRoot(container);
      root.render(render(true));
    });
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'));
    assert.equal(document.activeElement, buttons[1]);

    buttons[0]?.focus();
    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.activeElement, buttons[2]);

    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.activeElement, buttons[0]);

    act(() => root?.render(render(false)));
    assert.equal(document.activeElement, opener);
  } finally {
    act(() => root?.unmount());
    container.remove();
    opener.remove();
    dom.restore();
  }
});

test("Modal focuses its first control when no initial focus ref is supplied", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Modal open onClose={() => undefined} title="Dialog">
          <button>First</button>
          <button>Second</button>
        </Modal>,
      );
    });
    const first = document.querySelector<HTMLButtonElement>('[role="dialog"] button');
    assert.ok(first);
    assert.equal(document.activeElement, first);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal closes on Escape and overlay clicks but not panel clicks", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let closes = 0;

  try {
    act(() => {
      root = createRoot(container);
      root.render(<Modal open onClose={() => closes += 1} title="Dialog">Body</Modal>);
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const overlay = document.querySelector<HTMLElement>('[aria-hidden="true"]');
    assert.ok(dialog);
    assert.ok(overlay);

    act(() => dialog.click());
    assert.equal(closes, 0);
    act(() => overlay.click());
    assert.equal(closes, 1);
    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(closes, 2);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal ignores Escape and overlay clicks when it is not dismissible", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let closes = 0;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Modal open dismissible={false} onClose={() => closes += 1} title="Dialog">
          Body
        </Modal>,
      );
    });
    const overlay = document.querySelector<HTMLElement>('[aria-hidden="true"]');
    assert.ok(overlay);

    act(() => overlay.click());
    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(closes, 0);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
