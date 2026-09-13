import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  WorkflowBlockContract,
  WorkflowEditorOptions,
} from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import type { FlowNodeDef } from "@/lib/flows";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";
import { FlowEditor } from "./flow-editor";
import { RepositoryCatalogProvider } from "./repository-catalog-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const triggerContract: WorkflowBlockContract = {
  type: "trigger_ticket_ai",
  presentation: {
    group: "trigger",
    label: "Ticket trigger",
    description: "Starts a workflow from a ticket.",
    color: "#3C43E7",
    softColor: "#EEF0FF",
    glyph: "T",
  },
  defaults: {},
  ports: ["next"],
  allowsFailurePort: false,
  inputs: {},
  additionalInputs: [],
  output: {
    schema: { type: "unknown" },
    bindingSchema: { type: "unknown" },
    statusVariants: ["ok"],
  },
  availability: { available: true, unavailableReason: null },
};

const options = {
  defaultModel: "model",
  blockRegistry: { trigger_ticket_ai: triggerContract },
} as WorkflowEditorOptions;

const node: FlowNodeDef = {
  id: "entry",
  type: "trigger_ticket_ai",
  name: "Ticket received",
  x: 40,
  y: 40,
  params: {},
  inputs: {},
};

const validation: WorkflowValidationState = {
  status: "valid",
  issues: [],
  nodeContracts: { entry: triggerContract },
  availableValuesByNode: {},
};

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mountEditor() {
  const dom = installTestDom();
  const style = document.createElement("style");
  // Tailwind emits both declarations for the old Button-based overlay. The
  // later `relative` declaration wins just as it did in the production CSS.
  style.textContent = ".absolute{position:absolute}.relative{position:relative}";
  document.head.append(style);
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  act(() => {
    root = createRoot(container);
    root.render(
      <RepositoryCatalogProvider
        initial={{
          status: "ready",
          repositories: [],
          providers: [{ provider: "github", status: "ready" }],
        }}
      >
        <FlowEditor
          nodes={[node]}
          edges={[]}
          edgeGeometry={{}}
          limits={{}}
          repositoryScope={{}}
          onLimitsChange={() => undefined}
          onRepositoryScopeChange={() => undefined}
          onNodesChange={() => undefined}
          onNodePositionsChange={() => undefined}
          onEdgesChange={() => undefined}
          onEdgeGeometryChange={() => undefined}
          onGraphChange={() => undefined}
          canUndo={false}
          canRedo={false}
          onUndo={() => undefined}
          onRedo={() => undefined}
          onBeginTransaction={() => undefined}
          onCommitTransaction={() => undefined}
          onCancelTransaction={() => undefined}
          canEdit
          dirty={false}
          saveEnabled={false}
          saving={false}
          error={null}
          validation={validation}
          onSave={() => undefined}
          headerTitle="Ticket workflow"
          headerVersionBadge="draft"
          options={options}
        />
      </RepositoryCatalogProvider>,
    );
  });

  return {
    container,
    dom,
    cleanup() {
      act(() => root?.unmount());
      container.remove();
      style.remove();
      dom.restore();
    },
  };
}

test("workflow editor node selector covers the card and a center click opens the inspector", () => {
  const mounted = mountEditor();
  try {
    const card = mounted.container.querySelector<HTMLElement>('[data-canvas-node-id="entry"]');
    const selector = mounted.container.querySelector<HTMLButtonElement>('[data-canvas-node-selector="entry"]');
    assert.ok(card);
    assert.ok(selector);

    card.getBoundingClientRect = () => rect(40, 40, 224, 116);
    selector.getBoundingClientRect = () =>
      getComputedStyle(selector).position === "absolute"
        ? card.getBoundingClientRect()
        : rect(40, 40, 18, 2);

    const cardBox = card.getBoundingClientRect();
    const selectorBox = selector.getBoundingClientRect();
    assert.deepEqual(
      [selectorBox.left, selectorBox.top, selectorBox.right, selectorBox.bottom],
      [cardBox.left, cardBox.top, cardBox.right, cardBox.bottom],
    );

    act(() => {
      selector.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: cardBox.left + cardBox.width / 2,
        clientY: cardBox.top + cardBox.height / 2,
      }));
    });
    assert.ok(mounted.container.querySelector('[aria-label="Close inspector"]'));
  } finally {
    mounted.cleanup();
  }
});

test("workflow editor repository scope closes from focused Escape and the visible backdrop", () => {
  const mounted = mountEditor();
  try {
    const configure = Array.from(
      mounted.container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Configure"));
    assert.ok(configure);

    act(() => configure.click());
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const focused = dialog.querySelector<HTMLElement>("button:not([disabled])");
    assert.ok(focused);
    focused.focus();
    act(() => {
      focused.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dialog.dataset.state, "closed");

    act(() => configure.click());
    dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    const backdrop = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
      (element) => element.className.includes("absolute inset-0 bg-coal/40"),
    );
    assert.ok(backdrop, "expected the production modal backdrop");
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dialog.dataset.state, "closed");
  } finally {
    mounted.cleanup();
  }
});
