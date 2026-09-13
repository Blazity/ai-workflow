import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton, type SkeletonVariant } from "./skeleton";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Skeleton renders each shape with the shimmer token", () => {
  for (const variant of ["line", "block", "circle"] as SkeletonVariant[]) {
    const html = renderToStaticMarkup(<Skeleton variant={variant} />);
    assert.match(html, new RegExp(`data-variant="${variant}"`));
    assert.match(html, /animate-ck-shimmer/);
    assert.match(html, /aria-hidden="true"/);
  }
});
