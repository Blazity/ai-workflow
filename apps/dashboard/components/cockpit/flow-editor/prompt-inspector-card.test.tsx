import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptInspectorCard } from "./prompt-inspector-card";

test("renders editable custom summary without an inline textarea or Library action", () => {
  const html = renderToStaticMarkup(
    <PromptInspectorCard
      label="Prompt"
      disabled={false}
      summary={{ kind: "custom", title: "Custom prompt", detail: "12 chars · ~3 tokens", preview: "Do the work" }}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /Edit prompt/);
  assert.match(html, /Do the work/);
  assert.doesNotMatch(html, /<textarea|Library/);
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
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /research-plan/);
});
