// The dashboard half of the integrations API: which worker path each call
// reaches, what it is allowed to carry there, and what comes back when the
// worker refuses or never answers.
import assert from "node:assert/strict";
import test from "node:test";

import { INTEGRATION_PROVIDER_WAIT_MS } from "@shared/contracts";

import { PROVIDER_CALL_CEILING_MS } from "@/lib/integrations/provider-wait";

import {
  handleIntegrationConnectionDelete,
  handleIntegrationConnectionPut,
  handleIntegrationEnabledPatch,
  handleIntegrationSourcePatch,
  handleIntegrationTest,
  handleIntegrationsList,
} from "./handler";

interface Call {
  path: string;
  method: string | undefined;
  body: unknown;
  timeoutMs: number | undefined;
}

function recorder(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const proxy = async (path: string, init?: RequestInit, timeoutMs?: number) => {
    calls.push({
      path,
      method: init?.method,
      body: init?.body === undefined ? null : JSON.parse(String(init.body) || "null"),
      timeoutMs,
    });
    return response();
  };
  return { calls, proxy };
}

function request(method: string, payload: unknown): Request {
  return new Request("https://dashboard.test/api/integrations/demo/connection", {
    method,
    body: JSON.stringify(payload),
  });
}

test("every route forwards to its worker path with the body untouched", async () => {
  const { calls, proxy } = recorder(() => Response.json({}));

  await handleIntegrationsList(proxy);
  await handleIntegrationConnectionPut(
    "demo",
    request("PUT", { expectedVersion: 3, values: { baseUrl: "https://demo.test" }, clearSecrets: [] }),
    proxy,
  );
  await handleIntegrationTest("demo", proxy);
  await handleIntegrationEnabledPatch("demo", request("PATCH", { enabled: false }), proxy);
  await handleIntegrationSourcePatch("demo", request("PATCH", { source: "stored" }), proxy);
  await handleIntegrationConnectionDelete("demo", proxy);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "GET /api/v1/integrations",
      "PUT /api/v1/integrations/demo/connection",
      "POST /api/v1/integrations/demo/test",
      "PATCH /api/v1/integrations/demo/enabled",
      "PATCH /api/v1/integrations/demo/source",
      "DELETE /api/v1/integrations/demo/connection",
    ],
  );
  assert.deepEqual(calls[1]!.body, {
    expectedVersion: 3,
    values: { baseUrl: "https://demo.test" },
    clearSecrets: [],
  });
  assert.equal(calls[2]!.body, null, "a test carries no body: it tests what is live");
});

test("the two calls that wait on a provider outlive the worker's own test ceiling", async () => {
  // The worker bounds a connection test at INTEGRATION_PROVIDER_WAIT_MS. A
  // proxy that gave up at its 10 second default would hand the admin a
  // failure that never happened.
  const { calls, proxy } = recorder(() => Response.json({}));
  await handleIntegrationConnectionPut("demo", request("PUT", {}), proxy);
  await handleIntegrationTest("demo", proxy);

  assert.ok(PROVIDER_CALL_CEILING_MS > INTEGRATION_PROVIDER_WAIT_MS);
  assert.equal(calls[0]!.timeoutMs, PROVIDER_CALL_CEILING_MS);
  assert.equal(calls[1]!.timeoutMs, PROVIDER_CALL_CEILING_MS);
});

test("the calls that contact nothing keep the default ceiling", async () => {
  const { calls, proxy } = recorder(() => Response.json({}));
  await handleIntegrationsList(proxy);
  await handleIntegrationEnabledPatch("demo", request("PATCH", { enabled: true }), proxy);

  assert.deepEqual(
    calls.map((call) => call.timeoutMs),
    [undefined, undefined],
  );
});

test("an id that is not an integration id never reaches the worker", async () => {
  const { calls, proxy } = recorder(() => Response.json({}));
  for (const id of ["../runs", "Demo", "de", "a".repeat(40), "9demo", "demo/x"]) {
    const response = await handleIntegrationTest(id, proxy);
    assert.equal(response.status, 400, `${id} must be refused here`);
  }
  assert.deepEqual(calls, [], "a hostile segment must not be able to build a worker path");
});

test("the worker's refusal is what the screen gets, status and body", async () => {
  const conflict = { error: "integration_version_conflict", currentVersion: 7 };
  const { proxy } = recorder(() => Response.json(conflict, { status: 409 }));
  const response = await handleIntegrationConnectionPut("demo", request("PUT", {}), proxy);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), conflict);
});

test("a deployment refused its write keeps the worker's own sentence", async () => {
  const refusal = { statusMessage: "This deployment runs as preview; the database is production's" };
  const { proxy } = recorder(() => Response.json(refusal, { status: 403 }));
  const response = await handleIntegrationEnabledPatch(
    "demo",
    request("PATCH", { enabled: false }),
    proxy,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), refusal);
});

test("a worker that never answers becomes a 504 rather than an unhandled rejection", async () => {
  const proxy = async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  };
  const response = await handleIntegrationTest("demo", proxy);

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Worker request timed out" });
});
