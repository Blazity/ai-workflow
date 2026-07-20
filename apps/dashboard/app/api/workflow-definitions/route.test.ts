import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleDefinitionDelete,
  handleDefinitionDeploy,
  handleDefinitionGet,
  handleDefinitionPatch,
  handleDefinitionPut,
  handleDefinitionLayout,
  handleDefinitionRollback,
  handleDefinitionValidate,
  handleDefinitionRestore,
  handleDefinitionsCreate,
  handleDefinitionsList,
} from "./handler.ts";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

test("list GET forwards to the worker and re-serializes status", async () => {
  const res = await handleDefinitionsList(async (path, init) => {
    assert.equal(path, "/api/v1/workflow-definitions");
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({ definitions: [] }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { definitions: [] });
});

test("create POST forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleDefinitionsCreate(
    new Request("https://dashboard.example.com/api/workflow-definitions", {
      method: "POST",
      body: JSON.stringify({ name: "Bugfix flow", source: { kind: "default" } }),
    }),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ statusMessage: "Name already in use" }, { status: 409 });
    },
  );
  assert.equal(res.status, 409);
  assert.equal(calls[0].path, "/api/v1/workflow-definitions");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    name: "Bugfix flow",
    source: { kind: "default" },
  });
});

test("detail GET forwards the encoded id", async () => {
  const res = await handleDefinitionGet(idParams("12"), async (path, init) => {
    assert.equal(path, "/api/v1/workflow-definitions/12");
    assert.equal(init?.method, "GET");
    return Response.json({ meta: { id: 12 } }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { meta: { id: 12 } });
});

test("detail PUT forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleDefinitionPut(
    new Request("https://dashboard.example.com/api/workflow-definitions/12", {
      method: "PUT",
      body: JSON.stringify({ definition: { schemaVersion: 1, nodes: [], edges: [] } }),
    }),
    idParams("12"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ error: "Invalid definition" }, { status: 400 });
    },
  );
  assert.equal(res.status, 400);
  assert.equal(calls[0].path, "/api/v1/workflow-definitions/12");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    definition: { schemaVersion: 1, nodes: [], edges: [] },
  });
});

test("detail PATCH forwards the JSON body", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleDefinitionPatch(
    new Request("https://dashboard.example.com/api/workflow-definitions/12", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    }),
    idParams("12"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ id: 12, enabled: true }, { status: 200 });
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/workflow-definitions/12");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { enabled: true });
});

test("detail DELETE forwards and re-serializes status", async () => {
  const res = await handleDefinitionDelete(idParams("12"), async (path, init) => {
    assert.equal(path, "/api/v1/workflow-definitions/12");
    assert.equal(init?.method, "DELETE");
    return Response.json({ ok: true }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("restore forwards to the nested worker path", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleDefinitionRestore(
    new Request("https://dashboard.example.com/api/workflow-definitions/12/restore", {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    }),
    idParams("12"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ meta: { id: 12 }, version: { version: 4 } }, { status: 200 });
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/workflow-definitions/12/restore");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { version: 3 });
});

test("restore maps worker timeouts to 504", async () => {
  const res = await handleDefinitionRestore(
    new Request("https://dashboard.example.com/api/workflow-definitions/12/restore", {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    }),
    idParams("12"),
    async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  );
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});

for (const [name, handler, method] of [
  ["deploy", handleDefinitionDeploy, "POST"],
  ["rollback", handleDefinitionRollback, "POST"],
  ["validate", handleDefinitionValidate, "POST"],
  ["layout", handleDefinitionLayout, "PATCH"],
] as const) {
  test(`${name} forwards its body to the nested worker path`, async () => {
    const payload = { expectedDraftRevision: 3, expectedDeployedVersion: 2 };
    const res = await handler(
      new Request(`https://dashboard.example.com/api/workflow-definitions/12/${name}`, {
        method,
        body: JSON.stringify(payload),
      }),
      idParams("12"),
      async (path, init) => {
        assert.equal(path, `/api/v1/workflow-definitions/12/${name}`);
        assert.equal(init?.method, method);
        assert.deepEqual(JSON.parse(String(init?.body)), payload);
        return Response.json({ ok: true });
      },
    );
    assert.equal(res.status, 200);
  });
}

for (const workerResponse of [
  Response.json({ statusMessage: "Invalid workflow graph" }, { status: 400 }),
  new Response("Draft changed; reload before saving", {
    status: 409,
    headers: { "content-type": "text/plain; charset=utf-8" },
  }),
  Response.json({ error: "Validation service unavailable" }, { status: 500 }),
]) {
  test(`validation preserves worker ${workerResponse.status} status and message`, async () => {
    const expectedBody = await workerResponse.clone().text();
    const res = await handleDefinitionValidate(
      new Request("https://dashboard.example.com/api/workflow-definitions/12/validate", {
        method: "POST",
        body: JSON.stringify({ definition: { schemaVersion: 1, nodes: [], edges: [] } }),
      }),
      idParams("12"),
      async () => workerResponse,
    );

    assert.equal(res.status, workerResponse.status);
    assert.equal(res.headers.get("content-type"), workerResponse.headers.get("content-type"));
    assert.equal(await res.text(), expectedBody);
  });
}
