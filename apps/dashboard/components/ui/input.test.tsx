import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./input";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Input wires invalid and disabled states", () => {
  const html = renderToStaticMarkup(<Input invalid disabled />);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /disabled=""/);
});
