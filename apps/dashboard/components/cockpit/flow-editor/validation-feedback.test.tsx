import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";
import {
  groupValidationIssues,
  NodeValidationErrors,
  NodeValidationNotices,
  ValidationSummary,
} from "./validation-feedback";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const issues = [
  {
    code: "deployment",
    nodeId: null,
    message: "A trigger must reach an end block.",
  },
  {
    code: "deployment",
    nodeId: "implementation",
    message: 'Required input "plan" is missing.',
    path: "/nodes/2/inputs/plan",
  },
  {
    code: "deployment",
    nodeId: "implementation",
    message: "Output schema is invalid.",
  },
] as WorkflowDefinitionValidationIssue[];

test("groups workflow and block validation issues without losing order", () => {
  assert.deepEqual(groupValidationIssues(issues), {
    workflow: [issues[0]],
    byNode: {
      implementation: [issues[1], issues[2]],
    },
  });
});

test("renders errors in a dialog that can focus the affected block", () => {
  const validation: WorkflowValidationState = {
    status: "invalid",
    issues,
    nodeContracts: {},
    availableValuesByNode: {},
  };
  const html = renderToStaticMarkup(
    <ValidationSummary
      validation={validation}
      nodeNames={{ implementation: "Implementation" }}
      onSelectNode={() => undefined}
    />,
  );

  assert.match(html, /3 validation issues/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Workflow/);
  assert.match(html, /aria-label="Select block Implementation"/);
  assert.match(html, /2 errors/);
});

test("renders a selected block's validation errors expanded with its exact path", () => {
  const html = renderToStaticMarkup(
    <NodeValidationErrors nodeId="implementation" issues={issues.slice(1)} />,
  );

  assert.match(html, /aria-label="Validation errors"/);
  assert.match(html, /Validation errors/);
  assert.match(html, /Required input &quot;plan&quot; is missing/);
  assert.match(html, /\/nodes\/2\/inputs\/plan/);
  assert.doesNotMatch(html, /<details/);
});

const notice = {
  code: "tracker_query_not_run",
  nodeId: "look",
  path: "/nodes/1/configuration/issueTrackerQueryTemplate",
  message: "Jira does not run this query, so the block searches without it.",
};

test("shows a notice on a valid workflow as its own amber summary that does not alert", () => {
  const html = renderToStaticMarkup(
    <ValidationSummary
      validation={{
        status: "valid",
        issues: [],
        notices: [notice],
        nodeContracts: {},
        availableValuesByNode: {},
      }}
      nodeNames={{ look: "Look for duplicates" }}
      onSelectNode={() => undefined}
    />,
  );

  assert.match(html, />1 notice</);
  assert.match(html, /aria-label="Workflow validation notices"/);
  assert.match(html, /do not stop saving or deploying/);
  assert.match(html, /aria-label="Select block Look for duplicates"/);
  assert.match(html, /Jira does not run this query/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /validation issue/);
  assert.match(html, /border-amber-300/);
  assert.doesNotMatch(html, /text-red-/);
});

test("counts only the errors in the error summary when a workflow has both", () => {
  const html = renderToStaticMarkup(
    <ValidationSummary
      validation={{
        status: "invalid",
        issues: issues.slice(0, 1),
        notices: [notice],
        nodeContracts: {},
        availableValuesByNode: {},
      }}
      nodeNames={{}}
      onSelectNode={() => undefined}
    />,
  );

  assert.match(html, />1 validation issue</);
  assert.match(html, />1 notice</);
});

test("renders a selected block's notices apart from its errors", () => {
  const html = renderToStaticMarkup(<NodeValidationNotices notices={[notice]} />);

  assert.match(html, /aria-label="Worth fixing"/);
  assert.match(html, /Jira does not run this query/);
  assert.match(html, /\/nodes\/1\/configuration\/issueTrackerQueryTemplate/);
  assert.doesNotMatch(html, /Validation errors/);
  assert.equal(renderToStaticMarkup(<NodeValidationNotices notices={[]} />), "");
});

// Red when: the list of issues names blocks by id while its headings name them
// by the name the author gave them.
test("the issue list names blocks the way the canvas does", () => {
  const validation: WorkflowValidationState = {
    status: "invalid",
    issues: [
      {
        code: "unreachable",
        nodeId: "clean-copy",
        message: 'Block "clean-copy" is not reachable from a trigger.',
      },
    ] as WorkflowDefinitionValidationIssue[],
    nodeContracts: {},
    availableValuesByNode: {},
  };
  const html = renderToStaticMarkup(
    <ValidationSummary
      validation={validation}
      nodeNames={{ "clean-copy": "Allow clean input (copy)" }}
      onSelectNode={() => undefined}
    />,
  );
  assert.match(html, /Allow clean input \(copy\)/);
  assert.match(html, /This block is not reachable from a trigger\./);
  assert.doesNotMatch(html, /clean-copy&quot;/);
});
