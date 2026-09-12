import assert from "node:assert/strict";
import test from "node:test";

import { handleSettingsGet, handleSettingsPatch } from "./handler";

test("the read forwards only the key parameter, and only when it is a key", async () => {
  const paths: string[] = [];
  const proxy = async (path: string) => {
    paths.push(path);
    return Response.json({ settings: [] });
  };

  await handleSettingsGet(
    new Request("https://dashboard.test/api/settings"),
    proxy,
  );
  await handleSettingsGet(
    new Request(
      "https://dashboard.test/api/settings?key=catalog.activated&unsafe=1",
    ),
    proxy,
  );
  await handleSettingsGet(
    new Request("https://dashboard.test/api/settings?key=../escape"),
    proxy,
  );

  assert.deepEqual(paths, [
    "/api/v1/settings",
    "/api/v1/settings?key=catalog.activated",
    "/api/v1/settings",
  ]);
});

test("the patch forwards the body untouched as a PATCH", async () => {
  const calls: Array<{ path: string; method: string | undefined; body: unknown }> =
    [];
  const proxy = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ settings: [], versions: [] });
  };

  await handleSettingsPatch(
    new Request("https://dashboard.test/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        settings: { MAX_CONCURRENT_AGENTS: 5 },
        reason: "more capacity",
      }),
    }),
    proxy,
  );

  assert.deepEqual(calls, [
    {
      path: "/api/v1/settings",
      method: "PATCH",
      body: { settings: { MAX_CONCURRENT_AGENTS: 5 }, reason: "more capacity" },
    },
  ]);
});

test("a refusal reaches the form with its status and message intact", async () => {
  const response = await handleSettingsPatch(
    new Request("https://dashboard.test/api/settings", {
      method: "PATCH",
      body: "{}",
    }),
    async () =>
      Response.json(
        { statusMessage: "Invalid settings: MAX_CONCURRENT_AGENTS (below_minimum)" },
        { status: 400 },
      ),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    statusMessage: "Invalid settings: MAX_CONCURRENT_AGENTS (below_minimum)",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a member's 403 is passed through rather than turned into an error page", async () => {
  const response = await handleSettingsPatch(
    new Request("https://dashboard.test/api/settings", {
      method: "PATCH",
      body: "{}",
    }),
    async () => Response.json({ statusMessage: "Forbidden" }, { status: 403 }),
  );

  assert.equal(response.status, 403);
});

test("a worker that never answers becomes a JSON timeout, not a crash", async () => {
  const timeout = await handleSettingsGet(
    new Request("https://dashboard.test/api/settings"),
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  );

  assert.equal(timeout.status, 504);
  assert.deepEqual(await timeout.json(), { error: "Worker request timed out" });
  assert.equal(timeout.headers.get("cache-control"), "no-store");
});
