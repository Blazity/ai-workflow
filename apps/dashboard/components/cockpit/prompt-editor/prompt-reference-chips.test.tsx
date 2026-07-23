import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { PromptReferenceChipsView } from "./prompt-reference-chips";

const row: PromptLibraryListRowDto = {
  id: 7,
  slug: "research-plan",
  name: "research-plan",
  description: null,
  tags: [],
  currentVersion: 3,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  createdByLabel: "System",
  body: "# Research",
  slots: [],
};

test("resolved read-only references render a responsive expandable card", () => {
  const html = renderToStaticMarkup(
    <PromptReferenceChipsView
      value="{{prompt:7}}"
      rows={[row]}
      onChange={() => {}}
      disabled
    />,
  );

  assert.match(html, /Live reference/);
  assert.match(html, />Show content</);
  assert.match(html, /w-full/);
  assert.match(html, /flex-wrap/);
  assert.match(html, /href="\/prompts\?prompt=research-plan"/);
  assert.doesNotMatch(html, /More actions|Detach|Pin v3/);
  assert.doesNotMatch(html, />Preview</);
});

test("editable references expose detach as a primary action", () => {
  const html = renderToStaticMarkup(
    <PromptReferenceChipsView
      value="{{prompt:7}}"
      rows={[row]}
      onChange={() => {}}
    />,
  );

  assert.match(html, />Show content</);
  assert.match(html, /href="\/prompts\?prompt=research-plan"/);
  assert.match(html, />Detach and edit</);
  assert.match(html, /More actions/);
});

test("missing references expose no navigation", () => {
  const html = renderToStaticMarkup(
    <PromptReferenceChipsView
      value="{{prompt:99}}"
      rows={[row]}
      onChange={() => {}}
    />,
  );

  assert.match(html, /Missing prompt #99/);
  assert.doesNotMatch(html, /Show content|Open in library|href="\/prompts|More actions/);
});
