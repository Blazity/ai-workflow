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
  assert.match(html, /py-1 px-2/);
  assert.match(html, /aria-pressed="true"/);
});
