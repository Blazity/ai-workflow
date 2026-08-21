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

function runChecksNode(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return { id: "n1", type: "run_checks", name: "Checks", x: 0, y: 0, params, inputs: {} };
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
          groups: { checks: { commands: ["pnpm test"] }, lint: { commands: ["pnpm lint"] } },
        },
      ],
    },
  },
  versions: [],
};

function nodeText(instance: ReactTestInstance): string {
  return instance.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

test("run_checks gains a Groups field mirroring run_scripts, with a mutual-exclusivity note", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(RESPONSE)) as typeof fetch;

  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ConfigFields
          node={runChecksNode({ commands: ["pnpm test"] })}
          options={options}
          canEdit
          onChange={(path, value) => changes.push([path, value])}
        />,
      );
    });
    await settle();

    const html = nodeText(renderer.root);
    assert.match(html, /Groups/);
    assert.match(
      html,
      /Groups and explicit commands are mutually exclusive server-side: set one or the other, not both\./,
    );
    // The picker offers the tenant's configured groups, same as run_scripts.
    assert.match(html, /\+ checks/);
    assert.match(html, /\+ lint/);

    const addChecks = renderer.root
      .findAll((instance) => instance.type === "button")
      .find((instance) => nodeText(instance).trim() === "+ checks");
    assert.ok(addChecks, "expected a one-click add button for the configured group checks");
    await act(async () => addChecks!.props.onClick());

    assert.deepEqual(changes.at(-1), ["params.groups", ["checks"]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("filling both Commands and Groups surfaces an inline error; filling only one does not", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(RESPONSE)) as typeof fetch;

  async function renderWith(params: FlowNodeDef["params"]): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ConfigFields
          node={runChecksNode(params)}
          options={options}
          canEdit
          onChange={() => undefined}
        />,
      );
    });
    await settle();
    return renderer;
  }

  const ERROR_TEXT = /Commands and Groups are both set\. They are mutually exclusive: clear one\s+before saving\./;

  try {
    const both = await renderWith({ commands: ["pnpm test"], groups: ["checks"] });
    try {
      // An author who fills both used to keep an enabled Save and only learn
      // at publish time from the server's superRefine; the client mirrors
      // that rule the same way other node validation already does.
      assert.match(nodeText(both.root), ERROR_TEXT);
    } finally {
      await act(async () => both.unmount());
    }

    const commandsOnly = await renderWith({ commands: ["pnpm test"] });
    try {
      assert.doesNotMatch(nodeText(commandsOnly.root), ERROR_TEXT);
    } finally {
      await act(async () => commandsOnly.unmount());
    }

    const groupsOnly = await renderWith({ groups: ["checks"] });
    try {
      assert.doesNotMatch(nodeText(groupsOnly.root), ERROR_TEXT);
    } finally {
      await act(async () => groupsOnly.unmount());
    }

    const neither = await renderWith({});
    try {
      assert.doesNotMatch(nodeText(neither.root), ERROR_TEXT);
    } finally {
      await act(async () => neither.unmount());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
