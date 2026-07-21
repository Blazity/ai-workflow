import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptInspectorCard } from "./prompt-inspector-card";

test("renders an interactive structural summary without raw prompt content", () => {
  const html = renderToStaticMarkup(
    <PromptInspectorCard
      label="Prompt"
      disabled={false}
      summary={{
        kind: "custom",
        title: "Custom prompt",
        detail: "64 chars · ~16 tokens · 3 sections · 1 live prompt",
        sectionTitles: ["research-plan", "New section", "Output Format"],
        remainingSectionCount: 0,
      }}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /Edit prompt/);
  assert.match(html, /cursor-pointer/);
  assert.match(html, /aria-hidden="true">→/);
  assert.match(html, /research-plan/);
  assert.match(html, /New section/);
  assert.match(html, /Output Format/);
  assert.doesNotMatch(html, /\{\{prompt:7\}\}|Return a JSON object/);
  assert.doesNotMatch(html, /<textarea|Library/);
});

test("renders the number of undisplayed sections", () => {
  const html = renderToStaticMarkup(
    <PromptInspectorCard
      label="Prompt"
      disabled={false}
      summary={{
        kind: "custom",
        title: "Custom prompt",
        detail: "80 chars · ~20 tokens · 5 sections",
        sectionTitles: ["One", "Two", "Three"],
        remainingSectionCount: 2,
      }}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /\+2 more/);
});

test("renders a read-only reference card as a dialog trigger", () => {
  const html = renderToStaticMarkup(
    <PromptInspectorCard
      label="Prompt"
      disabled
      summary={{ kind: "reference", title: "research-plan", detail: "Latest · v2" }}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /View prompt/);
  assert.match(html, /^<button/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /disabled/);
  assert.match(html, /research-plan/);
});
