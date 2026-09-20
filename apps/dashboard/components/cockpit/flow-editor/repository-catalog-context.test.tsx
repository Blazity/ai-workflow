import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type {
  RepositoryCatalogEntry,
  RepositoryOption,
  RepositoryProviderStatus,
} from "@shared/contracts";
import {
  RepositoryCatalogProvider,
  useRepositoryCatalog,
  type RepositoryCatalogState,
} from "./repository-catalog-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function repository(repoPath: string): RepositoryOption {
  return {
    provider: "github",
    repoPath,
    name: repoPath.split("/")[1],
    owner: repoPath.split("/")[0],
    defaultBranch: "main",
    private: true,
    archived: false,
  };
}

const providers: RepositoryProviderStatus[] = [
  { provider: "github", status: "ready" },
  { provider: "gitlab", status: "not_connected" },
];

/** One catalog row. The picker reads `enabled` and little else, but the body
 *  is the contract's, so a field the provider starts reading is already here. */
function catalogEntry(path: string, enabled: boolean): RepositoryCatalogEntry {
  return {
    id: path.length,
    provider: "github",
    path,
    displayName: path,
    defaultBranch: "main",
    description: "",
    rules: "",
    relationships: [],
    enabled,
    source: "imported",
    profileVersion: 0,
    checksVersion: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** `GET /api/repository-catalog`, the authority on what may be pinned. */
function catalogBody(input: {
  activated: boolean;
  rows: Array<[string, boolean]>;
}) {
  return {
    state: {
      activated: input.activated,
      bridge: !input.activated,
      activatedAt: input.activated ? "2026-09-11T08:30:00.000Z" : null,
      activatedById: input.activated ? "user-7" : null,
      activatedByLabel: input.activated ? "Seed" : null,
    },
    repositories: input.rows.map(([path, enabled]) => catalogEntry(path, enabled)),
  };
}

/** `GET /api/repositories`, the provider directory: what the installation can
 *  see, which is still the list while the bridge is on. */
function directoryBody(paths: string[]) {
  return { repositories: paths.map((path) => repository(path)), providers };
}

/** A read a test holds open on purpose, to observe the screen while it waits.
 *  `resolve` is what ends it; the waiter below is `settle`. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

/** What `settle` watches: the reads this provider has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One mount per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs `handler` as the fetch for one test and returns the undo.
 *
 * The handler is called at the call, not inside `answer`, so a queue keyed by
 * URL still hands out its bodies in the order the provider asked in, and an
 * unexpected extra request still fails at the request. Only the answer is
 * delayed: it lands a turn later, the way a response does, because resolving
 * in the caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is
 * how this harness reproduces a runner slow enough to break a counted wait.
 * A read a test holds open deliberately stays in flight until that test ends
 * it: the knob adds to the wait, it does not shorten it.
 */
function installFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    mine.inFlight += 1;
    mine.started += 1;
    const answered = handler(String(url), init);
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return answered;
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of reads the provider starts finish, and waits for exactly
 * that.
 *
 * NEVER A COUNT OF TURNS. One refresh is two reads whose bodies land a turn or
 * more after the call, and a landed read can start the next one. How many
 * turns that costs is the runner's business, so a fixed count passes on an
 * idle machine and, on a loaded one, returns while a read is still in flight:
 * the assertion then reads a half-loaded provider and the failure looks like
 * the product. Quiet is the condition those assertions mean, and it is two
 * things: nothing in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of
 * failing, and a provider that never settles fails as a readable timeout
 * rather than hanging the suite.
 */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) {
      assert.fail(
        `the provider was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`,
      );
    }
  }
}

/**
 * Waits for the thing the next assertion is about, and fails saying what it
 * was still waiting for. For the tests that hold a read open on purpose, where
 * "nothing in flight" never becomes true and is not what they mean anyway.
 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) {
      assert.fail(`waited ${timeoutMs} ms for ${what}`);
    }
    await turn();
  }
}

interface Harness {
  renderer: ReactTestRenderer;
  state: () => RepositoryCatalogState;
  urls: string[];
}

/**
 * Mounts the provider over one queue per endpoint.
 *
 * Two reads answer one refresh now (the catalog decides what may be pinned, the
 * provider directory is the fleet while the bridge is on), and they are issued
 * together, so a queue keyed by position would hand the catalog's body to the
 * directory the moment either one is deferred.
 */
async function mount(responses: {
  catalog?: Array<Promise<Response>>;
  directory?: Array<Promise<Response>>;
}): Promise<Harness> {
  const urls: string[] = [];
  const queues: Record<string, Array<Promise<Response>>> = {
    "/api/repository-catalog": [...(responses.catalog ?? [])],
    "/api/repositories": [...(responses.directory ?? [])],
  };
  const uninstallFetch = installFetch((url) => {
    urls.push(url);
    const queue = queues[url];
    assert.ok(queue, `no queue for ${url}`);
    const next = queue.shift();
    assert.notEqual(next, undefined, `an unexpected extra request was made to ${url}`);
    return next!;
  });

  let captured!: RepositoryCatalogState;
  function Probe() {
    captured = useRepositoryCatalog();
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <RepositoryCatalogProvider>
        <Probe />
      </RepositoryCatalogProvider>,
    );
  });
  renderer.unmount = ((original) => () => {
    uninstallFetch();
    original.call(renderer);
  })(renderer.unmount);
  return { renderer, state: () => captured, urls };
}

