import { test } from "node:test";
import assert from "node:assert/strict";

import { handleRepositoriesGet } from "../pre-pr-checks/handler.ts";

test("GET forwards to the worker repository catalog and re-serializes it", async () => {
  const repositories = [
    {
      provider: "github",
      repoPath: "Blazity/ai-workflow",
      name: "ai-workflow",
      owner: "Blazity",
      defaultBranch: "main",
      private: true,
      archived: false,
    },
  ];
  const res = await handleRepositoriesGet(async (path, init) => {
    assert.equal(path, "/api/v1/repositories");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ repositories }, { status: 200 });
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { repositories });
});

test("GET propagates a worker failure status instead of inventing a catalog", async () => {
  const res = await handleRepositoriesGet(async () =>
    Response.json({ error: "Forbidden" }, { status: 403 }),
  );

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
});

test("GET maps worker timeouts to 504", async () => {
  const res = await handleRepositoriesGet(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
