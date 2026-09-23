// How long a contributed page waits for its data, measured against how long
// the worker gives the provider.
//
// Beside `[id]/` rather than inside it: a test file under a dynamic-route
// directory is never run, because the runner reads the brackets as a character
// class (see integration-area.test.tsx).
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { INTEGRATION_PROVIDER_WAIT_MS } from "@shared/contracts";

const seen: { path: string; timeoutMs: number | undefined }[] = [];
let reply: () => Promise<unknown> = async () => ({ status: "none" });

mock.module("server-only", { exports: {} } as unknown as Parameters<typeof mock.module>[1]);
mock.module("../../../lib/api/server.ts", {
  exports: {
    getJSON: async (path: string, options?: { timeoutMs?: number }) => {
      seen.push({ path, timeoutMs: options?.timeoutMs });
      return reply();
    },
    // The real one redirects on 401 and rethrows 403; neither is under test.
    authAwareFallback: (_error: unknown, fallback: () => unknown) => fallback(),
  },
} as unknown as Parameters<typeof mock.module>[1]);
mock.module("./contributed-page.tsx", {
  exports: { ContributedPage: () => null },
} as unknown as Parameters<typeof mock.module>[1]);

// require, not a top-level import: the modules have to load AFTER the mocks.
/* eslint-disable @typescript-eslint/no-require-imports */
const { readContributedPageData } =
  require("../../../lib/integrations/page-data") as typeof import("../../../lib/integrations/page-data");
const { PROVIDER_CALL_CEILING_MS } =
  require("../../../lib/integrations/provider-wait") as typeof import("../../../lib/integrations/provider-wait");
const { maxDuration } = require("./[id]/[page]/page") as { maxDuration?: number };
/* eslint-enable @typescript-eslint/no-require-imports */

test("a contributed page waits longer for its data than the worker waits on the provider", async () => {
  // Seen in review: the dashboard gave up at its 10 second default while the
  // worker gave the provider 20, so a provider answering in 15 seconds was
  // shown to the person as our worker's outage.
  seen.length = 0;
  reply = async () => ({ status: "ok", value: { graded: 3 } });

  const data = await readContributedPageData("demo", "activity");

  assert.deepEqual(data, { status: "ok", value: { graded: 3 } });
  assert.equal(seen.length, 1);
  assert.ok(
    (seen[0]!.timeoutMs ?? 0) > INTEGRATION_PROVIDER_WAIT_MS,
    `waited ${seen[0]!.timeoutMs} ms for a call the worker may spend ${INTEGRATION_PROVIDER_WAIT_MS} ms on`,
  );
});

test("the page's route lives longer than the wait it makes", () => {
  // Raising the shared budget without raising this is a page the platform
  // kills before the worker could say what the provider did.
  assert.ok(
    (maxDuration ?? 0) * 1000 > PROVIDER_CALL_CEILING_MS,
    `maxDuration ${maxDuration} s against a ${PROVIDER_CALL_CEILING_MS} ms wait`,
  );
});

test("a worker that outran even that wait is reported as ours, with the wait it had", async () => {
  reply = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };

  const data = await readContributedPageData("demo", "activity");

  assert.equal(data.status, "unavailable");
  assert.equal(data.status === "unavailable" && data.cause, "worker");
  assert.match(
    data.status === "unavailable" ? data.reason : "",
    new RegExp(`did not answer within ${PROVIDER_CALL_CEILING_MS / 1000} seconds`),
  );
});

test("a provider the worker could not read reaches the page as the provider's failure", async () => {
  // The positive control: the answer that the longer wait exists to let through.
  reply = async () => ({ status: "unavailable", cause: "provider", reason: "503 from the engine" });

  const data = await readContributedPageData("demo", "activity");

  assert.deepEqual(data, { status: "unavailable", cause: "provider", reason: "503 from the engine" });
});
