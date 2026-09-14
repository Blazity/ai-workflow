import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal, type ModalProps } from "./modal";
import { Select } from "./select";
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

test("Modal chrome none renders custom content with an accessible name", () => {
  type MissingAccessibleName = {
    chrome: "none";
    onClose: () => void;
    children: string;
  } extends ModalProps ? true : false;
  const missingAccessibleName: MissingAccessibleName = false;
  assert.equal(missingAccessibleName, false);

  const html = renderToStaticMarkup(
    <Modal
      open
      chrome="none"
      aria-label="Prompt editor"
      onClose={() => undefined}
    >
      <div>Custom header, tabs, body, and footer</div>
    </Modal>,
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Prompt editor"/);
  assert.doesNotMatch(html, /aria-labelledby=/);
  assert.match(html, /Custom header, tabs, body, and footer/);

  const titled = renderToStaticMarkup(
    <Modal chrome="none" title="Custom titled dialog" onClose={() => undefined}>
      Custom body
    </Modal>,
  );
  assert.match(titled, /aria-labelledby=/);
  assert.doesNotMatch(titled, /aria-label=/);
  assert.match(titled, /Custom titled dialog/);
});

test("Modal chrome none closes on Escape and backdrop mouse down", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let closes = 0;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Modal chrome="none" aria-label="Custom dialog" onClose={() => closes += 1}>
          <div>Custom chrome</div>
        </Modal>,
      );
    });
    const overlay = document.querySelector<HTMLElement>("[data-modal-overlay]");
    assert.ok(overlay);

    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(closes, 1);

    act(() => overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    assert.equal(closes, 2);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal chrome none closes only the topmost dialog on Escape", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let lowerCloses = 0;
  let upperCloses = 0;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <>
          <Modal chrome="none" aria-label="Lower dialog" onClose={() => lowerCloses += 1}>
            Lower
          </Modal>
          <Modal chrome="none" aria-label="Upper dialog" onClose={() => upperCloses += 1}>
            Upper
          </Modal>
        </>,
      );
    });

    act(() => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(lowerCloses, 0);
    assert.equal(upperCloses, 1);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal chrome none makes cockpit main inert and restores it on close", () => {
  const dom = installTestDom();
  const main = document.createElement("main");
  main.dataset.cockpitMain = "";
  document.body.append(main);
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  const render = (open: boolean) => (
    <Modal chrome="none" aria-label="Custom dialog" open={open} onClose={() => undefined}>
      Custom chrome
    </Modal>
  );

  try {
    act(() => {
      root = createRoot(container);
      root.render(render(true));
    });
    assert.equal(main.hasAttribute("inert"), true);

    act(() => root?.render(render(false)));
    assert.equal(main.hasAttribute("inert"), false);
  } finally {
    act(() => root?.unmount());
    container.remove();
    main.remove();
    dom.restore();
  }
});

test("Modal chrome none focuses its initial focus ref", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const initialFocusRef = createRef<HTMLButtonElement>();
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Modal
          chrome="none"
          aria-label="Custom dialog"
          onClose={() => undefined}
          initialFocusRef={initialFocusRef}
        >
          <button>First</button>
          <button ref={initialFocusRef}>Initial</button>
        </Modal>,
      );
    });
    assert.equal(document.activeElement, initialFocusRef.current);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal chrome none restores focus to the previously focused element", () => {
  const dom = installTestDom();
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  const render = (open: boolean) => (
    <Modal chrome="none" aria-label="Custom dialog" open={open} onClose={() => undefined}>
      <button>First</button>
    </Modal>
  );

  try {
    act(() => {
      root = createRoot(container);
      root.render(render(true));
    });
    assert.notEqual(document.activeElement, opener);

    act(() => root?.render(render(false)));
    assert.equal(document.activeElement, opener);
  } finally {
    act(() => root?.unmount());
    container.remove();
    opener.remove();
    dom.restore();
  }
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

