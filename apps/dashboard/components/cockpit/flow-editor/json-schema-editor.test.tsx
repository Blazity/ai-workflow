import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonSchemaEditor } from "./json-schema-editor";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("schema editor exposes visual/raw modes and the canonical dialect", () => {
  const html = renderToStaticMarkup(
    <JsonSchemaEditor
      label="Agent output schema"
      value={'{"type":"string"}'}
      disabled={false}
      onChange={() => {}}
    />,
  );
  assert.match(html, /Visual/i);
  assert.match(html, /Raw/i);
  assert.match(html, /JSON Schema 2020-12/);
  assert.match(html, /Checking schema/);
});

test("disabled schema editor keeps authoring controls non-editable", () => {
  const html = renderToStaticMarkup(
    <JsonSchemaEditor
      label="Agent output schema"
      value=""
      disabled
      onChange={() => {}}
    />,
  );
  assert.match(html, /aria-pressed="true"/);
});
