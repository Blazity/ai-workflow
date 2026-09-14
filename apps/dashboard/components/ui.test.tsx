import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CkTabs } from "./ui";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("CkTabs exposes its selected state", () => {
  const html = renderToStaticMarkup(
    <CkTabs active="day" onChange={() => undefined} tabs={[{ id: "day", label: "Day" }]} />,
  );
  assert.match(html, /aria-pressed="true"/);
});
