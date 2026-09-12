import assert from "node:assert/strict";
import test from "node:test";

import {
  SUGGEST_TIMEOUT_MS,
  handleCatalogActivate,
  handleCatalogEnabledPatch,
  handleCatalogEntryGet,
  handleCatalogEntryPut,
  handleCatalogImport,
  handleCatalogImportPreview,
  handleCatalogList,
  handleCatalogSuggest,
  handleCatalogVersionsGet,
} from "./handler";

interface Call {
  path: string;
  method: string | undefined;
  body: unknown;
  timeoutMs: number | undefined;
}

function recorder(response: () => Response) {
  const calls: Call[] = [];
  const proxy = async (path: string, init?: RequestInit, timeoutMs?: number) => {
    calls.push({
      path,
      method: init?.method,
      body: init?.body === undefined ? null : JSON.parse(String(init.body) || "null"),
      timeoutMs,
    });
    return response();
  };
  return { calls, proxy };
}

function post(url: string, payload: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(payload) });
}

test("every route forwards to its worker path with the body untouched", async () => {
  const { calls, proxy } = recorder(() => Response.json({}));

  await handleCatalogList(proxy);
  await handleCatalogEntryGet("12", proxy);
  await handleCatalogEntryPut(
    "12",
    new Request("https://dashboard.test/api/repository-catalog/12", {
      method: "PUT",
      body: JSON.stringify({ provider: "github", path: "acme/web", reason: "why" }),
    }),
    proxy,
  );
  await handleCatalogEnabledPatch(
    "12",
    new Request("https://dashboard.test/api/repository-catalog/12/enabled", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    }),
    proxy,
  );
  await handleCatalogVersionsGet("12", null, proxy);
  await handleCatalogActivate(
    post("https://dashboard.test/api/repository-catalog/activate", {
      acknowledgedRepositoryKeys: ["github:acme/web"],
    }),
    proxy,
  );
  await handleCatalogImportPreview(
    post("https://dashboard.test/api/repository-catalog/import-preview", {}),
    proxy,
  );
  await handleCatalogImport(
    post("https://dashboard.test/api/repository-catalog/import", {
      repositoryKeys: ["github:acme/web"],
      enabled: false,
    }),
    proxy,
  );

  assert.deepEqual(
    calls.map((call) => `${call.method ?? "GET"} ${call.path}`),
    [
      "GET /api/v1/repository-catalog",
      "GET /api/v1/repository-catalog/12",
      "PUT /api/v1/repository-catalog/12",
      "PATCH /api/v1/repository-catalog/12/enabled",
      "GET /api/v1/repository-catalog/12/versions",
      "POST /api/v1/repository-catalog/activate",
      "POST /api/v1/repository-catalog/import-preview",
      "POST /api/v1/repository-catalog/import",
    ],
  );
  assert.deepEqual(calls[2].body, {
    provider: "github",
    path: "acme/web",
    reason: "why",
  });
  assert.deepEqual(calls[7].body, {
    repositoryKeys: ["github:acme/web"],
    enabled: false,
  });
});

// D5 / row P34. The history is paged now, so the cursor has to survive this
// proxy: a Load more whose `before` was dropped asks for the first page again
// and pages for ever.
test("the history cursor reaches the worker, and a cursor nobody issued does not", async () => {
  const { calls, proxy } = recorder(() => Response.json({ versions: [], hasMore: false }));

  await handleCatalogVersionsGet("12", "7", proxy);
  const refused = await handleCatalogVersionsGet("12", "7; drop", proxy);

  assert.deepEqual(
    calls.map((call) => `${call.method ?? "GET"} ${call.path}`),
    ["GET /api/v1/repository-catalog/12/versions?before=7"],
  );
  assert.equal(refused.status, 400);
});

test("a path segment that is not an id is refused here instead of reaching the worker", async () => {
  const { calls, proxy } = recorder(() => Response.json({}));

  const responses = await Promise.all([
    handleCatalogEntryGet("../../v1/settings", proxy),
    handleCatalogVersionsGet("12;rm", null, proxy),
    handleCatalogEnabledPatch(
      "",
      new Request("https://dashboard.test", { method: "PATCH", body: "{}" }),
      proxy,
    ),
  ]);

  assert.deepEqual(calls, [], "nothing shaped like a path reaches the worker");
  for (const response of responses) assert.equal(response.status, 400);
});

test("the suggestion proxy waits longer than the worker's own model bound", async () => {
  const { calls, proxy } = recorder(() => Response.json({ proposal: null }));

  await handleCatalogSuggest(
    post("https://dashboard.test/api/repository-catalog/suggest", {
      repositoryId: 4,
    }),
    proxy,
  );

  assert.equal(calls[0].timeoutMs, SUGGEST_TIMEOUT_MS);
  assert.ok(
    SUGGEST_TIMEOUT_MS > 90_000,
    "a shorter ceiling would turn the worker's explained 503 into an unexplained 504",
  );
});

test("the activation conflict reaches the dialog with its status and its list intact", async () => {
  const conflict = {
    error: "unacknowledged_repositories",
    repositories: [
      { key: "github:acme/web", displayName: "acme/web", ticketKeys: ["AIW-1"], runIds: ["r1"] },
    ],
  };
  const response = await handleCatalogActivate(
    post("https://dashboard.test/api/repository-catalog/activate", {
      acknowledgedRepositoryKeys: [],
    }),
    async () => Response.json(conflict, { status: 409 }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), conflict);
});

test("a suggestion refused for the rate limit keeps its 429 and its wait", async () => {
  const response = await handleCatalogSuggest(
    post("https://dashboard.test/api/repository-catalog/suggest", { repositoryId: 4 }),
    async () =>
      Response.json(
        { error: "suggestion_rate_limited", retryAfterSeconds: 42 },
        { status: 429 },
      ),
  );

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "suggestion_rate_limited",
    retryAfterSeconds: 42,
  });
});

test("a member's 403 on a write is passed through rather than turned into an error page", async () => {
  const response = await handleCatalogEnabledPatch(
    "7",
    new Request("https://dashboard.test", { method: "PATCH", body: "{}" }),
    async () => Response.json({ statusMessage: "Forbidden" }, { status: 403 }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { statusMessage: "Forbidden" });
});

test("a worker that never answers becomes a JSON timeout, not a crash", async () => {
  const response = await handleCatalogList(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Worker request timed out" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});
