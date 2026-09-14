import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Radio } from "./radio";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Radio renders a labelled native radio control", () => {
  const html = renderToStaticMarkup(
    <Radio name="mode" checked readOnly label="Named groups" />,
  );
  assert.match(html, /type="radio"/);
  assert.match(html, /name="mode"/);
  assert.match(html, /Named groups/);
  assert.match(html, /class="flex items-center/);
  assert.doesNotMatch(html, /class="inline-flex items-center/);
});
