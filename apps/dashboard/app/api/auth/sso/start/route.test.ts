import { test } from "node:test";
import assert from "node:assert/strict";

test("SSO start redirects the browser to the worker start endpoint", async () => {
  process.env.WORKER_BASE_URL = "https://worker.example.com";
  const { GET } = await import("./route.ts");

  const res = await GET(
    new Request("https://dashboard.example.com/api/auth/sso/start?inviteId=invite_1"),
  );

  assert.equal(res.status, 307);
  assert.equal(
    res.headers.get("location"),
    "https://worker.example.com/api/dashboard-auth/sso/start?inviteId=invite_1",
  );
});
