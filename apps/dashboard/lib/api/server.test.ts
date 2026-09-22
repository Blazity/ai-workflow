// The server-side worker read: what a refusal carries back to the page, and
// how long a read that waits on a provider is allowed to take.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

mock.module("server-only", { exports: {} } as unknown as Parameters<typeof mock.module>[1]);
mock.module("next/headers", {
  exports: { cookies: async () => ({ get: () => undefined }) },
} as unknown as Parameters<typeof mock.module>[1]);

// require, not a top-level import: the module has to load AFTER the mocks.
/* eslint-disable @typescript-eslint/no-require-imports */
const { getJSON } = require("./server") as typeof import("./server");
const { WorkerResponseError } =
  require("./worker-response-error") as typeof import("./worker-response-error");
/* eslint-enable @typescript-eslint/no-require-imports */

function stubFetch(t: TestContext, answer: (init: RequestInit | undefined) => Promise<Response>) {
  const original = globalThis.fetch;
  const base = process.env.WORKER_BASE_URL;
  process.env.WORKER_BASE_URL = "http://worker.test";
  globalThis.fetch = ((_url: string, init?: RequestInit) => answer(init)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
    process.env.WORKER_BASE_URL = base;
  });
}

test("a refusal carries the worker's sentence from the body, where it survives", async (t) => {
  // The shape Nitro answers an h3 error with. The reason phrase is empty, as
  // it is over HTTP/2, and would have lost the curly quotes to h3's
  // visible-ASCII rule over HTTP/1.1 anyway.
  const sentence = "Built-in memory could not answer: the store said “busy”";
  stubFetch(t, async () =>
    new Response(
      JSON.stringify({ error: true, statusCode: 503, statusMessage: sentence, message: sentence }),
      { status: 503, statusText: "", headers: { "content-type": "application/json" } },
    ),
  );

  const thrown = await getJSON("/api/v1/memory").then(
    () => assert.fail("a 503 must not resolve"),
    (error: unknown) => error,
  );

  assert.ok(thrown instanceof WorkerResponseError);
  assert.equal(thrown.status, 503);
  assert.equal(thrown.reason, sentence);
});

test("a read that waits on a provider is given the time it asks for, not the default", async (t) => {
  // A fetch that answers only when its signal gives up, so the only thing
  // that ends it is the timeout this read asked for.
  stubFetch(
    t,
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
  );

  const started = Date.now();
  const thrown = await getJSON("/api/v1/integrations/demo/pages/activity", { timeoutMs: 25 }).then(
    () => assert.fail("nothing answered, so the read must give up"),
    (error: unknown) => error,
  );

  assert.equal((thrown as { name?: unknown }).name, "TimeoutError");
  assert.ok(Date.now() - started < 5_000, "it gave up at the wait it was given, not at the 10 s default");
});
