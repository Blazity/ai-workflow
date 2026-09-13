import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./input";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Input renders canonical sizes and typography", () => {
  const compact = renderToStaticMarkup(<Input size="sm" monospace />);
  const standard = renderToStaticMarkup(<Input size="md" />);
  assert.match(compact, /h-\[26px\]/);
  assert.match(compact, /font-mono/);
  assert.match(standard, /h-\[30px\]/);
  assert.match(standard, /font-body/);
});

test("Input wires invalid and disabled states", () => {
  const html = renderToStaticMarkup(<Input invalid disabled />);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /focus-visible:ring-2/);
});
