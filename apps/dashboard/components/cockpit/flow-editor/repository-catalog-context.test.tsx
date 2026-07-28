import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type {
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

async function mount(responses: Array<Promise<Response>>): Promise<Harness> {
  const urls: string[] = [];
  const queue = [...responses];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    const next = queue.shift();
    assert.notEqual(next, undefined, "an unexpected extra request was made");
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

test("the provider fetches the catalog once on mount", async () => {
  const harness = await mount([
    Promise.resolve(
      Response.json({ repositories: [repository("Blazity/a")], providers }),
    ),
  ]);

  await act(async () => undefined);

  assert.deepEqual(harness.urls, ["/api/repositories"]);
  assert.equal(harness.state().status, "ready");
  assert.deepEqual(
    harness.state().repositories.map((option) => option.repoPath),
    ["Blazity/a"],
  );
  assert.deepEqual(harness.state().providers, providers);
  await act(async () => harness.renderer.unmount());
});

test("a stale catalog response never replaces a newer one", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const harness = await mount([first.promise, second.promise]);

  // Refresh supersedes the in-flight mount request.
  await act(async () => harness.state().refresh());
  assert.deepEqual(harness.urls, ["/api/repositories", "/api/repositories"]);

  await act(async () => {
    second.settle(
      Response.json({ repositories: [repository("Blazity/new")], providers }),
    );
  });
  await act(async () => {
    first.settle(
      Response.json({ repositories: [repository("Blazity/stale")], providers }),
    );
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
  const harness = await mount([first.promise, second.promise]);

  await act(async () => harness.state().refresh());
  await act(async () => {
    second.settle(
      Response.json({ repositories: [repository("Blazity/new")], providers }),
    );
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

test("a 200 with an unusable body is an error, not a ready empty catalog", async () => {
  for (const body of [
    {},
    { repositories: [], providers: null },
    { repositories: null },
    { repositories: "Blazity/a" },
    { error: "wrong shape" },
    null,
  ]) {
    const harness = await mount([Promise.resolve(Response.json(body))]);

    await act(async () => undefined);

    assert.equal(
      harness.state().status,
      "error",
      `body ${JSON.stringify(body)} must not read as ready`,
    );
    assert.deepEqual(harness.state().repositories, []);
    await act(async () => harness.renderer.unmount());
  }
});

test("a failed catalog fetch reports the error state", async () => {
  const harness = await mount([
    Promise.resolve(Response.json({ error: "nope" }, { status: 503 })),
  ]);

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
