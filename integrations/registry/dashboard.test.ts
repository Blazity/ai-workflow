// What the two-level dashboard registry promises its callers.
//
// The promise is that deciding costs no integration code: an integration's
// page ids are data, and its module is loaded only when one of its pages is
// actually rendered. A static import would run the top level of every shipped
// integration on the first load of any integration route, connected or not,
// and nothing in the route above would notice.
//
// The generated registry this build carries has no entries in it (fixtures are
// left out on purpose), so these drive the real functions over a registry of
// their own, which is also the only way to count loads.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import type { ErasedIntegrationDashboardEntry } from "@integrations/host-ui";

interface Counter {
  readonly loads: string[];
}

let cases = 0;
function counterId(): number {
  cases += 1;
  return cases;
}

/** Replaces the generated file with one whose loads can be counted. */
async function withRegistry(
  entries: Readonly<Record<string, ErasedIntegrationDashboardEntry>>,
): Promise<{
  integrationDashboardPages: (id: string) => readonly string[];
  loadIntegrationPage: (id: string, pageId: string) => Promise<unknown>;
}> {
  // `exports` is the current field and `namedExports` the one this @types/node
  // still declares, so the object carries the new name past the type, the same
  // way the dashboard's own module mocks do.
  mock.module("./dashboard.generated.ts", {
    exports: { generatedIntegrationDashboards: entries },
  } as unknown as Parameters<typeof mock.module>[1]);
  // A fresh query string is what makes the import read the mock rather than a
  // copy of the module some earlier test already resolved.
  return (await import(`./dashboard.ts?case=${counterId()}`)) as never;
}

function entry(counter: Counter, id: string, pages: readonly string[]) {
  return {
    pages,
    load: async () => {
      counter.loads.push(id);
      return {
        dashboard: {
          pages: Object.fromEntries(pages.map((page) => [page, () => null])),
        },
      };
    },
  } satisfies ErasedIntegrationDashboardEntry;
}

test("the page ids of an integration are answered without loading it", async (t) => {
  const counter: Counter = { loads: [] };
  const { integrationDashboardPages } = await withRegistry({
    alpha: entry(counter, "alpha", ["overview", "activity"]),
  });
  t.after(() => mock.restoreAll());

  assert.deepEqual(integrationDashboardPages("alpha"), ["overview", "activity"]);
  assert.deepEqual(integrationDashboardPages("beta"), [], "an id nobody ships contributes nothing");
  assert.deepEqual(counter.loads, [], "reading the ids must not run the integration");
});

test("a page id the integration does not serve is refused before its module runs", async (t) => {
  // The route above checks the ids first, so this is the second caller's
  // guard: a URL with a page id from an older build must not be the thing
  // that starts an integration's code.
  const counter: Counter = { loads: [] };
  const { loadIntegrationPage } = await withRegistry({
    alpha: entry(counter, "alpha", ["overview"]),
  });
  t.after(() => mock.restoreAll());

  assert.equal(await loadIntegrationPage("alpha", "activity"), undefined);
  assert.equal(await loadIntegrationPage("beta", "overview"), undefined);
  assert.deepEqual(counter.loads, [], "nothing was rendered, so nothing was loaded");

  assert.equal(typeof (await loadIntegrationPage("alpha", "overview")), "function");
  assert.deepEqual(counter.loads, ["alpha"], "the page that is rendered is the one that loads");
});