test("Modal honors the initial focus marker before the first control", () => {
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
          <button data-dialog-initial-focus>Marked</button>
        </Modal>,
      );
    });
    const marked = document.querySelector<HTMLButtonElement>("[data-dialog-initial-focus]");
    assert.ok(marked);
    assert.equal(document.activeElement === marked, true);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal keeps body scroll locked until two open modals close in either order", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  document.body.style.overflow = "clip";
  let root: Root | undefined;

  const render = (lowerOpen: boolean, upperOpen: boolean) => (
    <>
      <Modal chrome="none" aria-label="Lower dialog" open={lowerOpen} onClose={() => undefined}>
        Lower
      </Modal>
      <Modal chrome="none" aria-label="Upper dialog" open={upperOpen} onClose={() => undefined}>
        Upper
      </Modal>
    </>
  );

  try {
    act(() => {
      root = createRoot(container);
      root.render(render(true, true));
    });
    assert.equal(document.body.style.overflow, "hidden");

    act(() => root?.render(render(false, true)));
    assert.equal(document.body.style.overflow, "hidden");

    act(() => root?.render(render(false, false)));
    assert.equal(document.body.style.overflow, "clip");

    act(() => root?.render(render(true, true)));
    act(() => root?.render(render(true, false)));
    assert.equal(document.body.style.overflow, "hidden");
    act(() => root?.render(render(false, false)));
    assert.equal(document.body.style.overflow, "clip");
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal restores body scroll when an open modal unmounts", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  document.body.style.overflow = "scroll";
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Modal open onClose={() => undefined} title="Dialog">
          Body
        </Modal>,
      );
    });
    assert.equal(document.body.style.overflow, "hidden");
    act(() => root?.unmount());
    root = undefined;
    assert.equal(document.body.style.overflow, "scroll");
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal preserves native autoFocus inside the dialog", () => {
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
          <button autoFocus>Automatic</button>
        </Modal>,
      );
    });
    const automatic = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((button) => button.textContent === "Automatic");
    assert.ok(automatic);
    assert.equal(document.activeElement === automatic, true);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Escape closes an open Select before it closes the Modal", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let closes = 0;

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <Modal
        open={open}
        onClose={() => {
          closes += 1;
          setOpen(false);
        }}
        title="Dialog"
      >
        <Select
          aria-label="Repository"
          value="dashboard"
          onChange={() => undefined}
          options={[
            { value: "dashboard", label: "Dashboard" },
            { value: "worker", label: "Worker" },
          ]}
        />
      </Modal>
    );
  }

  try {
    act(() => {
      root = createRoot(container);
      root.render(<Harness />);
    });
    const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]');
    assert.ok(trigger);
    act(() => trigger.click());
    assert.ok(document.querySelector('[role="listbox"]'));

    const pressEscape = () => act(() => {
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }) as unknown as Event);
    });

    pressEscape();
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(closes, 0);
    assert.equal(document.querySelector<HTMLElement>('[role="dialog"]')?.dataset.state, "open");

    pressEscape();
    assert.equal(closes, 1);
    assert.equal(document.querySelector<HTMLElement>('[role="dialog"]')?.dataset.state, "closed");
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});

test("Modal closes on Escape and overlay mouse down but not panel or drag release", () => {
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

    act(() => dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    assert.equal(closes, 0);
    act(() => overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    assert.equal(closes, 1);
    act(() => {
      dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(closes, 1);
    const handledEscape = new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handledEscape.preventDefault();
    act(() => dom.window.dispatchEvent(handledEscape));
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

test("Modal hides its close button and ignores Escape and overlay mouse down when it is not dismissible", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  let closes = 0;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Modal open dismissible={false} showCloseButton onClose={() => closes += 1} title="Dialog">
          Body
        </Modal>,
      );
    });
    const overlay = document.querySelector<HTMLElement>('[aria-hidden="true"]');
    assert.ok(overlay);
    assert.equal(document.querySelector('[aria-label="Close"]'), null);

    act(() => overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
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
