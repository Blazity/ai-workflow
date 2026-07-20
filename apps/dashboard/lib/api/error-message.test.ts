import { test } from "node:test";
import assert from "node:assert/strict";

import { messageFromErrorPayload, readErrorMessage } from "./error-message.ts";

test("messageFromErrorPayload ignores boolean error flags", () => {
  assert.equal(
    messageFromErrorPayload({
      error: true,
      statusCode: 503,
      statusMessage: "Email is not configured",
      message: "Email is not configured",
    }),
    "Email is not configured",
  );
});

test("messageFromErrorPayload prefers string error fields", () => {
  assert.equal(
    messageFromErrorPayload({ error: "User is already a member", message: "Conflict" }),
    "User is already a member",
  );
});

test("readErrorMessage preserves a useful plain-text worker response", async () => {
  assert.equal(
    await readErrorMessage(
      new Response("Draft changed; reload before saving", {
        status: 409,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    ),
    "Draft changed; reload before saving",
  );
});
