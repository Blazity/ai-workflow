import { test } from "node:test";
import assert from "node:assert/strict";

import { handleClarificationAnswer } from "./handler.ts";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

const answerRequest = (answer: string) =>
  new Request("https://dashboard.example.com/api/clarifications/cl_1/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });

test("answer POST forwards to the worker answer path, method and body", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const res = await handleClarificationAnswer(
    answerRequest("use option A"),
    idParams("cl_1"),
    async (path, init) => {
      calls.push({ path, init: init ?? {} });
      return Response.json(
        { clarification: { id: "cl_1", status: "answered" }, runId: "run_9" },
        { status: 200 },
      );
    },
  );
  assert.equal(res.status, 200);
  assert.equal(calls[0].path, "/api/v1/clarifications/cl_1/answer");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { answer: "use option A" });
  assert.deepEqual(await res.json(), {
    clarification: { id: "cl_1", status: "answered" },
    runId: "run_9",
  });
});

test("answer POST surfaces the worker conflict status and message", async () => {
  const res = await handleClarificationAnswer(
    answerRequest("x"),
    idParams("cl_1"),
    async () => Response.json({ statusMessage: "already_answered" }, { status: 409 }),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { statusMessage: "already_answered" });
});

test("answer POST surfaces the worker gone status", async () => {
  const res = await handleClarificationAnswer(
    answerRequest("x"),
    idParams("cl_1"),
    async () => Response.json({ statusMessage: "ticket_gone" }, { status: 410 }),
  );
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), { statusMessage: "ticket_gone" });
});

test("answer POST forwards an encoded id", async () => {
  const calls: string[] = [];
  await handleClarificationAnswer(answerRequest("x"), idParams("cl 2"), async (path) => {
    calls.push(path);
    return Response.json({ clarification: { id: "cl 2" }, runId: null }, { status: 200 });
  });
  assert.equal(calls[0], "/api/v1/clarifications/cl%202/answer");
});

test("answer maps worker timeouts to 504", async () => {
  const res = await handleClarificationAnswer(answerRequest("x"), idParams("cl_1"), async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: "Worker request timed out" });
});
