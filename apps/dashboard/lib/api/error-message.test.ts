import { test } from "node:test";
import assert from "node:assert/strict";

import { messageFromErrorPayload } from "./error-message.ts";

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
