import assert from "node:assert/strict";
import test from "node:test";

import {
  handleRunAttemptGet,
  handleRunReplayGet,
} from "./replay-handler";

const runContext = (runId: string) => ({
  params: Promise.resolve({ runId }),
});
const attemptContext = (runId: string, attemptId: string) => ({
  params: Promise.resolve({ runId, attemptId }),
});

test("replay proxy clamps pagination and preserves an opaque cursor", async () => {
  const calls: string[] = [];
  const response = await handleRunReplayGet(
    new Request(
      "https://dashboard.test/api/runs/wrun_1/replay?limit=500&cursor=next%2Fpage",
    ),
    runContext("wrun_1"),
    async (path, init) => {
      calls.push(`${init?.method}:${path}`);
      return Response.json({ availability: "available", attempts: [] });
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "GET:/api/v1/runs/wrun_1/replay?limit=200&cursor=next%2Fpage",
  ]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("replay proxy defaults missing, invalid, and non-positive limits to 100", async () => {
  for (const suffix of ["", "?limit=nope", "?limit=0", "?limit=-4"]) {
    const calls: string[] = [];
    await handleRunReplayGet(
      new Request(`https://dashboard.test/api/runs/wrun_1/replay${suffix}`),
      runContext("wrun_1"),
      async (path) => {
        calls.push(path);
        return Response.json({ availability: "not_captured" });
      },
    );
    assert.deepEqual(calls, ["/api/v1/runs/wrun_1/replay?limit=100"]);
  }
});

test("attempt proxy forwards the exact run and attempt", async () => {
  const calls: string[] = [];
  const response = await handleRunAttemptGet(
    attemptContext("wrun:1", "attempt-2"),
    async (path) => {
      calls.push(path);
      return Response.json({ attempt: { id: "attempt-2" } });
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "/api/v1/runs/wrun%3A1/attempts/attempt-2",
  ]);
});

test("invalid path identifiers are rejected without reaching the worker", async () => {
  let called = false;
  const response = await handleRunAttemptGet(
    attemptContext("../outside", "attempt-1"),
    async () => {
      called = true;
      return Response.json({});
    },
  );

  assert.equal(response.status, 404);
  assert.equal(called, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("worker timeouts become no-store JSON 504 responses", async () => {
  const response = await handleRunReplayGet(
    new Request("https://dashboard.test/api/runs/wrun_1/replay"),
    runContext("wrun_1"),
    async () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
  );

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "Worker request timed out",
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
