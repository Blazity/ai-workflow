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
// Node test environment does not provide (same gap memory.test.tsx and
// overview.test.tsx work around); the run_scripts panel links to /scripts.
(globalThis as { self?: unknown }).self = globalThis;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function runScriptsNode(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return { id: "n1", type: "run_scripts", name: "Scripts", x: 0, y: 0, params, inputs: {} };
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
        // The mixed tenant: one grouped repo declaring "checks"/"lint" plus
        // one legacy repo, whose implied "checks" is covered separately below.
        { provider: "gitlab", repoPath: "acme/legacy", commands: ["make check"] },
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

test("the run_scripts Groups field offers configured group names and warns on one no repository declares", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return Response.json(RESPONSE);
  }) as typeof fetch;

  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ConfigFields
          node={runScriptsNode({ groups: ["nonexistent"] })}
          options={options}
          canEdit
          onChange={(path, value) => changes.push([path, value])}
        />,
      );
    });
    await settle();

    assert.equal(calls[0], "/api/pre-pr-checks");

    const html = nodeText(renderer.root);
    assert.match(html, /No repository declares "nonexistent"\. The block will report it as not_run\./);
    assert.match(html, /\+ checks/);
    assert.match(html, /\+ lint/);
    // Deliberate, previously undocumented behavior: this is not a
    // per-changed-repository filter.
    assert.match(
      html,
      /The block runs the selected groups on every repository in the run workspace, whether or not that repository changed\./,
    );

    const addChecks = renderer.root
      .findAll((instance) => instance.type === "button")
      .find((instance) => nodeText(instance).trim() === "+ checks");
    assert.ok(addChecks, "expected a one-click add button for the configured group checks");
    await act(async () => addChecks!.props.onClick());

    assert.deepEqual(changes.at(-1), ["params.groups", ["nonexistent", "checks"]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('an all-legacy tenant does not falsely flag the implied "checks" group as unknown', async () => {
  // Every repository here is flat commands, no explicit groups key at all.
  // The engine normalizes each one into a single "checks" group at run
  // time, but the stored config never spells that out; without unioning
  // the implied name in, a freshly dropped run_scripts block (default
  // groups: ["checks"]) saw a false amber warning even though it runs fine.
  const allLegacyResponse: PrePrChecksResponse = {
    current: {
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdById: "u1",
      createdByLabel: "Filip",
      restoredFromVersion: null,
      config: {
        repositories: [
          { provider: "github", repoPath: "acme/web", commands: ["pnpm test"] },
          { provider: "gitlab", repoPath: "acme/legacy", commands: ["make check"] },
        ],
      },
    },
    versions: [],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(allLegacyResponse)) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ConfigFields
          node={runScriptsNode({ groups: ["checks"] })}
          options={options}
          canEdit
          onChange={() => undefined}
        />,
      );
    });
    await settle();

    const html = nodeText(renderer.root);
    assert.doesNotMatch(html, /No repository declares/);
    // "checks" is already selected, so it must not also be offered as a
    // one-click suggestion.
    assert.doesNotMatch(html, /\+ checks/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("free text stays usable while the group catalog is loading or fails to load", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ConfigFields
          node={runScriptsNode({ groups: ["checks"] })}
          options={options}
          canEdit
          onChange={(path, value) => changes.push([path, value])}
        />,
      );
    });
    await settle();

    // No suggestions and no unknown-group warning: a failed fetch degrades to
    // "no assist", never to an error banner or a blocked editor.
    const html = nodeText(renderer.root);
    assert.doesNotMatch(html, /No repository declares/);

    const textarea = renderer.root.findAll((instance) => instance.type === "textarea")[0];
    await act(async () => textarea.props.onChange({ target: { value: "checks\nnew-group" } }));
    assert.deepEqual(changes.at(-1), ["params.groups", ["checks", "new-group"]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});
