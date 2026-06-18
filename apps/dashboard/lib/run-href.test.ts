import { test } from "node:test";
import assert from "node:assert/strict";
import { runHref } from "./run-href";

test("a ticketed run opens the ticket view with the run selected", () => {
  assert.equal(
    runHref({ id: "wrun_1", ticket: "AWT-738" }),
    "/ticket/AWT-738?run=wrun_1",
  );
});

test("a ticketless gate run falls back to the standalone trace", () => {
  assert.equal(runHref({ id: "wrun_2", ticket: "" }), "/trace/wrun_2");
});
