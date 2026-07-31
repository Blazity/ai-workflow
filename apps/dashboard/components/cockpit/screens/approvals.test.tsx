import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LocalDateTime, formatDateTime } from "./approvals";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUESTED_AT = "2026-07-30T14:44:00.000Z";

test("the timestamp is formatted in one pinned locale, not the renderer's", () => {
  assert.equal(formatDateTime(REQUESTED_AT, "UTC"), "Jul 30, 02:44 PM");
});

test("an unparseable timestamp is passed through untouched", () => {
  assert.equal(formatDateTime("whenever"), "whenever");
});

test("the server render carries no time of day", () => {
  // The server formats in its own zone (UTC on Vercel) and the browser in the
  // viewer's, so any timestamp in the server HTML guarantees a hydration
  // mismatch, which discards the hydrated tree: duplicated rows, dead handlers.
  const html = renderToStaticMarkup(<LocalDateTime value={REQUESTED_AT} />);
  assert.equal(html, "...");
  assert.doesNotMatch(html, /\d/);
});

test("the local time fills in after mount", (t) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LocalDateTime value={REQUESTED_AT} />);
  });
  t.after(() => {
    act(() => renderer.unmount());
  });

  // Compared against the helper, not a literal: the mounted value is the
  // runner's own zone, and pinning it here would only assert the test's zone.
  assert.equal(renderer.toJSON(), formatDateTime(REQUESTED_AT));
});
