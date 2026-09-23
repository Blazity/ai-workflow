// The cockpit's activity drawer has no real event source wired up yet. A
// newcomer running the integration playbook found it inventing events for
// GitHub, Vercel and a provider spelled "linear", shown to real users and
// also refusing the new-integration scaffold's own example id (core spells
// "linear" here). This drawer must show an honest empty state instead of
// sample data until a real source exists.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CkActivityDrawer } from "./activity-drawer";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function render(open: boolean) {
  return renderToStaticMarkup(<CkActivityDrawer open={open} onClose={() => undefined} />);
}

test("the activity drawer invents no events and names no provider", () => {
  const html = render(true);
  assert.doesNotMatch(html, /linear/i, "no invented Linear event or filter");
  assert.doesNotMatch(html, /vercel/i, "no invented Vercel event or filter");
  assert.doesNotMatch(html, /github/i, "no invented GitHub event or filter");
  assert.doesNotMatch(html, /pnpm test/i, "no invented sandbox exec line");
});

test("the activity drawer says plainly that there is nothing to show", () => {
  const html = render(true);
  assert.match(html, /Nothing here yet/);
});
