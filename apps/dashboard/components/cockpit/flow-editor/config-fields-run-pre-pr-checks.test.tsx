import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { PrePrChecksResponse, WorkflowEditorOptions } from "@shared/contracts";
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

const RESPONSE: PrePrChecksResponse = {
  current: {
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdById: "u1",
    createdByLabel: "Filip",
    restoredFromVersion: null,
    config: {
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          groups: {
            deps: { commands: ["pnpm install"] },
            lint: { commands: ["pnpm lint"] },
            unit: { commands: ["pnpm test"] },
          },
          gateGroups: ["deps", "lint", "unit"],
        },
        {
          provider: "github",
          repoPath: "acme/api",
          groups: {
            a: { commands: ["a"] },
            b: { commands: ["b"] },
            c: { commands: ["c"] },
            d: { commands: ["d"] },
            e: { commands: ["e"] },
          },
        },
      ],
    },
  },
  versions: [],
};

async function renderPanelWithConfig(n: FlowNodeDef): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ConfigFields node={n} options={options} canEdit onChange={() => undefined} />,
    );
  });
  await act(async () => {});
  await act(async () => {});
  return renderer;
}

test("the gate panel names what it will require, per repository, instead of pointing elsewhere", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(RESPONSE)) as typeof fetch;

  const renderer = await renderPanelWithConfig(node({}));
  try {
    const html = nodeText(renderer.root);
    assert.match(html, /Gate selection/);
    assert.match(html, /acme\/web · gate groups: deps, lint, unit/);
    // No gate groups means every declared group, and the count is the number an
    // operator can check against the scripts screen.
    assert.match(html, /acme\/api · every group runs at the gate \(5 groups\)/);
    assert.match(
      html,
      /This block runs the required groups on repositories the run changed\./,
    );
    // The block runs script groups, not free-standing commands, and calling
    // them commands is what sent authors looking for a field that never
    // existed here.
    assert.doesNotMatch(html, /Commands/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the gate panel opens Repository scripts in a new tab", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(RESPONSE)) as typeof fetch;

  const renderer = await renderPanelWithConfig(node({}));
  try {
    const link = renderer.root.findAll((i) => i.props.href === "/scripts")[0];
    assert.ok(link, "expected a link to Repository scripts");
    // A client-side navigation out of the editor discards the unsaved canvas.
    assert.equal(link!.props.target, "_blank");
    assert.equal(link!.props.rel, "noreferrer");
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a positive legacy maxFixCycles gets an inert-parameter note instead of silently doing nothing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(RESPONSE)) as typeof fetch;

  const renderer = await renderPanelWithConfig(node({ maxFixCycles: 3 }));
  try {
    assert.match(
      nodeText(renderer.root),
      /Fix cycles no longer apply: the repair loop was removed\. The value is kept only for compatibility\./,
    );
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a node with no maxFixCycles or a value of 0 gets no inert-parameter note", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(RESPONSE)) as typeof fetch;

  try {
    const withoutParam = await renderPanelWithConfig(node({}));
    try {
      assert.doesNotMatch(nodeText(withoutParam.root), /Fix cycles no longer apply/);
    } finally {
      await act(async () => withoutParam.unmount());
    }

    const zero = await renderPanelWithConfig(node({ maxFixCycles: 0 }));
    try {
      assert.doesNotMatch(nodeText(zero.root), /Fix cycles no longer apply/);
    } finally {
      await act(async () => zero.unmount());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
