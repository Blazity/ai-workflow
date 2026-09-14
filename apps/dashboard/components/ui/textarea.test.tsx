import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Textarea } from "./textarea";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Textarea exposes invalid state", () => {
  const html = renderToStaticMarkup(<Textarea invalid />);
  assert.match(html, /aria-invalid="true"/);
});
