// apps/dashboard/app/api/runs/briefings-handler.test.ts
//
// This proxy is the only way a browser reaches the worker's briefing routes.
// What it must never do: build a worker path out of something the caller
// wrote, or pass a parameter the route does not take. What it must always do:
// carry a real read through unchanged, and turn a silent worker into a 504.
import assert from "node:assert/strict";
import test from "node:test";

import { handleBriefingsGet } from "./briefings-handler";

const context = (runId: string, path?: string[]) => ({ params: Promise.resolve({ runId, path }) });

async function forwarded(url: string, runId: string, path?: string[]) {
  const calls: string[] = [];
  const response = await handleBriefingsGet(new Request(url), context(runId, path), async (workerPath) => {
    calls.push(workerPath);
    return Response.json({ schemaVersion: 1, items: [], cursor: null, nextCursor: null, total: 0 });
  });
  return { calls, response };
}

test("the attempt's sends are asked for with exactly the attempt's three keys", async () => {
  const { calls, response } = await forwarded(
    "https://dashboard.test/api/runs/wrun_1/briefings?nodeId=planning&attempt=2&activationScopeId=loop.3&cursor=abc",
    "wrun_1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "/api/v1/runs/wrun_1/briefings?nodeId=planning&attempt=2&activationScopeId=loop.3&cursor=abc",
  ]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("a section page, its parts and its redaction spans each reach their own route", async () => {
  const text = await forwarded(
    "https://dashboard.test/api/runs/wrun_1/briefings/brf_1/sections/4?offset=49152&limit=49152",
    "wrun_1",
    ["brf_1", "sections", "4"],
  );
  assert.deepEqual(text.calls, ["/api/v1/runs/wrun_1/briefings/brf_1/sections/4?offset=49152&limit=49152"]);

  const parts = await forwarded(
    "https://dashboard.test/api/runs/wrun_1/briefings/brf_1/sections/4/parts",
    "wrun_1",
    ["brf_1", "sections", "4", "parts"],
  );
  assert.deepEqual(parts.calls, ["/api/v1/runs/wrun_1/briefings/brf_1/sections/4/parts"]);

  const spans = await forwarded(
    "https://dashboard.test/api/runs/wrun_1/briefings/brf_1/sections/4/spans?cursor=p2",
    "wrun_1",
    ["brf_1", "sections", "4", "spans"],
  );
  assert.deepEqual(spans.calls, ["/api/v1/runs/wrun_1/briefings/brf_1/sections/4/spans?cursor=p2"]);
});

test("a path this route does not serve never reaches the worker", async () => {
  for (const path of [
    ["brf_1", "everything"],
    ["brf_1", "sections", "4", "everything"],
    ["brf_1", "sections", "../../secrets"],
    ["../../runs", "sections", "1"],
    ["brf_1", "sections", "4", "parts", "1"],
  ]) {
    let called = false;
    const response = await handleBriefingsGet(
      new Request("https://dashboard.test/api/runs/wrun_1/briefings"),
      context("wrun_1", path),
      async () => {
        called = true;
        return Response.json({});
      },
    );
    assert.equal(response.status, 404, `${path.join("/")} was not refused`);
    assert.equal(called, false, `${path.join("/")} reached the worker`);
  }
});

test("a run id that is not an identifier is refused before the worker is called", async () => {
  let called = false;
  const response = await handleBriefingsGet(
    new Request("https://dashboard.test/api/runs/x/briefings"),
    context("../../v1/settings"),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(response.status, 404);
  assert.equal(called, false);
});

test("a parameter the route does not take is dropped, and a malformed one is refused", async () => {
  const { calls } = await forwarded(
    "https://dashboard.test/api/runs/wrun_1/briefings?nodeId=planning&offset=10&subjectKey=ticket%3Ajira%3AX",
    "wrun_1",
  );
  assert.deepEqual(calls, ["/api/v1/runs/wrun_1/briefings?nodeId=planning"]);

  let called = false;
  const refused = await handleBriefingsGet(
    new Request("https://dashboard.test/api/runs/wrun_1/briefings?attempt=2%3B%20drop"),
    context("wrun_1"),
    async () => {
      called = true;
      return Response.json({});
    },
  );
  assert.equal(refused.status, 400);
  assert.equal(called, false);
  assert.deepEqual(await refused.json(), { error: "attempt is not a value this route takes" });
});

test("the worker's own status and body come back unchanged", async () => {
  const response = await handleBriefingsGet(
    new Request("https://dashboard.test/api/runs/wrun_1/briefings"),
    context("wrun_1"),
    async () => Response.json({ error: "run not found" }, { status: 404 }),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "run not found" });
});

test("a worker that does not answer in time is a 504, not a crash", async () => {
  const response = await handleBriefingsGet(
    new Request("https://dashboard.test/api/runs/wrun_1/briefings"),
    context("wrun_1"),
    async () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Worker request timed out" });
});
