import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { WorkflowEditorOptions } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { ConfigFields } from "./config-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link's prefetch idle callback reaches for `self`, which the plain
// Node test environment does not provide; the panel links to /scripts.
(globalThis as { self?: unknown }).self = globalThis;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function node(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return { id: "n1", type: "run_pre_pr_checks", name: "Checks", x: 0, y: 0, params, inputs: {} };
}

function nodeText(instance: ReactTestInstance): string {
  return instance.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function renderPanel(n: FlowNodeDef): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ConfigFields node={n} options={options} canEdit onChange={() => undefined} />,
    );
  });
  return renderer;
}

test("a positive legacy maxFixCycles gets an inert-parameter note instead of silently doing nothing", () => {
  const renderer = renderPanel(node({ maxFixCycles: 3 }));
  try {
    assert.match(
      nodeText(renderer.root),
      /Fix cycles no longer apply: the repair loop was removed\. The value is kept only for compatibility\./,
    );
  } finally {
    act(() => renderer.unmount());
  }
});

test("a node with no maxFixCycles or a value of 0 gets no inert-parameter note", () => {
  const withoutParam = renderPanel(node({}));
  try {
    assert.doesNotMatch(nodeText(withoutParam.root), /Fix cycles no longer apply/);
  } finally {
    act(() => withoutParam.unmount());
  }

  const zero = renderPanel(node({ maxFixCycles: 0 }));
  try {
    assert.doesNotMatch(nodeText(zero.root), /Fix cycles no longer apply/);
  } finally {
    act(() => zero.unmount());
  }
});
