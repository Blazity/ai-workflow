import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Textarea } from "./textarea";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Textarea renders both sizes and the monospace option", () => {
  const compact = renderToStaticMarkup(<Textarea size="sm" />);
  const standard = renderToStaticMarkup(<Textarea size="md" monospace />);
  assert.match(compact, /min-h-\[72px\]/);
  assert.match(standard, /min-h-\[88px\]/);
  assert.match(standard, /font-mono/);
});

test("Textarea exposes invalid state", () => {
  const html = renderToStaticMarkup(<Textarea invalid />);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /border-fail/);
});
