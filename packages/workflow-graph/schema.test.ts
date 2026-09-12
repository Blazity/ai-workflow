import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowDataReferenceV2, workflowDefinitionV2Schema } from "./schema";

/** The stored-shape upgrade this schema performs is exercised through the parse
 *  policy that owns it, in policies.test.ts. */

test("a retired v1 row is refused rather than upgraded", () => {
  assert.equal(
    workflowDefinitionV2Schema.safeParse({ schemaVersion: 1, nodes: [], edges: [] })
      .success,
    false,
  );
});

test("data references are recognised by their canonical shape", () => {
  assert.equal(isWorkflowDataReferenceV2("steps.entry.output.ticket.key"), true);
  assert.equal(isWorkflowDataReferenceV2("run.attempt"), true);
  assert.equal(isWorkflowDataReferenceV2("steps.plan.output"), true);
  assert.equal(isWorkflowDataReferenceV2("steps.plan.result"), false);
  assert.equal(isWorkflowDataReferenceV2("steps.plan.output.__proto__"), false);
  assert.equal(isWorkflowDataReferenceV2(" steps.entry.output.a"), false);
});
