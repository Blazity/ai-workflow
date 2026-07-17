import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleApprovalApprove,
  handleApprovalReject,
  handleApprovalsList,
} from "./handler.ts";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

test("list GET forwards to the worker and re-serializes status", async () => {
  const res = await handleApprovalsList(
    new Request("https://dashboard.example.com/api/approvals"),
    async (path, init) => {
      assert.equal(path, "/api/v1/approvals");
      assert.equal(init?.method ?? "GET", "GET");
      return Response.json({ generatedAt: "2026-07-13T00:00:00.000Z", approvals: [] }, { status: 200 });
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { generatedAt: "2026-07-13T00:00:00.000Z", approvals: [] });
});

test("list GET forwards the status filter", async () => {
  const calls: string[] = [];
  await handleApprovalsList(
    new Request("https://dashboard.example.com/api/approvals?status=all"),
    async (path) => {
      calls.push(path);
      return Response.json({ generatedAt: "t", approvals: [] }, { status: 200 });
    },
  );
  assert.equal(calls[0], "/api/v1/approvals?status=all");
});

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
