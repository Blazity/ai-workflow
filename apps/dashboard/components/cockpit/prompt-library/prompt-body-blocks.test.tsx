import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { PromptBodyBlocksView } from "./prompt-body-blocks";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

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

test("renders headings as section cards and reference tokens as live-reference cards", () => {
  const html = renderToStaticMarkup(
    <PromptBodyBlocksView
      body={"# Intro\nsome text\n\n{{prompt:research-plan}}\n\n## Steps\n1. go"}
      rows={[row]}
    />,
  );

  assert.match(html, /H1 · Intro/);
  assert.match(html, /H2 · Steps/);
  assert.match(html, /Live reference/);
  assert.match(html, /research-plan/);
  // Read-only: no mutation affordances.
  assert.doesNotMatch(html, /Detach|More actions/);
});

test("a plain body without headings or references stays a flat preview", () => {
  const html = renderToStaticMarkup(
    <PromptBodyBlocksView body={"just a paragraph of text"} rows={[row]} />,
  );

  assert.match(html, /just a paragraph of text/);
  assert.doesNotMatch(html, /Introduction ·/);
});
