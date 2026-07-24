import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDataCatalogEntry } from "@shared/contracts";
import {
  defaultTransformConfiguration,
  TransformFields,
} from "./transform-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const values: WorkflowDataCatalogEntry[] = [{
  reference: "steps.entry.output.text",
  label: "Trigger · text",
  description: "Text",
  schema: { type: "string" },
  source: { kind: "trigger", nodeId: "entry" },
  presence: "required",
  availability: { state: "available", guarantee: "Guaranteed." },
  compatibleInputNames: [],
}];

test("creates all seven canonical operations", () => {
  assert.deepEqual(defaultTransformConfiguration("format_text"), {
    operation: "format_text",
    template: "",
  });
  assert.equal(defaultTransformConfiguration("build_object").operation, "build_object");
  assert.equal(defaultTransformConfiguration("parse_json").operation, "parse_json");
});

test("renders the approved action list and output shape", () => {
  const html = renderToStaticMarkup(
    <TransformFields
      configuration={{
        operation: "replace_text",
        source: "steps.entry.output.text",
        mode: "plain",
        pattern: "a",
        replacement: "b",
        ignoreCase: false,
      }}
      availableValues={values}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /Format text/);
  assert.match(html, /Parse JSON/);
  assert.match(html, /Build object/);
  assert.match(html, /Output shape/);
  assert.match(html, /Ignore capitalization/);
});
