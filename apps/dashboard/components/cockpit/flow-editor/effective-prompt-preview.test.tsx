import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EffectivePromptPreviewResultView,
  type EffectivePromptPreviewResponse,
} from "./effective-prompt-preview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

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
