import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDefinitionV2 } from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { PromptField } from "./prompt-field";
import { PromptAuthoringProvider } from "./prompt-authoring-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("compact prompt field does not duplicate live reference cards", () => {
  const node: FlowNodeDef = {
    id: "research",
    type: "call_llm",
    name: "Research",
    x: 0,
    y: 0,
    params: { prompt: "{{prompt:7}}" },
    inputs: {},
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

test("Call LLM prompt fields do not expose harness prompt preview or slots", () => {
  const node: FlowNodeDef = {
    id: "llm",
    type: "call_llm",
    name: "Summarize",
    x: 0,
    y: 0,
    params: { prompt: "{{slot:plan}}" },
    inputs: {},
    v2: {
      configuration: {
        prompt: "{{slot:plan}}",
        promptSlotBindings: {
          plan: { kind: "literal", value: "saved" },
        },
      },
      inputs: {},
      additionalInputs: [],
    },
  };
  const definition: WorkflowDefinitionV2 = {
    schemaVersion: 2,
    nodes: [],
    edges: [],
  };
  const html = renderToStaticMarkup(
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={{ definitionId: 1, definition, blockId: "llm" }}
    >
      <PromptField
        label="Prompt"
        paramKey="prompt"
        node={node}
        disabled={false}
        agentPromptAuthoring={false}
        onChange={() => undefined}
      />
    </PromptAuthoringProvider>,
  );

  assert.doesNotMatch(html, /Prompt slot values/);
  assert.doesNotMatch(html, /Preview effective prompt/);
  assert.match(html, /aria-label="Edit Prompt"/);
});
