// The boundary a contributed page falls into when it throws, walked the way a
// person meets it: press Try again, or go to the Connection tab.
//
// Beside `[id]/` rather than inside it: a test file under a dynamic-route
// directory is never run (see integration-area.test.tsx).
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import ContributedPageError from "./[id]/[page]/error";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(t: TestContext, calls: string[]): ReactTestInstance {
  const router = {
    refresh: () => calls.push("refresh"),
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <PathParamsContext.Provider value={{ id: "demo", page: "activity" }}>
          <ContributedPageError
            error={Object.assign(new Error("render failed"), { digest: "abc123" })}
            reset={() => calls.push("reset")}
          />
        </PathParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((entry) => typeof entry === "string"))
    .join(" ");
}

test("Try again asks the server for the page again, not only the boundary", async (t) => {
  // A contributed page is a Server Component, so what threw was a server
  // render. `reset` alone re-renders the boundary's contents from the payload
  // the client already holds, which is the one that failed: the button did
  // nothing a person could see. Refreshing is what fetches the page again.
  const calls: string[] = [];
  const root = render(t, calls);
  const retry = root.find((node) => node.type === "button" && text(node).includes("Try again"));

  await act(async () => {
    retry.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });

  assert.deepEqual(calls, ["refresh", "reset"]);
});

test("the way out goes to this integration's Connection tab, as the page promises", (t) => {
  const root = render(t, []);
  const hrefs = root.findAll((node) => node.type === "a").map((node) => node.props.href);
  assert.ok(hrefs.includes("/integrations/demo/connection"), `links: ${hrefs.join(", ")}`);
});
