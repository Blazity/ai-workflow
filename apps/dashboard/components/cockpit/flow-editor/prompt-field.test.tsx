import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowNodeDef } from "@/lib/flows";
import { PromptField } from "./prompt-field";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("compact prompt field does not duplicate live reference cards", () => {
  const node: FlowNodeDef = {
    id: "research",
    type: "call_llm",
    name: "Research",
    x: 0,
    y: 0,
    params: { prompt: "{{prompt:7}}" },
  };
  const html = renderToStaticMarkup(
    <PromptField
      label="Prompt"
      paramKey="prompt"
      node={node}
      disabled={false}
      onChange={() => {}}
    />,
  );

  assert.match(html, /aria-label="Edit Prompt"/);
  assert.doesNotMatch(html, /aria-label="Prompt references"/);
});
