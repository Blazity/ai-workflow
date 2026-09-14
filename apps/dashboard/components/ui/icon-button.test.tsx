import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "./icon-button";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("IconButton supplies its required accessible label", () => {
  const html = renderToStaticMarkup(<IconButton aria-label="Cancel run">x</IconButton>);
  assert.match(html, /aria-label="Cancel run"/);
});

test("IconButton exposes disabled and loading state", () => {
  const disabled = renderToStaticMarkup(<IconButton aria-label="Unavailable" disabled>x</IconButton>);
  const loading = renderToStaticMarkup(<IconButton aria-label="Loading" loading>x</IconButton>);
  assert.match(disabled, /disabled=""/);
  assert.match(loading, /aria-busy="true"/);
});
