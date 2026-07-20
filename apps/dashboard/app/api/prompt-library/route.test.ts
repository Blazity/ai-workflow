import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handlePromptDelete,
  handlePromptGet,
  handlePromptPatch,
  handlePromptPut,
  handlePromptRestore,
  handlePromptUsageGet,
  handlePromptVersionGet,
  handlePromptsCreate,
  handlePromptsList,
} from "./handler.ts";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const idVersionParams = (id: string, version: string) => ({
  params: Promise.resolve({ id, version }),
});

test("list GET forwards to the worker and re-serializes status", async () => {
  const res = await handlePromptsList(
    new Request("https://dashboard.example.com/api/prompt-library"),
    async (path, init) => {
      assert.equal(path, "/api/v1/prompt-library");
      assert.equal(init?.method ?? "GET", "GET");
      return Response.json({ prompts: [] }, { status: 200 });
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { prompts: [] });
});

test("list GET preserves the q/tag/includeArchived query params", async () => {
  const calls: string[] = [];
  const res = await handlePromptsList(
    new Request(
      "https://dashboard.example.com/api/prompt-library?q=fix&tag=bug&includeArchived=true&stray=drop",
    ),
    async (path) => {
      calls.push(path);
      return Response.json({ prompts: [] }, { status: 200 });
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0], "/api/v1/prompt-library?q=fix&tag=bug&includeArchived=true");
});

test("create POST forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePromptsCreate(
    new Request("https://dashboard.example.com/api/prompt-library", {
      method: "POST",
      body: JSON.stringify({ name: "Bug triage", body: "Investigate {{ticket}}" }),
    }),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ statusMessage: "Name already in use" }, { status: 409 });
    },
  );
  assert.equal(res.status, 409);
  assert.equal(calls[0].path, "/api/v1/prompt-library");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    name: "Bug triage",
    body: "Investigate {{ticket}}",
  });
});

test("detail GET forwards the encoded id", async () => {
  const res = await handlePromptGet(idParams("12"), async (path, init) => {
    assert.equal(path, "/api/v1/prompt-library/12");
    assert.equal(init?.method, "GET");
    return Response.json({ meta: { id: 12 } }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { meta: { id: 12 } });
});

test("detail PUT forwards the JSON body and worker status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePromptPut(
    new Request("https://dashboard.example.com/api/prompt-library/12", {
      method: "PUT",
      body: JSON.stringify({ name: "Bug triage", body: "Updated body" }),
    }),
    idParams("12"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ error: "Invalid prompt" }, { status: 400 });
    },
  );
  assert.equal(res.status, 400);
  assert.equal(calls[0].path, "/api/v1/prompt-library/12");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    name: "Bug triage",
    body: "Updated body",
  });
});

test("detail PATCH forwards the JSON body", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePromptPatch(
    new Request("https://dashboard.example.com/api/prompt-library/12", {
      method: "PATCH",
      body: JSON.stringify({ tags: ["bug"] }),
    }),
    idParams("12"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ id: 12, tags: ["bug"] }, { status: 200 });
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/prompt-library/12");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { tags: ["bug"] });
});

test("detail DELETE forwards and re-serializes status", async () => {
  const res = await handlePromptDelete(idParams("12"), async (path, init) => {
    assert.equal(path, "/api/v1/prompt-library/12");
    assert.equal(init?.method, "DELETE");
    return Response.json({ ok: true }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("restore forwards to the nested worker path", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handlePromptRestore(
    new Request("https://dashboard.example.com/api/prompt-library/12/restore", {
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
  assert.equal(calls[0].path, "/api/v1/prompt-library/12/restore");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { version: 3 });
});

test("version GET forwards to the versions worker path", async () => {
  const res = await handlePromptVersionGet(idVersionParams("12", "3"), async (path, init) => {
    assert.equal(path, "/api/v1/prompt-library/12/versions/3");
    assert.equal(init?.method, "GET");
    return Response.json({ version: { version: 3 } }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: { version: 3 } });
});

test("usage GET forwards to the usage worker path", async () => {
  const res = await handlePromptUsageGet(idParams("12"), async (path, init) => {
    assert.equal(path, "/api/v1/prompt-library/12/usage");
    assert.equal(init?.method, "GET");
    return Response.json({ usage: [] }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { usage: [] });
});

test("list maps worker timeouts to 504", async () => {
  const res = await handlePromptsList(
    new Request("https://dashboard.example.com/api/prompt-library"),
    async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  );
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});

test("restore maps worker timeouts to 504", async () => {
  const res = await handlePromptRestore(
    new Request("https://dashboard.example.com/api/prompt-library/12/restore", {
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

test("a 204 from the worker passes through with an empty body", async () => {
  const res = await handlePromptDelete(idParams("12"), async () => new Response(null, { status: 204 }));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});

test("a non-numeric id is rejected with 404 without forwarding", async () => {
  let called = false;
  const res = await handlePromptGet(idParams(".."), async () => {
    called = true;
    return Response.json({}, { status: 200 });
  });
  assert.equal(res.status, 404);
  assert.equal(called, false);
});

test("a non-numeric version is rejected with 404 without forwarding", async () => {
  let called = false;
  const res = await handlePromptVersionGet(idVersionParams("12", ".."), async () => {
    called = true;
    return Response.json({}, { status: 200 });
  });
  assert.equal(res.status, 404);
  assert.equal(called, false);
});
