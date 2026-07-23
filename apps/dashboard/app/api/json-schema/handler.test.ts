import assert from "node:assert/strict";
import test from "node:test";
import { handleJsonSchemaInspect } from "./handler.ts";

test("schema inspection forwards the exact source and preserves no-store", async () => {
  const source = '{ "type": "string" }';
  const response = await handleJsonSchemaInspect(
    new Request("https://dashboard.example.com/api/json-schema/inspect", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
    async (path, init) => {
      assert.equal(path, "/api/v1/json-schema/inspect");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { source });
      return Response.json({
        deployable: true,
        dialect: "https://json-schema.org/draft/2020-12/schema",
        schema: { type: "string" },
        valueSchema: { type: "string" },
        issues: [],
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    deployable: true,
    dialect: "https://json-schema.org/draft/2020-12/schema",
    schema: { type: "string" },
    valueSchema: { type: "string" },
    issues: [],
  });
});

test("schema inspection maps worker timeouts to 504", async () => {
  const response = await handleJsonSchemaInspect(
    new Request("https://dashboard.example.com/api/json-schema/inspect", {
      method: "POST",
      body: "{}",
    }),
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "Worker request timed out",
  });
});
