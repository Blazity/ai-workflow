import assert from "node:assert/strict";
import { test } from "node:test";
import {
  textTemplateDocument,
  textTemplateValue,
} from "./workflow-text-template-editor.tsx";

test("plain text templates preserve lines and canonical workflow tokens", () => {
  const value = [
    "Review {{data:steps.review.output.decision}}",
    "",
    "Run {{data:run.id}} for {{data:steps.entry.output}}.",
  ].join("\n");

  assert.equal(textTemplateValue(textTemplateDocument(value)), value);
});

test("plain text templates preserve adjacent and repeated chips", () => {
  const value =
    "{{data:steps.first.output}}{{data:steps.second.output.value}}" +
    " / {{data:steps.first.output}}";

  assert.equal(textTemplateValue(textTemplateDocument(value)), value);
});

test("plain text templates leave malformed tokens as literal text", () => {
  const value = "Keep {{data:steps.plan.output.value open";

  assert.equal(textTemplateValue(textTemplateDocument(value)), value);
});
