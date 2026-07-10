import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleWorkflowDefinitionGet,
  handleWorkflowDefinitionPut,
  handleWorkflowDefinitionRestore,
} from "./handler.ts";

test("GET forwards to the worker and re-serializes status", async () => {
  const res = await handleWorkflowDefinitionGet(async (path, init) => {
    assert.equal(path, "/api/v1/workflow-definition");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ current: null, versions: [] }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { current: null, versions: [] });
});

test("PUT forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleWorkflowDefinitionPut(
    new Request("https://dashboard.example.com/api/workflow-definition", {
      method: "PUT",
      body: JSON.stringify({ definition: { schemaVersion: 1, nodes: [], edges: [] } }),
    }),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ error: "Invalid definition" }, { status: 400 });
    },
  );
  assert.equal(res.status, 400);
  assert.equal(calls[0].path, "/api/v1/workflow-definition");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    definition: { schemaVersion: 1, nodes: [], edges: [] },
  });
});

test("restore maps worker timeouts to 504", async () => {
  const res = await handleWorkflowDefinitionRestore(
    new Request("https://dashboard.example.com/api/workflow-definition/restore", {
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
