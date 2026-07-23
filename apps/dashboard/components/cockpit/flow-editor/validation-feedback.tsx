"use client";

import React from "react";
import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";

type StructuredValidationIssue = WorkflowDefinitionValidationIssue & {
  path?: string;
};

export interface GroupedValidationIssues {
  workflow: WorkflowDefinitionValidationIssue[];
  byNode: Record<string, WorkflowDefinitionValidationIssue[]>;
}

export function groupValidationIssues(
  issues: WorkflowDefinitionValidationIssue[],
): GroupedValidationIssues {
  const grouped: GroupedValidationIssues = { workflow: [], byNode: {} };
  for (const issue of issues) {
    if (issue.nodeId === null) {
      grouped.workflow.push(issue);
      continue;
    }
    (grouped.byNode[issue.nodeId] ??= []).push(issue);
  }
  return grouped;
}

export function validationDescriptionId(nodeId: string): string {
  return `workflow-node-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "-")}-validation-errors`;
}

function IssueDetail({ issue }: { issue: WorkflowDefinitionValidationIssue }) {
  const path = (issue as StructuredValidationIssue).path;
  return (
    <>
      <span className="block">{issue.message}</span>
      {path && (
        <span className="mt-0.5 block font-mono text-[9px] text-red-600">{path}</span>
      )}
    </>
  );
}

export function ValidationSummary({
  validation,
  nodeNames,
  onSelectNode,
}: {
  validation: WorkflowValidationState;
  nodeNames: Record<string, string>;
  onSelectNode: (nodeId: string) => void;
}) {
  if (validation.status === "valid") {
    return (
      <span className="rounded-full border border-emerald-300 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-emerald-700">
        Validated
      </span>
    );
  }

  if (validation.status === "checking") {
    return (
      <span
        aria-live="polite"
        className="rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-neutral-500"
      >
        Validation pending
      </span>
    );
  }

  const grouped = groupValidationIssues(validation.issues);
  const issueCount = validation.issues.length;

  return (
    <details className="group relative">
      <summary
        aria-haspopup="dialog"
        className="cursor-pointer list-none rounded-full border border-red-400 bg-red-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-red-700 marker:content-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600 focus-visible:outline-offset-2"
      >
        {issueCount} validation issue{issueCount === 1 ? "" : "s"}
      </summary>
      <span className="sr-only" role="alert" aria-live="assertive">
        {issueCount} workflow validation issue{issueCount === 1 ? "" : "s"}.{" "}
        {validation.issues[0]?.message}
      </span>
      <section
        role="dialog"
        aria-label="Workflow validation errors"
        data-error-presentation="overlay"
        className="absolute left-0 top-[calc(100%+8px)] z-50 w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-[4px] border border-red-200 bg-panel text-left shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-red-50 px-3.5 py-3">
          <div>
            <div className="font-body text-[13px] font-semibold text-red-800">
              Fix validation errors
            </div>
            <div className="mt-0.5 font-body text-[11px] leading-[1.4] text-red-700">
              Select a block to see its errors beside its configuration.
            </div>
          </div>
          <span
            aria-hidden="true"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-100 font-mono text-[11px] font-bold text-red-700"
          >
            !
          </span>
        </div>
        <div className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
          {grouped.workflow.length > 0 && (
            <div className="rounded-[3px] px-2 py-2">
              <div className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-red-700">
                Workflow
              </div>
              <ul className="m-0 space-y-1.5 p-0 font-body text-[12px] leading-[1.4] text-red-800">
                {grouped.workflow.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <IssueDetail issue={issue} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.entries(grouped.byNode).map(([nodeId, issues]) => (
            <button
              key={nodeId}
              type="button"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onSelectNode(nodeId);
              }}
              className="block w-full cursor-pointer rounded-[3px] border-none bg-transparent px-2 py-2 text-left hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600 focus-visible:outline-offset-[-2px]"
              aria-label={`Select block ${nodeNames[nodeId] ?? nodeId}`}
            >
              <span className="mb-1 flex items-center justify-between gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-red-700">
                <span className="truncate">{nodeNames[nodeId] ?? nodeId}</span>
                <span className="shrink-0">
                  {issues.length} error{issues.length === 1 ? "" : "s"} →
                </span>
              </span>
              <span className="block space-y-1.5 font-body text-[12px] leading-[1.4] text-red-800">
                {issues.map((issue, index) => (
                  <span key={`${issue.code}-${index}`} className="block">
                    <IssueDetail issue={issue} />
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      </section>
    </details>
  );
}

export function NodeValidationErrors({
  nodeId,
  issues,
}: {
  nodeId: string;
  issues: WorkflowDefinitionValidationIssue[];
}) {
  if (issues.length === 0) return null;
  return (
    <section
      id={`${validationDescriptionId(nodeId)}-details`}
      aria-label="Validation errors"
      className="border-b border-red-200 bg-red-50 px-[14px] py-3"
    >
      <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-red-700">
        Validation errors
      </div>
      <ul className="m-0 mt-1.5 space-y-1.5 p-0 font-body text-[12px] leading-[1.45] text-red-800">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${index}`} className="list-none">
            <IssueDetail issue={issue} />
          </li>
        ))}
      </ul>
    </section>
  );
}
