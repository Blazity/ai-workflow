import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleApprovalApprove,
  handleApprovalReject,
} from "./handler.ts";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

test("approve POST forwards to the worker approve path and status", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleApprovalApprove(idParams("ap_1"), async (path, init) => {
    calls.push({ path, init: init ?? {} });
    return Response.json({ approval: { id: "ap_1", status: "approved" }, runId: "run_9" }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/approvals/ap_1/approve");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(await res.json(), {
    approval: { id: "ap_1", status: "approved" },
    runId: "run_9",
  });
});

test("approve POST surfaces the worker conflict status and message", async () => {
  const res = await handleApprovalApprove(idParams("ap_1"), async () =>
    Response.json({ statusMessage: "already_decided" }, { status: 409 }),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { statusMessage: "already_decided" });
});

test("reject POST forwards to the worker reject path with an encoded id", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleApprovalReject(idParams("ap 2"), async (path, init) => {
    calls.push({ path, init: init ?? {} });
    return Response.json({ approval: { id: "ap 2", status: "rejected" } }, { status: 200 });
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/approvals/ap%202/reject");
  assert.equal(calls[0].init.method, "POST");
});

test("approve maps worker timeouts to 504", async () => {
  const res = await handleApprovalApprove(idParams("ap_1"), async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
