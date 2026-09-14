import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Button exposes loading state and disables actions", () => {
  const html = renderToStaticMarkup(<Button loading>Deploy workflow</Button>);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Deploy workflow/);
});

test("Button renders an anchor when href is supplied", () => {
  const html = renderToStaticMarkup(<Button href="/runs">View runs</Button>);
  assert.match(html, /^<a /);
  assert.match(html, /href="\/runs"/);
});
