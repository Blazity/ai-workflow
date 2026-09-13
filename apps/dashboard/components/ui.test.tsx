import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CkTabs } from "./ui";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("CkTabs exposes its compact size and selected state", () => {
  const html = renderToStaticMarkup(
    <CkTabs active="day" onChange={() => undefined} size="sm" tabs={[{ id: "day", label: "Day" }]} />,
  );
  assert.match(html, /data-size="sm"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-variant="selected"/);
  assert.match(html, /bg-mariner-100/);
  assert.match(html, /text-mariner/);
  assert.match(html, /focus-visible:ring-2/);
});