test("the provider reads the repository catalog and the directory once on mount", async () => {
  const harness = await mount({
    catalog: [Promise.resolve(Response.json(catalogBody({ activated: false, rows: [] })))],
    directory: [Promise.resolve(Response.json(directoryBody(["Blazity/a"])))],
  });

  await settle();

  assert.deepEqual(harness.urls.toSorted(), [
    "/api/repositories",
    "/api/repository-catalog",
  ]);
  assert.equal(harness.state().status, "ready");
  assert.equal(harness.state().activated, false);
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/a"],
  );
  assert.deepEqual(harness.state().providers, providers);
  await act(async () => harness.renderer.unmount());
});

test("an activated catalog offers its enabled rows only, and not the rest of the directory", async () => {
  // The whole point of activation: dispatch stops selecting what the catalog
  // does not enable, so offering those rows for a pin would offer a pin that
  // selects nothing.
  const harness = await mount({
    catalog: [
      Promise.resolve(
        Response.json(
          catalogBody({
            activated: true,
            rows: [
              ["Blazity/enabled", true],
              ["Blazity/disabled", false],
            ],
          }),
        ),
      ),
    ],
    directory: [
      Promise.resolve(
        Response.json(
          directoryBody(["Blazity/enabled", "Blazity/disabled", "Blazity/uncatalogued"]),
        ),
      ),
    ],
  });

  await settle();

  assert.equal(harness.state().activated, true);
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/enabled"],
  );
  // The directory still decorates the row it knows: archived and private are
  // facts the catalog does not carry.
  assert.equal(harness.state().repositories[0].private, true);
  await act(async () => harness.renderer.unmount());
});

test("while the bridge is on the directory is the list, with the catalog's disabled rows marked", async () => {
  // Nothing is refused yet: dispatch accepts everything the installation sees.
  // A row the catalog carries and does not enable is exactly the pin that stops
  // working on the day somebody activates, so it is shown and marked.
  const harness = await mount({
    catalog: [
      Promise.resolve(
        Response.json(
          catalogBody({
            activated: false,
            rows: [
              ["Blazity/enabled", true],
              ["Blazity/disabled", false],
            ],
          }),
        ),
      ),
    ],
    directory: [
      Promise.resolve(
        Response.json(
          directoryBody(["Blazity/enabled", "Blazity/disabled", "Blazity/uncatalogued"]),
        ),
      ),
    ],
  });

  await settle();

  assert.deepEqual(
    harness.state().repositories.map((option) => [
      option.repoPath,
      option.enabledInCatalog,
    ]),
    [
      ["Blazity/enabled", true],
      ["Blazity/disabled", false],
      // Absent from the catalog is not a claim against it: the bridge enables
      // every repository the installation can see.
      ["Blazity/uncatalogued", true],
    ],
  );
  await act(async () => harness.renderer.unmount());
});

test("a catalog read that fails falls back to the directory and says the enabled state is unknown", async () => {
  // A picker that refuses to open costs the operator the whole editor, and
  // dispatch enforces the catalog whatever this screen believes: the worst a
  // fallback row can do is be a pin that selects nothing.
  const harness = await mount({
    catalog: [Promise.resolve(Response.json({ error: "nope" }, { status: 503 }))],
    directory: [Promise.resolve(Response.json(directoryBody(["Blazity/a"])))],
  });

  await settle();

  assert.equal(harness.state().status, "ready");
  assert.equal(harness.state().catalogAvailable, false);
  assert.equal(harness.state().directoryAvailable, true);
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/a"],
  );
  // Absent, never `true`: the screen has no idea and must not claim one.
  assert.equal(harness.state().repositories[0].enabledInCatalog, undefined);
  await act(async () => harness.renderer.unmount());
});

test("a directory read that fails renders the catalog and reports the providers as unknown", async () => {
  const harness = await mount({
    catalog: [
      Promise.resolve(
        Response.json(catalogBody({ activated: true, rows: [["Blazity/a", true]] })),
      ),
    ],
    directory: [Promise.resolve(Response.json({ error: "nope" }, { status: 500 }))],
  });

  await settle();

  assert.equal(harness.state().status, "ready");
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/a"],
  );
  // The rows name which providers exist and NOTHING about their health, so
  // stamping "ready" here is what used to silence the bar's "provider not
  // connected" badge on exactly the deployment whose provider had gone away.
  assert.deepEqual(harness.state().providers, [
    {
      provider: "github",
      status: "error",
      error: "Provider directory unavailable, connection state unknown",
    },
  ]);
  assert.equal(harness.state().directoryAvailable, false);
  assert.equal(harness.state().catalogAvailable, true);
  await act(async () => harness.renderer.unmount());
});

