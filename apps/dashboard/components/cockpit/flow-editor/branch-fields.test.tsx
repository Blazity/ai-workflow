import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDataCatalogEntry } from "@shared/contracts";
import { BranchFields } from "./branch-fields";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const values: WorkflowDataCatalogEntry[] = [{
  reference: "steps.review.output.decision",
  label: "Review · decision",
  description: "Review decision",
  schema: { type: "string", enum: ["approve", "request_changes"] },
  source: { kind: "step", nodeId: "review" },
  presence: "required",
  availability: { state: "available", guarantee: "Guaranteed." },
  compatibleInputNames: [],
}];

test("renders a flat condition with one global combinator", () => {
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{
        combinator: "all",
        conditions: [{
          reference: "steps.review.output.decision",
          operator: "equals",
          value: "approve",
        }],
      }}
      availableValues={values}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /all conditions \(AND\)/);
  assert.match(html, /Review · decision/);
  assert.match(html, /request_changes/);
  assert.doesNotMatch(html, /Outcomes/);
});

test("preserves an unavailable selected value without raw reference text", () => {
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{
        combinator: "all",
        conditions: [{
          reference: "steps.old.output.value",
          operator: "equals",
          value: "x",
        }],
      }}
      availableValues={values}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /saved value is unavailable/i);
  assert.doesNotMatch(html, /steps\.old\.output\.value/);
});

test("allows optional values only for presence operators", () => {
  const optionalValues: WorkflowDataCatalogEntry[] = [{
    ...values[0]!,
    presence: "optional",
  }];
  const comparisonHtml = renderToStaticMarkup(
    <BranchFields
      configuration={{
        combinator: "all",
        conditions: [{
          reference: "steps.review.output.decision",
          operator: "equals",
          value: "approve",
        }],
      }}
      availableValues={optionalValues}
      canEdit
      onChange={() => undefined}
    />,
  );
  const presenceHtml = renderToStaticMarkup(
    <BranchFields
      configuration={{
        combinator: "all",
        conditions: [{
          reference: "steps.review.output.decision",
          operator: "has_value",
        }],
      }}
      availableValues={optionalValues}
      canEdit
      onChange={() => undefined}
    />,
  );

  assert.match(
    comparisonHtml,
    /This value is not present on every path that reaches this block\./,
  );
  assert.doesNotMatch(
    presenceHtml,
    /This value is not present on every path that reaches this block\./,
  );
});

test("renders the run_scripts/run_pre_pr_checks outcome enum as a dropdown", () => {
  // LiteralEditor renders any entry's schema.enum as a <select>; this pins
  // that behavior for the repository-scripts blocks' typed `outcome` output
  // specifically, so a regression there is caught here rather than only in
  // the generic enum case above.
  const outcomeValues: WorkflowDataCatalogEntry[] = [{
    reference: "steps.checks.output.outcome",
    label: "Checks · outcome",
    description: "Repository scripts outcome",
    schema: { type: "string", enum: ["passed", "failed", "skipped", "missing_configuration"] },
    source: { kind: "step", nodeId: "checks" },
    presence: "required",
    availability: { state: "available", guarantee: "Guaranteed." },
    compatibleInputNames: [],
  }];
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{
        combinator: "all",
        conditions: [{
          reference: "steps.checks.output.outcome",
          operator: "equals",
          value: "passed",
        }],
      }}
      availableValues={outcomeValues}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /<select[^>]*aria-label="Comparison value"/);
  assert.match(html, /missing_configuration/);
  assert.match(html, /skipped/);
});

test("offers replacement for an obsolete pre-release configuration", () => {
  const html = renderToStaticMarkup(
    <BranchFields
      configuration={{ condition: { kind: "lit", value: true } }}
      availableValues={values}
      canEdit
      onChange={() => undefined}
    />,
  );
  assert.match(html, /obsolete configuration/);
  assert.match(html, /Replace condition/);
});
