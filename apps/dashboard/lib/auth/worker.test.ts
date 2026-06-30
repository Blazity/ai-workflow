import { test } from "node:test";
import assert from "node:assert/strict";

test("fetchAuthWorker returns null when WORKER_BASE_URL is missing", async () => {
  const { fetchWorker } = await import("./worker-core.ts");
  const res = await fetchWorker(undefined, "/api/v1/session");
  assert.equal(res, null);
});
