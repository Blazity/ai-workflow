import { test } from "node:test";
import assert from "node:assert/strict";

import { handlePrePrChecksGet, handleRepositoriesGet } from "./handler.ts";

test("GET forwards to the worker's saved config", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePrePrChecksGet(async (path, init) => {
    calls.push({ path, init: init ?? {} });
    return Response.json({ current: null, versions: [] });
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/pre-pr-checks");
  assert.equal(calls[0].init.method, "GET");
});

test("the repositories read forwards to the worker's provider directory", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleRepositoriesGet(async (path, init) => {
    calls.push({ path, init: init ?? {} });
    return Response.json({ repositories: [], providers: [] });
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/repositories");
});

test("a worker timeout on the read is a 504, not a thrown request", async () => {
  const res = await handlePrePrChecksGet(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