test("a directory read that fails while the bridge is on is an error", async () => {
  // Under the bridge the directory IS the list, so losing it is losing the
  // picker, and an empty list presented as ready reads as "no access".
  const harness = await mount({
    catalog: [
      Promise.resolve(Response.json(catalogBody({ activated: false, rows: [] }))),
    ],
    directory: [Promise.resolve(Response.json({ error: "nope" }, { status: 500 }))],
  });

  await settle();

  assert.equal(harness.state().status, "error");
  await act(async () => harness.renderer.unmount());
});

test("a stale catalog response never replaces a newer one", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const harness = await mount({
    catalog: [
      Promise.resolve(Response.json(catalogBody({ activated: false, rows: [] }))),
      Promise.resolve(Response.json(catalogBody({ activated: false, rows: [] }))),
    ],
    directory: [first.promise, second.promise],
  });

  // Refresh supersedes the in-flight mount request. Both reads stay open: that
  // is the state this test exists to observe, so it waits for the second
  // request to have been made and never for quiet.
  await act(async () => harness.state().refresh());
  await waitFor(
    () => harness.urls.filter((url) => url === "/api/repositories").length === 2,
    "the refresh to issue its own directory read",
  );

  await act(async () => {
    second.resolve(Response.json(directoryBody(["Blazity/new"])));
  });
  await waitFor(
    () => harness.state().repositories.some((option) => option.repoPath === "Blazity/new"),
    "the newer directory to land",
  );
  await act(async () => {
    first.resolve(Response.json(directoryBody(["Blazity/stale"])));
  });
  await settle();

  assert.equal(harness.state().status, "ready");
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/new"],
    "the superseded response must not overwrite the newer catalog",
  );
  await act(async () => harness.renderer.unmount());
});

test("a stale failure never downgrades a newer successful catalog", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const harness = await mount({
    catalog: [first.promise, second.promise],
    directory: [
      Promise.resolve(Response.json(directoryBody(["Blazity/new"]))),
      Promise.resolve(Response.json(directoryBody(["Blazity/new"]))),
    ],
  });

  // Both catalog reads stay open on purpose, so the waits here are for the
  // newer body landing and then for the whole pair being done.
  await act(async () => harness.state().refresh());
  await waitFor(
    () => harness.urls.filter((url) => url === "/api/repository-catalog").length === 2,
    "the refresh to issue its own catalog read",
  );
  await act(async () => {
    second.resolve(Response.json(catalogBody({ activated: false, rows: [] })));
  });
  await waitFor(() => harness.state().status === "ready", "the newer catalog to land");
  await act(async () => {
    first.resolve(Response.json({ error: "boom" }, { status: 500 }));
  });
  await settle();

  assert.equal(harness.state().status, "ready");
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/new"],
  );
  await act(async () => harness.renderer.unmount());
});

test("a 200 with an unusable body counts as the catalog not answering, never as an empty one", async () => {
  // Every consumer maps over `repositories`, so anything but an array has to be
  // treated as no answer rather than landing as a `ready` EMPTY catalog, which
  // would read as "the agent may touch nothing".
  for (const body of [
    {},
    { repositories: [], state: null },
    { repositories: null, state: { activated: false } },
    { repositories: "Blazity/a", state: { activated: false } },
    { error: "wrong shape" },
    null,
  ]) {
    const harness = await mount({
      catalog: [Promise.resolve(Response.json(body))],
      directory: [Promise.resolve(Response.json(directoryBody(["Blazity/a"])))],
    });

    await settle();

    assert.equal(
      harness.state().catalogAvailable,
      false,
      `body ${JSON.stringify(body)} must not read as a catalog`,
    );
    assert.deepEqual(
      harness.state().repositories.map((option) => option.repoPath),
      ["Blazity/a"],
      "the directory still answers, so the picker still works",
    );
    await act(async () => harness.renderer.unmount());
  }
});

test("losing both reads is the one case that loses the picker", async () => {
  const harness = await mount({
    catalog: [Promise.resolve(Response.json({ error: "nope" }, { status: 503 }))],
    directory: [Promise.resolve(Response.json({ error: "nope" }, { status: 500 }))],
  });

  await settle();

  assert.equal(harness.state().status, "error");
  assert.deepEqual(harness.state().repositories, []);
  await act(async () => harness.renderer.unmount());
});

test("an injected catalog renders without any request", async () => {
  const urls: string[] = [];
  const uninstallFetch = installFetch((url) => {
    urls.push(url);
    return Promise.reject(new Error("must not fetch"));
  });

  let captured!: RepositoryCatalogState;
  function Probe() {
    captured = useRepositoryCatalog();
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <RepositoryCatalogProvider
        initial={{ status: "ready", repositories: [repository("Blazity/given")] }}
      >
        <Probe />
      </RepositoryCatalogProvider>,
    );
  });

  assert.deepEqual(urls, []);
  assert.equal(captured.status, "ready");
  assert.deepEqual(
    captured.repositories.map((option) => option.repoPath),
    ["Blazity/given"],
  );
  await act(async () => renderer.unmount());
  uninstallFetch();
});
