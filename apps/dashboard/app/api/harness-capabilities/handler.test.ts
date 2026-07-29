import assert from "node:assert/strict";
import test from "node:test";
import { handleHarnessCapabilitiesGet } from "./handler";

test("capability proxy forwards only normalized supported query values", async () => {
  const paths: string[] = [];
  const response = await handleHarnessCapabilitiesGet(
    new Request(
      "https://dashboard.test/api/harness-capabilities?provider=codex&cliVersion=0.144.6&refresh=1&unsafe=value",
    ),
    async (path, init) => {
      paths.push(`${init?.method}:${path}`);
      return Response.json({ stale: false }, { status: 200 });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(paths, [
    "GET:/api/v1/harness-capabilities?provider=codex&cliVersion=0.144.6&refresh=true",
  ]);
});

test("capability proxy rejects invalid requests and preserves worker failures", async () => {
  let forwarded = false;
  const invalid = await handleHarnessCapabilitiesGet(
    new Request(
      "https://dashboard.test/api/harness-capabilities?provider=other&cliVersion=latest",
    ),
    async () => {
      forwarded = true;
      return Response.json({});
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(forwarded, false);

  const failure = await handleHarnessCapabilitiesGet(
    new Request(
      "https://dashboard.test/api/harness-capabilities?provider=claude&cliVersion=2.1.216",
    ),
    async () => Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "Unavailable" });

  const timeout = await handleHarnessCapabilitiesGet(
    new Request(
      "https://dashboard.test/api/harness-capabilities?provider=claude&cliVersion=2.1.216",
    ),
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  );
  assert.equal(timeout.status, 504);
});
