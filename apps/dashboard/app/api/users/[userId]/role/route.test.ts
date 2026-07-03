import { test } from "node:test";
import assert from "node:assert/strict";

import { handleUserRolePatch } from "./handler.ts";

test("role changes return a JSON 504 when the worker proxy times out", async () => {
  const res = await handleUserRolePatch(
    new Request("https://dashboard.example.com/api/users/user_1/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    }),
    { params: Promise.resolve({ userId: "user_1" }) },
    async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  );

  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});

test("role changes forward the target user id and JSON body to the worker", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];

  const res = await handleUserRolePatch(
    new Request("https://dashboard.example.com/api/users/user_1/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    }),
    { params: Promise.resolve({ userId: "user 1" }) },
    async (path, init) => {
      calls.push({ path, init });
      return Response.json({ userId: "user 1", role: "member" }, { status: 200 });
    },
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { userId: "user 1", role: "member" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/v1/users/user%201/role");
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { role: "member" });
  assert.deepEqual(
    Object.fromEntries(new Headers(calls[0].init.headers).entries()),
    { "content-type": "application/json" },
  );
});
