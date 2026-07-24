import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillImport } from "./skill-import";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("GitHub skill import opens as the approved three-step exact-pin drawer", () => {
  const html = renderToStaticMarkup(
    <SkillImport
      open
      disabled={false}
      onClose={() => undefined}
      onImported={() => undefined}
    />,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /1\. Source/);
  assert.match(html, /2\. Discover/);
  assert.match(html, /3\. Review/);
  assert.match(html, /owner\/repository/);
  assert.match(html, /organization GitHub App/);
  assert.match(html, /exact commit/);
});

test("closed GitHub skill import renders nothing", () => {
  const html = renderToStaticMarkup(
    <SkillImport
      open={false}
      disabled={false}
      onClose={() => undefined}
      onImported={() => undefined}
    />,
  );
  assert.equal(html, "");
});
