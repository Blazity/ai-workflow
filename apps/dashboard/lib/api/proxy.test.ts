// The route-handler transport to the worker: what a browser may learn from a
// refusal that passes through it.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

mock.module("server-only", { exports: {} } as unknown as Parameters<typeof mock.module>[1]);
mock.module("next/headers", {
  exports: { cookies: async () => ({ get: () => undefined }) },
} as unknown as Parameters<typeof mock.module>[1]);

// require, not a top-level import: the module has to load AFTER the mocks.
/* eslint-disable @typescript-eslint/no-require-imports */
const { proxyWorker } = require("./proxy") as typeof import("./proxy");
/* eslint-enable @typescript-eslint/no-require-imports */

const WORKER = "https://ai-workflow-app-eight.vercel.app";

function stubWorker(t: TestContext, answer: () => Response) {
  const original = globalThis.fetch;
  const base = process.env.WORKER_BASE_URL;
  process.env.WORKER_BASE_URL = WORKER;
  globalThis.fetch = (async () => answer()) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
    process.env.WORKER_BASE_URL = base;
  });
}

function captureErrors(t: TestContext): unknown[][] {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

test("a worker refusal reaches the browser without the worker's address", async (t) => {
  // The body Nitro answers every h3 error with: QA read the worker's URL in
  // the settings form's network tab.
  stubWorker(t, () =>
    Response.json(
      {
        error: true,
        url: `${WORKER}/api/v1/settings`,
        statusCode: 400,
        statusMessage: "Invalid settings: MAX_CONCURRENT_AGENTS (below_minimum)",
        message: "Invalid settings: MAX_CONCURRENT_AGENTS (below_minimum)",
      },
      { status: 400, statusText: "Bad Request" },
    ),
  );
  const logged = captureErrors(t);

  const response = await proxyWorker("/api/v1/settings", { method: "PATCH", body: "{}" });
  const text = await response.text();

  assert.equal(response.status, 400);
  assert.doesNotMatch(text, /ai-workflow-app-eight/, "the worker URL left the server");
  assert.deepEqual(JSON.parse(text), {
    error: true,
    statusCode: 400,
    statusMessage: "Invalid settings: MAX_CONCURRENT_AGENTS (below_minimum)",
    message: "Invalid settings: MAX_CONCURRENT_AGENTS (below_minimum)",
  });
  // The address stays where an operator can still find it: the server log.
  assert.ok(
    logged.some((line) => line.join(" ").includes(`${WORKER}/api/v1/settings`)),
    "the worker URL was dropped from the server log too",
  );
});

test("a success, and a refusal a route shaped itself, pass through untouched", async (t) => {
  const conflict = {
    error: "settings_version_conflict",
    conflicts: [{ key: "COLUMN_AI", expectedVersion: 0, currentVersion: 4 }],
  };
  stubWorker(t, () => Response.json(conflict, { status: 409 }));
  const refused = await proxyWorker("/api/v1/settings", { method: "PATCH", body: "{}" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), conflict);

  const settings = { settings: [{ key: "COLUMN_AI", value: "AI" }] };
  stubWorker(t, () => Response.json(settings));
  const read = await proxyWorker("/api/v1/settings");
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), settings);
});
