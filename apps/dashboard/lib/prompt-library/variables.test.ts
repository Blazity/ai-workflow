import { test } from "node:test";
import assert from "node:assert/strict";
import { AVAILABLE_VARIABLES, segmentTemplate, usedVariables } from "./variables.ts";

test("segments a known variable with inner whitespace", () => {
  assert.deepEqual(segmentTemplate("Ticket {{ ticket_id }} here"), [
    { kind: "text", text: "Ticket " },
    { kind: "var", name: "ticket_id", known: false },
    { kind: "text", text: " here" },
  ]);
});

test("flags a known variable as known", () => {
  assert.deepEqual(segmentTemplate("{{ticket_key}}"), [
    { kind: "var", name: "ticket_key", known: true },
  ]);
});

test("flags an unknown variable", () => {
  assert.deepEqual(segmentTemplate("{{not_a_real_var}}"), [
    { kind: "var", name: "not_a_real_var", known: false },
  ]);
});

test("handles adjacent tokens with no text between them", () => {
  assert.deepEqual(segmentTemplate("{{ticket_key}}{{branch_name}}"), [
    { kind: "var", name: "ticket_key", known: true },
    { kind: "var", name: "branch_name", known: true },
  ]);
});

test("a token-free body is a single text segment", () => {
  assert.deepEqual(segmentTemplate("just plain text"), [
    { kind: "text", text: "just plain text" },
  ]);
});

test("an empty body has no segments", () => {
  assert.deepEqual(segmentTemplate(""), []);
});

test("usedVariables dedupes and preserves first-appearance order", () => {
  assert.deepEqual(
    usedVariables("{{branch_name}} then {{ticket_key}} then {{branch_name}} again"),
    [
      { name: "branch_name", known: true },
      { name: "ticket_key", known: true },
    ],
  );
});

test("usedVariables marks unknown names", () => {
  assert.deepEqual(usedVariables("{{mystery}}"), [{ name: "mystery", known: false }]);
});

test("AVAILABLE_VARIABLES exposes the shared catalog", () => {
  assert.ok(AVAILABLE_VARIABLES.some((v) => v.name === "ticket_key"));
});
