// How long the platform lets the Save and Test routes live, against how long
// they wait on the worker for a provider.
//
// Beside `[id]/` rather than inside it: a test file under a dynamic-route
// directory is never run, because the runner reads the brackets as a character
// class.
import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("server-only", { exports: {} } as unknown as Parameters<typeof mock.module>[1]);
mock.module("../../../lib/api/proxy.ts", {
  exports: { proxyWorker: async () => new Response(null) },
} as unknown as Parameters<typeof mock.module>[1]);

// require, not a top-level import: the modules have to load AFTER the mocks.
/* eslint-disable @typescript-eslint/no-require-imports */
const { PROVIDER_CALL_CEILING_MS } =
  require("../../../lib/integrations/provider-wait") as typeof import("../../../lib/integrations/provider-wait");
const connection = require("./[id]/connection/route") as { maxDuration?: number };
const connectionTest = require("./[id]/test/route") as { maxDuration?: number };
/* eslint-enable @typescript-eslint/no-require-imports */

test("Save and Test outlive the wait on the provider, so the answer an admin reads is the worker's", () => {
  // Raise the provider wait past these and the platform kills the route while
  // the worker is still answering: the admin reads a proxy failure instead of
  // the provider's verdict.
  for (const [route, config] of [
    ["connection", connection],
    ["test", connectionTest],
  ] as const) {
    assert.equal(typeof config.maxDuration, "number", `${route} declares its ceiling`);
    assert.ok(
      config.maxDuration! * 1000 > PROVIDER_CALL_CEILING_MS,
      `${route} lives ${config.maxDuration} s, not longer than the ${PROVIDER_CALL_CEILING_MS} ms it waits`,
    );
  }
});
