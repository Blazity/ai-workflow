import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDataCatalogEntry } from "@shared/contracts";
import { LoopFields } from "./loop-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const values: WorkflowDataCatalogEntry[] = [{
  reference: "steps.review.output",
  label: "Security review · Entire output",
  description: "The complete review result.",
  schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["approve", "request_changes"],
      },
    },
    required: ["decision"],
    additionalProperties: false,
  },
  source: { kind: "step", nodeId: "review" },
  presence: "required",
  availability: { state: "available", guarantee: "Guaranteed." },
  compatibleInputNames: [],
}];

test("shows named carried values without exposing canonical references", () => {
  const html = renderToStaticMarkup(
    <LoopFields
      configuration={{
        maxAttempts: 3,
        onExhaust: "fail",
        carry: [{
          name: "security_review",
          schema: values[0]!.schema,
          binding: {
            kind: "reference",
            reference: values[0]!.reference,
          },
        }],
      }}
      availableValues={values}
      valuesRefreshing={false}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(html, /Values for the next retry/);
  assert.match(html, /security_review/);
  assert.match(html, /Security review · Entire output/);
  assert.doesNotMatch(html, /steps\.review\.output/);
});

test("keeps an unavailable carried value visible for repair", () => {
  const html = renderToStaticMarkup(
    <LoopFields
      configuration={{
        carry: [{
          name: "old_review",
          schema: { type: "string" },
          binding: {
            kind: "reference",
            reference: "steps.old.output",
          },
        }],
      }}
      availableValues={values}
      valuesRefreshing={false}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(html, /saved value is unavailable/i);
  assert.doesNotMatch(html, /steps\.old\.output/);
});

test("ignores malformed carry entries and explains invalid names", () => {
  const html = renderToStaticMarkup(
    <LoopFields
      configuration={{
        carry: [
          { name: "broken" },
          {
            name: "review result",
            schema: { type: "string" },
            binding: {
              kind: "reference",
              reference: "steps.review.output",
            },
          },
        ],
      }}
      availableValues={values}
      valuesRefreshing={false}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.doesNotMatch(html, /broken/);
  assert.match(html, /safe value name/i);
});

test("explains duplicate carry names before deployment", () => {
  const entry = {
    name: "review",
    schema: { type: "string" as const },
    binding: {
      kind: "reference" as const,
      reference: "steps.review.output" as const,
    },
  };
  const html = renderToStaticMarkup(
    <LoopFields
      configuration={{ carry: [entry, entry] }}
      availableValues={values}
      valuesRefreshing={false}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(html, /unique name/i);
});
