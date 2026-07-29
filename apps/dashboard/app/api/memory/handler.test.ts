import { test } from "node:test";
import assert from "node:assert/strict";

import { handleMemoryDelete } from "./handler.ts";

function request(query: string): Request {
  return new Request(`https://dashboard.example.com/api/memory${query}`, {
    method: "DELETE",
  });
}

test("DELETE forwards the document key to the worker memory endpoint", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleMemoryDelete(
    request("?subjectKey=ticket%3Ajira%3AAIW-177&docPath=blazebot%2Fmemory%2FAIW-177.md"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json({ deleted: true }, { status: 200 });
    },
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    "/api/v1/memory?subjectKey=ticket%3Ajira%3AAIW-177&docPath=blazebot%2Fmemory%2FAIW-177.md",
  );
  assert.equal(calls[0].init.method, "DELETE");
});

test("DELETE re-encodes a key carrying query and SQL metacharacters", async () => {
  const calls: string[] = [];
  await handleMemoryDelete(
    request(
      `?subjectKey=${encodeURIComponent("a&docPath=x' OR 1=1 --")}&docPath=${encodeURIComponent("b.md")}`,
    ),
    async (path) => {
      calls.push(path);
      return Response.json({ deleted: true }, { status: 200 });
    },
  );

  // The injected `docPath=` stays inside the subjectKey parameter, so the
  // worker still sees exactly the two values the browser sent.
  assert.equal(
    calls[0],
    "/api/v1/memory?subjectKey=a%26docPath%3Dx'%20OR%201%3D1%20--&docPath=b.md",
  );
  const forwarded = new URL(`https://worker.test${calls[0]}`).searchParams;
  assert.equal(forwarded.get("subjectKey"), "a&docPath=x' OR 1=1 --");
  assert.equal(forwarded.get("docPath"), "b.md");
});

test("DELETE rejects a half key without calling the worker", async () => {
  let called = false;
  const proxy = async () => {
    called = true;
    return Response.json({}, { status: 200 });
  };

  assert.equal((await handleMemoryDelete(request("?subjectKey=s"), proxy)).status, 400);
  assert.equal((await handleMemoryDelete(request("?docPath=d"), proxy)).status, 400);
  assert.equal((await handleMemoryDelete(request(""), proxy)).status, 400);
  assert.equal(called, false);
});

test("DELETE surfaces the worker not-found status and message", async () => {
  const res = await handleMemoryDelete(request("?subjectKey=s&docPath=d"), async () =>
    Response.json({ statusMessage: "Memory document not found" }, { status: 404 }),
  );

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { statusMessage: "Memory document not found" });
});

test("DELETE surfaces the worker forbidden status for a member", async () => {
  const res = await handleMemoryDelete(request("?subjectKey=s&docPath=d"), async () =>
    Response.json({ statusMessage: "Forbidden" }, { status: 403 }),
  );

  assert.equal(res.status, 403);
});

test("DELETE maps worker timeouts to 504", async () => {
  const res = await handleMemoryDelete(request("?subjectKey=s&docPath=d"), async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
