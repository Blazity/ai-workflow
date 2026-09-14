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

const promptContract: WorkflowBlockContract = {
  type: "call_llm",
  presentation: {
    group: "utility",
    label: "Call LLM",
    description: "Runs a focused LLM transform.",
    color: "#64748B",
    softColor: "#EEF1F5",
    glyph: "L",
  },
  defaults: { prompt: "" },
  ports: ["out"],
  allowsFailurePort: true,
  inputs: {
    prompt: { required: false, schema: { type: "string" } },
    system: { required: false, schema: { type: "string" } },
  },
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

const promptNode: FlowNodeDef = {
  id: "prompt",
  type: "call_llm",
  name: "Summarize ticket",
  x: 40,
  y: 40,
  params: { prompt: "Summarize this ticket." },
  inputs: {},
};

const promptOptions = {
  defaultModel: "model",
  blockRegistry: { call_llm: promptContract },
} as WorkflowEditorOptions;

const promptValidation: WorkflowValidationState = {
  status: "valid",
  issues: [],
  nodeContracts: { prompt: promptContract },
  availableValuesByNode: {},
};

function mountEditor({
  editorNode = node,
  editorOptions = options,
  editorValidation = validation,
}: {
  editorNode?: FlowNodeDef;
  editorOptions?: WorkflowEditorOptions;
  editorValidation?: WorkflowValidationState;
} = {}) {
  const dom = installTestDom();
  const container = document.createElement("div");
  const cockpitMain = document.createElement("main");
  cockpitMain.dataset.cockpitMain = "";
  cockpitMain.append(container);
  document.body.append(cockpitMain);
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
          nodes={[editorNode]}
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
          validation={editorValidation}
          onSave={() => undefined}
          headerTitle="Ticket workflow"
          headerVersionBadge="draft"
          options={editorOptions}
        />
      </RepositoryCatalogProvider>,
    );
  });

  return {
    container,
    cockpitMain,
    dom,
    unmount() {
      act(() => root?.unmount());
      root = undefined;
    },
    cleanup() {
      act(() => root?.unmount());
      cockpitMain.remove();
      dom.restore();
    },
  };
}

test("workflow editor node selector opens the inspector", () => {
  const mounted = mountEditor();
  try {
    const card = mounted.container.querySelector<HTMLElement>('[data-canvas-node-id="entry"]');
    const selector = mounted.container.querySelector<HTMLButtonElement>('[data-canvas-node-selector="entry"]');
    assert.ok(card);
    assert.ok(selector);

    act(() => {
      selector.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
      }));
    });
    assert.ok(mounted.container.querySelector('[aria-label="Close inspector"]'));
  } finally {
    mounted.cleanup();
  }
});

test("workflow editor node selector opens the inspector with Enter and Space", () => {
  const mounted = mountEditor();
  try {
    const selector = mounted.container.querySelector<HTMLButtonElement>(
      '[data-canvas-node-selector="entry"]',
    );
    assert.ok(selector);

    for (const key of ["Enter", " "]) {
      act(() => selector.focus());
      assert.equal(document.activeElement, selector);
      act(() => {
        selector.dispatchEvent(new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }));
      });
      const close = mounted.container.querySelector<HTMLButtonElement>(
        '[aria-label="Close inspector"]',
      );
      assert.ok(close, `expected ${key === " " ? "Space" : key} to open the inspector`);
      act(() => close.click());
      assert.equal(
        mounted.container.querySelector('[aria-label="Close inspector"]'),
        null,
      );
    }
  } finally {
    mounted.cleanup();
  }
});

test("workflow editor nested dialogs retain page locks when closed in both orders", () => {
  const mounted = mountEditor({
    editorNode: promptNode,
    editorOptions: promptOptions,
    editorValidation: promptValidation,
  });
  document.body.style.overflow = "clip";

  const openNestedDialogs = () => {
    const selector = mounted.container.querySelector<HTMLButtonElement>(
      '[data-canvas-node-selector="prompt"]',
    );
    assert.ok(selector);
    act(() => selector.click());
    const editPrompt = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit Prompt"]',
    );
    assert.ok(editPrompt);
    act(() => editPrompt.click());
    const editorDialog = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'),
    ).find((dialog) => dialog.getAttribute("aria-label") === "Edit Prompt");
    assert.ok(editorDialog);
    const save = Array.from(editorDialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "↥ Save",
    );
    assert.ok(save);
    act(() => save.click());
    assert.equal(
      document.querySelectorAll('[role="dialog"][data-state="open"]').length,
      2,
    );
    return editorDialog;
  };

  const closeSaveDialog = () => {
    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'),
    );
    const saveDialog = dialogs.find((dialog) =>
      dialog.textContent?.includes("Save to library"),
    );
    assert.ok(saveDialog);
    const cancel = Array.from(saveDialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Cancel",
    );
    assert.ok(cancel);
    act(() => cancel.click());
  };

  const closeEditorDialog = (dialog: HTMLElement) => {
    const close = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Close",
    );
    assert.ok(close);
    act(() => close.click());
  };

  try {
    let editorDialog = openNestedDialogs();
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), true);
    assert.equal(document.body.style.overflow, "hidden");
    closeSaveDialog();
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), true);
    assert.equal(document.body.style.overflow, "hidden");
    closeEditorDialog(editorDialog);
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), false);
    assert.equal(document.body.style.overflow, "clip");

    editorDialog = openNestedDialogs();
    closeEditorDialog(editorDialog);
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), true);
    assert.equal(document.body.style.overflow, "hidden");
    closeSaveDialog();
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), false);
    assert.equal(document.body.style.overflow, "clip");
  } finally {
    mounted.cleanup();
  }
});

test("workflow editor unmount while dialogs are open clears inert and body overflow", () => {
  const mounted = mountEditor({
    editorNode: promptNode,
    editorOptions: promptOptions,
    editorValidation: promptValidation,
  });
  document.body.style.overflow = "scroll";

  try {
    const selector = mounted.container.querySelector<HTMLButtonElement>(
      '[data-canvas-node-selector="prompt"]',
    );
    assert.ok(selector);
    act(() => selector.click());
    const editPrompt = mounted.container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit Prompt"]',
    );
    assert.ok(editPrompt);
    act(() => editPrompt.click());
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), true);
    assert.equal(document.body.style.overflow, "hidden");

    mounted.unmount();
    assert.equal(mounted.cockpitMain.hasAttribute("inert"), false);
    assert.equal(document.body.style.overflow, "scroll");
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
    const backdrop = document.querySelector<HTMLElement>("[data-modal-overlay]");
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
