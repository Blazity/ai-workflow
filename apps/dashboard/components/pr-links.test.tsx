// The change request chips on a run, rendered: what a person reads is the
// provider's own noun and reference, not the word core happened to write.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { PRLinks } from "./ui";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function rendered(run: React.ComponentProps<typeof PRLinks>["run"]): string {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<PRLinks run={run} />);
  });
  const text = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
  const out = text(renderer.root);
  act(() => renderer.unmount());
  return out;
}

test("a GitLab merge request reads as MR !12, as it did before providers became integrations", () => {
  // On GitLab `#12` is issue 12, so "PR #12" pointed a person at the wrong thing.
  const out = rendered({
    prs: [{ provider: "gitlab", repoPath: "acme/api", id: 12, url: "https://gitlab.example/acme/api/-/merge_requests/12" }],
    prUrl: null,
    prNumber: null,
  });
  assert.match(out, /MR!12/);
  assert.doesNotMatch(out, /PR/);
});

test("a gate run that stored only the link still names a merge request as one", () => {
  const out = rendered({
    prs: null,
    prUrl: "https://gitlab.example/acme/api/-/merge_requests/40",
    prNumber: 40,
  });
  assert.match(out, /MR!40/);
});

test("a GitHub pull request keeps reading as PR #12", () => {
  const out = rendered({
    prs: [{ provider: "github", repoPath: "acme/web", id: 12, url: "https://github.com/acme/web/pull/12" }],
    prUrl: null,
    prNumber: null,
  });
  assert.match(out, /PR#12/);
});
