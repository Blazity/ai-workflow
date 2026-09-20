import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { WorkflowDefinitionV2 } from "@shared/contracts";

import { PagedCacheProvider } from "../agent-visibility/paged";
import {
  EffectivePromptPreview,
  EffectivePromptPreviewResultView,
  type EffectivePromptPreviewResponse,
} from "./effective-prompt-preview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

const result: EffectivePromptPreviewResponse = {
  blockId: "implementation",
  prompt: "PROFILE\n\nBLOCK\n\nRUNTIME",
  hash: "compiled-hash",
  sections: [
    {
      kind: "profile",
      title: "Harness Profile: Codex",
      content: "PROFILE",
      hash: "profile-hash",
      provenance: [
        {
          kind: "profile",
          id: "system-codex",
          version: 1,
          hash: "profile-manifest-hash",
        },
      ],
    },
    {
      kind: "block",
      title: "Block role and task",
      content: "BLOCK",
      hash: "block-hash",
      provenance: [
        {
          kind: "prompt",
          id: "4:implementation",
          version: 3,
          hash: "prompt-body-hash",
        },
      ],
    },
    {
      kind: "runtime",
      title: "Runtime data",
      content: "RUNTIME",
      hash: "runtime-hash",
      provenance: [],
    },
  ],
  provenance: [],
  unresolvedSources: [
    {
      kind: "repository",
      reference: "owner/repository/AGENTS.md",
      message: "Available after workspace preparation.",
    },
  ],
  issues: [
    {
      code: "prompt_slot_missing",
      severity: "error",
      nodeId: "implementation",
      path: "/configuration/promptSlotBindings/plan",
      message: 'Prompt slot "plan" needs a value.',
    },
  ],
};

test("effective prompt preview preserves section order and shows provenance", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView result={result} />,
  );

  const profile = html.indexOf("Harness Profile: Codex");
  const block = html.indexOf("Block role and task");
  const runtime = html.indexOf("Runtime data");
  assert.ok(profile >= 0 && profile < block && block < runtime);
  assert.match(html, /system-codex/);
  assert.match(html, /profile-manifest-hash/);
  assert.match(html, /prompt-body-hash/);
  assert.match(html, /Compiled prompt · compiled-hash/);
});

test("effective prompt preview exposes runtime-only sources and structured errors", () => {
  const html = renderToStaticMarkup(
    <EffectivePromptPreviewResultView result={result} />,
  );

  assert.match(html, /Resolved at runtime/);
  assert.match(html, /owner\/repository\/AGENTS.md/);
  assert.match(html, /Preview errors/);
  assert.match(html, /promptSlotBindings\/plan/);
  assert.match(html, /needs a value/);
});

/* ── The panel: two views a person can tell apart ──────────────────────── */

const definition = { schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinitionV2;

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((entry): entry is string => typeof entry === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

function click(root: ReactTestInstance, label: string) {
  const found = root
    .findAll((node) => node.type === "button")
    .filter((node) => text(node).includes(label));
  assert.equal(found.length, 1, `expected one button containing "${label}", found ${found.length}`);
  act(() => found[0]!.props.onClick());
}

function mount(t: TestContext): { root: ReactTestInstance; requests: string[] } {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string) => {
    const path = String(input);
    requests.push(path);
    if (path.includes("prompt-preview")) return Promise.resolve(Response.json(result));
    return Promise.resolve(
      Response.json({
        schemaVersion: 1,
        definitionId: 4,
        nodeId: "implementation",
        blockType: "implementation_agent",
        sendsPrompts: true,
        ranIn: null,
        attempt: null,
        absent: { kind: "never_ran" },
      }),
    );
  }) as typeof globalThis.fetch;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <PagedCacheProvider>
        <EffectivePromptPreview definitionId={4} definition={definition} blockId="implementation" />
      </PagedCacheProvider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return { root: renderer.root, requests };
}

async function settle(times = 6) {
  for (let turn = 0; turn < times; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

test("opening the panel compiles the edit in hand and asks nothing about past runs", async (t) => {
  const { root, requests } = mount(t);
  click(root, "Preview");
  await settle();
  assert.equal(requests.filter((path) => path.includes("prompt-preview")).length, 1);
  // A read of a past run costs nothing while nobody is looking at it.
  assert.equal(requests.filter((path) => path.includes("last-briefing")).length, 0);
  assert.match(text(root), /Block role and task/);
});

test("what it sent last time and what it would send now are two named, separate views", async (t) => {
  const { root, requests } = mount(t);
  click(root, "Preview");
  await settle();
  click(root, "Sent last time");
  await settle();
  assert.equal(requests.filter((path) => path.includes("last-briefing")).length, 1);
  const shown = text(root);
  // The past view is the past view: no compiled projection bleeds into it.
  assert.match(shown, /has not run yet/);
  assert.doesNotMatch(shown, /A preview is not a send/);
  assert.doesNotMatch(shown, /Compiled prompt/);

  // Nothing in the past view offers to rebuild a preview: pressing it would
  // throw a person out of what they were reading.
  assert.equal(
    root.findAll((node) => node.type === "button").filter((node) => text(node).includes("Refresh")).length,
    0,
  );

  click(root, "Would send now");
  await settle();
  // And back, without compiling again: the edit has not changed.
  assert.equal(requests.filter((path) => path.includes("prompt-preview")).length, 1);
  assert.match(text(root), /Compiled prompt/);
});

test("the preview says what it cannot know before an operator trusts it", () => {
  const html = renderToStaticMarkup(<EffectivePromptPreviewResultView result={result} />);
  assert.match(html, /A preview is not a send/);
  assert.match(html, /examples built from each binding/);
  // The two sources a preview never holds are named, not silently absent.
  assert.match(html, /Repository instructions and repo memory/);
});
