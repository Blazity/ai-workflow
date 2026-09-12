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

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    const queue = queues[String(url)];
    assert.ok(queue, `no queue for ${url}`);
    const next = queue.shift();
    assert.notEqual(next, undefined, `an unexpected extra request was made to ${url}`);
    return next!;
  }) as typeof globalThis.fetch;

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
    globalThis.fetch = originalFetch;
    original.call(renderer);
  })(renderer.unmount);
  return { renderer, state: () => captured, urls };
}

test("the provider reads the repository catalog and the directory once on mount", async () => {
  const harness = await mount({
    catalog: [Promise.resolve(Response.json(catalogBody({ activated: false, rows: [] })))],
    directory: [Promise.resolve(Response.json(directoryBody(["Blazity/a"])))],
  });

  await act(async () => undefined);

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

  await act(async () => undefined);

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

  await act(async () => undefined);

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

  await act(async () => undefined);

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

  await act(async () => undefined);

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

  await act(async () => undefined);

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

  // Refresh supersedes the in-flight mount request.
  await act(async () => harness.state().refresh());
  assert.equal(
    harness.urls.filter((url) => url === "/api/repositories").length,
    2,
  );

  await act(async () => {
    second.settle(Response.json(directoryBody(["Blazity/new"])));
  });
  await act(async () => {
    first.settle(Response.json(directoryBody(["Blazity/stale"])));
  });

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

  await act(async () => harness.state().refresh());
  await act(async () => {
    second.settle(Response.json(catalogBody({ activated: false, rows: [] })));
  });
  await act(async () => {
    first.settle(Response.json({ error: "boom" }, { status: 500 }));
  });

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

    await act(async () => undefined);

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

  await act(async () => undefined);

  assert.equal(harness.state().status, "error");
  assert.deepEqual(harness.state().repositories, []);
  await act(async () => harness.renderer.unmount());
});

test("an injected catalog renders without any request", async () => {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.reject(new Error("must not fetch"));
  }) as typeof globalThis.fetch;

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
  globalThis.fetch = originalFetch;
});
