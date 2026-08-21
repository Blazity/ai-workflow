import assert from "node:assert/strict";
import test from "node:test";
import { handleSystemHealthScan } from "./handler";

test("active health scan forwards POST with the extended timeout", async () => {
  const calls: unknown[][] = [];
  const response = await handleSystemHealthScan(async (...args) => {
    calls.push(args);
    return Response.json({ generatedAt: "2026-08-21T12:00:00.000Z" }, { status: 200 });
  });

  assert.deepEqual(calls, [
    ["/api/v1/system/health", { method: "POST" }, 15_000],
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("active health scan preserves worker errors", async () => {
  const response = await handleSystemHealthScan(async () =>
    Response.json({ error: "Forbidden" }, { status: 403 }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("active health scan reports worker timeouts", async () => {
  const response = await handleSystemHealthScan(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "System health scan timed out" });
});
