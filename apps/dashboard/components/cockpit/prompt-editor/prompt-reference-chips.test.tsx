import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { PromptReferenceChipsView } from "./prompt-reference-chips";

const row: PromptLibraryListRowDto = {
  id: 7,
  name: "research-plan",
  description: null,
  tags: [],
  currentVersion: 3,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  createdByLabel: "System",
  body: "# Research",
};

test("resolved read-only references keep Preview and the library link", () => {
  const html = renderToStaticMarkup(
    <PromptReferenceChipsView
      value="{{prompt:7}}"
      rows={[row]}
      onChange={() => {}}
      onPreview={() => {}}
      disabled
    />,
  );

  assert.match(html, />Preview</);
  assert.match(html, /href="\/prompts\?prompt=7"/);
  assert.doesNotMatch(html, /More actions|Detach|Pin v3/);
});

test("missing references expose no navigation", () => {
  const html = renderToStaticMarkup(
    <PromptReferenceChipsView
      value="{{prompt:99}}"
      rows={[row]}
      onChange={() => {}}
      onPreview={() => {}}
    />,
  );

  assert.match(html, /Missing prompt 99/);
  assert.doesNotMatch(html, /Preview|href="\/prompts/);
});
