import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDefinitionMigrationPreview } from "@shared/contracts";
import {
  canApplyWorkflowMigration,
  workflowMigrationVisibility,
  WorkflowMigrationDrawer,
  type WorkflowMigrationDrawerState,
} from "./workflow-migration-drawer";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const v2Definition = {
  schemaVersion: 2,
  nodes: [],
  edges: [],
} as WorkflowDefinitionMigrationPreview["definition"];

function preview(
  overrides: Partial<WorkflowDefinitionMigrationPreview> = {},
): WorkflowDefinitionMigrationPreview {
  return {
    sourceDefinitionId: 12,
    sourceVersion: 4,
    targetSchemaVersion: 2,
    conversionHash: "a".repeat(64),
    definition: v2Definition,
    conversions: [
      {
        code: "migration.prompt.default_materialized",
        message: "Materialized the Implementation Agent default prompt.",
        nodeId: "implementation",
      },
      {
        code: "migration.edge.id_assigned",
        message: "Assigned edge id.",
        nodeId: null,
      },
    ],
    warnings: [],
    blockers: [],
    ...overrides,
  };
}

function render(state: WorkflowMigrationDrawerState) {
  return renderToStaticMarkup(
    <WorkflowMigrationDrawer
      open
      state={state}
      workflowName="Ticket workflow"
      onClose={() => undefined}
      onSaveAndPreview={() => undefined}
      onRetry={() => undefined}
      onApply={() => undefined}
      onOpenNode={() => undefined}
    />,
  );
}

test("shows legacy status to everyone but migration only to editors", () => {
  assert.deepEqual(workflowMigrationVisibility(1, false), {
    showLegacyStatus: true,
    showMigrationAction: false,
  });
  assert.deepEqual(workflowMigrationVisibility(1, true), {
    showLegacyStatus: true,
    showMigrationAction: true,
  });
  assert.deepEqual(workflowMigrationVisibility(2, true), {
    showLegacyStatus: false,
    showMigrationAction: false,
  });
});

test("renders the save-and-preview and loading states", () => {
  const saveHtml = render({ kind: "save_required" });
  assert.match(saveHtml, /Save &amp; preview/);
  assert.match(saveHtml, /exact saved version/);
  assert.match(saveHtml, /role="dialog"/);
  assert.match(saveHtml, /aria-modal="true"/);

  const loadingHtml = render({ kind: "loading" });
  assert.match(loadingHtml, /Checking this workflow for v2/);
  assert.match(loadingHtml, /Nothing is being saved yet/);
});

test("renders automatic changes, review items, blockers, and block links", () => {
  const migrationPreview = preview({
    warnings: [
      {
        code: "migration.review",
        message: "Review this converted condition.",
        nodeId: "branch",
      },
    ],
    blockers: [
      {
        code: "migration.edge.failure_port",
        message: "A connected FAILED path cannot be converted safely.",
        nodeId: "implementation",
        path: "/edges/2",
      },
    ],
    definition: null,
    conversionHash: null,
  });
  const html = render({ kind: "preview", preview: migrationPreview });

  assert.match(html, /Automatic changes/);
  assert.match(html, /Review items/);
  assert.match(html, /Resolve before migrating/);
  assert.match(html, /Open block/);
  assert.match(html, /\/edges\/2/);
  assert.match(html, /Create v2 draft/);
  assert.match(html, /disabled=""/);
  assert.equal(canApplyWorkflowMigration(migrationPreview), false);
});

test("allows a clean or acknowledged-review preview to create a draft", () => {
  const migrationPreview = preview({
    warnings: [
      {
        code: "migration.review",
        message: "Review the converted condition.",
        nodeId: "branch",
      },
    ],
  });
  const html = render({ kind: "preview", preview: migrationPreview });

  assert.match(html, /Review before creating the draft/);
  assert.doesNotMatch(
    html.match(/<button[^>]*>Create v2 draft<\/button>/)?.[0] ?? "",
    /\sdisabled=""/,
  );
  assert.equal(canApplyWorkflowMigration(migrationPreview), true);
});

test("renders retry and success states with the deployed-v1 guarantee", () => {
  const errorHtml = render({
    kind: "error",
    stale: true,
    message: "Migration resolution changed.",
  });
  assert.match(errorHtml, /Preview is out of date/);
  assert.match(errorHtml, /Preview again/);

  const successHtml = render({ kind: "success", deployedVersion: 7 });
  assert.match(successHtml, /V2 draft created/);
  assert.match(successHtml, /Production still runs deployed v1 version 7/);
  assert.match(successHtml, /Review v2 draft/);
});
