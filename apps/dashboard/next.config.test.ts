// apps/dashboard/next.config.test.ts
//
// The retired routes. `/scripts` and `/checks` are in bookmarks, in Slack
// messages the worker posted and in older block panels, and a 404 on either
// teaches nobody where the screen went.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
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

test("the old System health and Users URLs still work", async () => {
  // Both are in bookmarks and in runbooks, and both moved into the Settings
  // area in the same change that gave the sidebar its Integrations section.
  const redirects = await nextConfig.redirects?.();
  assert.ok(redirects, "the dashboard must declare its retired routes");
  const bySource = new Map(redirects.map((entry) => [entry.source, entry]));

  const health = bySource.get("/health");
  assert.equal(health?.destination, "/settings/health");
  assert.equal(health?.permanent, true, "System health is not coming back to /health");

  const users = bySource.get("/users");
  assert.equal(users?.destination, "/settings/users");
  assert.equal(users?.permanent, true, "Users is not coming back to /users");

  // A destination carrying a query of its own replaces the one the person
  // arrived with, and `/health?provider=jira` is a shape people have.
  for (const entry of redirects) {
    assert.ok(
      !entry.destination.includes("?"),
      `${entry.source} must not overwrite the query string`,
    );
  }
});

test("the old Evals URL lands on the Evals page its integration now serves", async () => {
  // Evals moved from a core screen into the Arthur Engine's own area. The
  // old link is in bookmarks and in messages, and a 404 there reads as "the
  // feature is gone" when it only moved.
  const redirects = await nextConfig.redirects?.();
  const evals = redirects?.find((entry) => entry.source === "/evals");
  assert.equal(evals?.destination, "/integrations/arthur/evals");
  assert.equal(evals?.permanent, true, "Evals is not coming back to /evals");
});

test("every path a page declares it moved from lands on that page", async () => {
  // The integration owns the list, so a screen that moves out of core next
  // needs no edit here, and one that stops declaring its old path loses it.
  const { integrationManifests } = await import("@integrations/registry");
  const redirects = (await nextConfig.redirects?.()) ?? [];
  const declared = integrationManifests.flatMap((manifest) =>
    manifest.pages.flatMap((page) =>
      (page.legacyPaths ?? []).map((source) => ({ source, page: `/integrations/${manifest.id}/${page.id}` })),
    ),
  );
  assert.ok(declared.length > 0, "no page declares a legacy path, so this proves nothing");
  for (const { source, page } of declared) {
    const entry = redirects.find((redirect) => redirect.source === source);
    assert.equal(entry?.destination, page, `${source} must land on ${page}`);
    assert.equal(entry?.permanent, true);
  }
});

test("Next's own config loader reads the same redirects, /evals included", () => {
  // The tests above import this file through tsx. `next build` and `next dev`
  // load it differently: SWC compiles it to CommonJS and Node's own resolver
  // requires what it imports, so a module in the registry graph written with
  // an ESM habit tsx forgives (`./navigation.js` for navigation.ts) would pass
  // every test above and fail the build. The loader runs in a child process,
  // outside tsx, exactly as Next calls it.
  const script = `
    const load = require("next/dist/server/config").default;
    const { PHASE_PRODUCTION_BUILD } = require("next/constants");
    load(PHASE_PRODUCTION_BUILD, process.cwd(), { silent: true })
      .then((config) => config.redirects())
      .then((redirects) => process.stdout.write(JSON.stringify(redirects)))
      .catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ["-e", script], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(run.status, 0, `Next could not load next.config.ts:\n${run.stderr}`);
  const redirects = JSON.parse(run.stdout) as Array<{ source: string; destination: string; permanent: boolean }>;
  assert.deepEqual(
    redirects.find((entry) => entry.source === "/evals"),
    { source: "/evals", destination: "/integrations/arthur/evals", permanent: true },
  );
  assert.ok(redirects.some((entry) => entry.source === "/scripts"), "the core redirects are there too");
});

/** Every first path segment the app serves, route groups looked through. */
function servedSegments(directory = join(import.meta.dirname, "app")): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .flatMap((entry) =>
      /^\(.*\)$/u.test(entry.name) ? servedSegments(join(directory, entry.name)) : [entry.name],
    );
}

test("no redirect hides a screen the dashboard serves, and no two share a source", async () => {
  // Redirects run before the app's own routes, so a legacy path an
  // integration declared on a live screen would take that screen away.
  const redirects = (await nextConfig.redirects?.()) ?? [];
  const served = new Set(servedSegments().map((segment) => `/${segment}`));
  assert.ok(served.has("/settings") && served.has("/login"), "the route scan found no screens");
  for (const entry of redirects) {
    assert.ok(!served.has(entry.source), `${entry.source} is a screen the dashboard serves`);
  }
  const sources = redirects.map((entry) => entry.source);
  assert.deepEqual(sources, [...new Set(sources)], "two redirects share a source");
});

test("no redirect points at a path that redirects again", async () => {
  // A chain costs a round trip per hop and breaks the moment one hop changes.
  const redirects = (await nextConfig.redirects?.()) ?? [];
  const sources = new Set(redirects.map((entry) => entry.source));
  for (const entry of redirects) {
    assert.ok(
      !sources.has(entry.destination),
      `${entry.source} redirects to ${entry.destination}, which redirects again`,
    );
  }
});

test("/checks forwards to the Repositories page rather than rendering anything", async () => {
  // The oldest link of the three, and the one that forwards in the route rather
  // than in the config, because it is a page inside the cockpit group.
  const { default: ChecksPage } = await import("./app/(cockpit)/checks/page");
  ChecksPage();
  assert.deepEqual(redirected, ["/repositories"]);
});
