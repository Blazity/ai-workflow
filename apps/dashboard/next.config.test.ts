// apps/dashboard/next.config.test.ts
//
// The retired routes. `/scripts` and `/checks` are in bookmarks, in Slack
// messages the worker posted and in older block panels, and a 404 on either
// teaches nobody where the screen went.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import nextConfig from "./next.config";

// `redirect` throws in the app router, which is how it stops rendering. The
// route is a two-line forward, so the mock records the destination and returns,
// which is the whole of what the page does.
const redirected: string[] = [];
// `exports` is the current field and `namedExports` the one this @types/node
// still declares, so the object carries the new name past the type.
mock.module("next/navigation", {
  exports: {
    redirect: (path: string) => {
      redirected.push(path);
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

test("/scripts is permanently redirected to the Repositories page", async () => {
  const redirects = await nextConfig.redirects?.();
  assert.ok(redirects, "the dashboard must declare its retired routes");
  const scripts = redirects.find((entry) => entry.source === "/scripts");
  assert.ok(scripts, "/scripts must still resolve to something");
  assert.equal(scripts.destination, "/repositories");
  // Permanent, because the screen is not coming back: a temporary redirect
  // would keep every client asking for a path that no longer exists.
  assert.equal(scripts.permanent, true);
});

test("/checks forwards to the Repositories page rather than rendering anything", async () => {
  // The oldest link of the three, and the one that forwards in the route rather
  // than in the config, because it is a page inside the cockpit group.
  const { default: ChecksPage } = await import("./app/(cockpit)/checks/page");
  ChecksPage();
  assert.deepEqual(redirected, ["/repositories"]);
});
