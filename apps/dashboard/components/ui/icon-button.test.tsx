import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "./icon-button";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("IconButton supplies its required accessible label and square size", () => {
  const html = renderToStaticMarkup(<IconButton aria-label="Cancel run" size="md">x</IconButton>);
  assert.match(html, /aria-label="Cancel run"/);
  assert.match(html, /size-\[30px\]/);
  assert.match(html, /focus-visible:ring-2/);
});

test("IconButton exposes disabled and loading state", () => {
  const disabled = renderToStaticMarkup(<IconButton aria-label="Unavailable" disabled>x</IconButton>);
  const loading = renderToStaticMarkup(<IconButton aria-label="Loading" loading>x</IconButton>);
  assert.match(disabled, /disabled=""/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /animate-ck-spinner/);
});

test("IconButton exposes the circular shape for round icon actions", () => {
  const html = renderToStaticMarkup(
    <IconButton aria-label="Run trigger" shape="circle">x</IconButton>,
  );
  assert.match(html, /data-shape="circle"/);
  assert.match(html, /rounded-full/);
});
