import { test } from "node:test";
import assert from "node:assert/strict";

import { handlePrePrChecksGet, handlePrePrChecksPut, handlePrePrChecksRestore } from "./handler.ts";

test("GET forwards to the worker and re-serializes status", async () => {
  const res = await handlePrePrChecksGet(async (path, init) => {
    assert.equal(path, "/api/v1/pre-pr-checks");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ current: null, versions: [] }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { current: null, versions: [] });
});

test("PUT forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePrePrChecksPut(
    new Request("https://dashboard.example.com/api/pre-pr-checks", {
      method: "PUT",
      body: JSON.stringify({ config: { repositories: [] } }),
    }),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ error: "Invalid config" }, { status: 400 });
    },
  );
  assert.equal(res.status, 400);
  assert.equal(calls[0].path, "/api/v1/pre-pr-checks");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { config: { repositories: [] } });
});

test("restore maps worker timeouts to 504", async () => {
  const res = await handlePrePrChecksRestore(
    new Request("https://dashboard.example.com/api/pre-pr-checks/restore", {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    }),
    async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  );
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
