import assert from "node:assert/strict";
import { test } from "node:test";
import {
  textTemplateDocument,
  textTemplateValue,
} from "./workflow-text-template-editor.tsx";
import { textTemplateCompatibility } from "./workflow-data-picker.tsx";

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

test("mixed text accepts required numbers and explains optional values precisely", () => {
  assert.deepEqual(
    textTemplateCompatibility({
      reference: "steps.open.output.prNumber",
      label: "Open pull request · prNumber",
      description: "Primary pull request number.",
      schema: { type: "number" },
      source: { kind: "step", nodeId: "open" },
      presence: "required",
      availability: { state: "available", guarantee: "Guaranteed." },
      compatibleInputNames: [],
    }),
    { compatible: true },
  );
  const optional = textTemplateCompatibility({
    reference: "steps.maybe.output.count",
    label: "Maybe · count",
    description: "Optional count.",
    schema: { type: "number" },
    source: { kind: "step", nodeId: "maybe" },
    presence: "optional",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: [],
  });
  assert.equal(
    optional.compatible ? null : optional.reason.code,
    "presence_optional",
  );
});
