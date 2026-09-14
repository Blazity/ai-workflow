import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "./skeleton";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Skeleton is hidden from assistive technology", () => {
  const html = renderToStaticMarkup(<Skeleton />);
  assert.match(html, /aria-hidden="true"/);
});
