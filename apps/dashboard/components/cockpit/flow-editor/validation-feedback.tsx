"use client";

import React from "react";
import type {
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationNotice,
} from "@shared/contracts";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";
import { Button } from "@/components/ui";

/** An issue or a notice: what the validator said, about a block or the workflow. */
type Finding = WorkflowDefinitionValidationIssue | WorkflowDefinitionValidationNotice;

export interface GroupedValidationIssues<T extends Finding = WorkflowDefinitionValidationIssue> {
  workflow: T[];
  byNode: Record<string, T[]>;
}

export function groupValidationIssues<T extends Finding>(issues: T[]): GroupedValidationIssues<T> {
  const grouped: GroupedValidationIssues<T> = { workflow: [], byNode: {} };
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

/**
 * Red refuses Deploy; amber is said and never blocks (DESIGN.md: colour is
 * operational meaning). Full class strings, so Tailwind sees every one.
 */
const TONE = {
  error: {
    pill: "border-red-400 bg-red-50 text-red-700 focus-visible:outline-red-600",
    panel: "border-red-200",
    header: "border-red-100 bg-red-50",
    title: "text-red-800",
    subtitle: "text-red-700",
    badge: "bg-red-100 text-red-700",
    label: "text-red-700",
    text: "text-red-800",
    path: "text-red-600",
    hover: "hover:bg-red-50",
    section: "border-red-200 bg-red-50",
  },
  notice: {
    pill: "border-amber-300 bg-amber-50 text-amber-900 focus-visible:outline-amber-700",
    panel: "border-amber-300",
    header: "border-amber-200 bg-amber-50",
    title: "text-amber-900",
    subtitle: "text-amber-900",
    badge: "bg-amber-100 text-amber-900",
    label: "text-amber-900",
    text: "text-amber-900",
    path: "text-amber-800",
    hover: "hover:bg-amber-50",
    section: "border-amber-300 bg-amber-50",
  },
} as const;

type Tone = keyof typeof TONE;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function FindingDetail({ finding, tone }: { finding: Finding; tone: Tone }) {
  return (
    <>
      <span className="block">{finding.message}</span>
      {finding.path && (
        <span className={`mt-0.5 block font-mono text-[9px] ${TONE[tone].path}`}>{finding.path}</span>
      )}
    </>
  );
}

function FindingsPopover({
  tone,
  findings,
  pill,
  noun,
  dialogLabel,
  title,
  subtitle,
  announcement,
  nodeNames,
  onSelectNode,
}: {
  tone: Tone;
  findings: Finding[];
  pill: string;
  /** What one finding on a block is called in its row, "error" or "notice". */
  noun: string;
  dialogLabel: string;
  title: string;
  subtitle: string;
  /** Read out when the popover appears: assertive for what blocks, polite for what does not. */
  announcement: { text: string; urgent: boolean };
  nodeNames: Record<string, string>;
  onSelectNode: (nodeId: string) => void;
}) {
  const colours = TONE[tone];
  const grouped = groupValidationIssues(findings);
  return (
    <details className="group relative">
      <summary
        aria-haspopup="dialog"
        className={`cursor-pointer list-none rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] marker:content-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${colours.pill}`}
      >
        {pill}
      </summary>
      <span
        className="sr-only"
        role={announcement.urgent ? "alert" : "status"}
        aria-live={announcement.urgent ? "assertive" : "polite"}
      >
        {announcement.text}
      </span>
      <section
        role="dialog"
        aria-label={dialogLabel}
        data-error-presentation="overlay"
        className={`absolute left-0 top-[calc(100%+8px)] z-50 w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-[4px] border bg-panel text-left shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] ${colours.panel}`}
      >
        <div className={`flex items-start justify-between gap-4 border-b px-3.5 py-3 ${colours.header}`}>
          <div>
            <div className={`font-body text-[13px] font-semibold ${colours.title}`}>{title}</div>
            <div className={`mt-0.5 font-body text-[11px] leading-[1.4] ${colours.subtitle}`}>{subtitle}</div>
          </div>
          <span
            aria-hidden="true"
            className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold ${colours.badge}`}
          >
            !
          </span>
        </div>
        <div className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
          {grouped.workflow.length > 0 && (
            <div className="rounded-[3px] px-2 py-2">
              <div className={`mb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${colours.label}`}>
                Workflow
              </div>
              <ul className={`m-0 space-y-1.5 p-0 font-body text-[12px] leading-[1.4] ${colours.text}`}>
                {grouped.workflow.map((finding, index) => (
                  <li key={`${finding.code}-${index}`}>
                    <FindingDetail finding={finding} tone={tone} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.entries(grouped.byNode).map(([nodeId, nodeFindings]) => (
            <Button
              key={nodeId}
              type="button"
              variant="text"
              size="sm"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onSelectNode(nodeId);
              }}
              className={`block h-auto w-full cursor-pointer rounded-[3px] border-none bg-transparent px-2 py-2 text-left [&>span]:w-full [&>span]:flex-col [&>span]:items-stretch ${colours.hover}`}
              aria-label={`Select block ${nodeNames[nodeId] ?? nodeId}`}
            >
              <span className={`mb-1 flex items-center justify-between gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${colours.label}`}>
                <span className="truncate">{nodeNames[nodeId] ?? nodeId}</span>
                <span className="shrink-0">{plural(nodeFindings.length, noun)} →</span>
              </span>
              <span className={`block space-y-1.5 font-body text-[12px] leading-[1.4] ${colours.text}`}>
                {nodeFindings.map((finding, index) => (
                  <span key={`${finding.code}-${index}`} className="block">
                    <FindingDetail finding={finding} tone={tone} />
                  </span>
                ))}
              </span>
            </Button>
          ))}
        </div>
      </section>
    </details>
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
  if (validation.status === "idle") return null;

  if (validation.status === "checking") {
    return (
      <span
        aria-live="polite"
        className="rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-neutral-500"
      >
        Checking…
      </span>
    );
  }

  const notices = validation.notices ?? [];
  const noticeSummary =
    notices.length > 0 ? (
      <FindingsPopover
        tone="notice"
        findings={notices}
        pill={plural(notices.length, "notice")}
        noun="notice"
        dialogLabel="Workflow validation notices"
        title="Worth fixing, not blocking"
        subtitle="These do not stop saving or deploying. Select a block to see them beside its configuration."
        announcement={{ text: `${plural(notices.length, "workflow validation notice")}. ${notices[0]?.message ?? ""}`, urgent: false }}
        nodeNames={nodeNames}
        onSelectNode={onSelectNode}
      />
    ) : null;

  if (validation.status === "valid") return noticeSummary;

  const issueCount = validation.issues.length;
  return (
    <>
      <FindingsPopover
        tone="error"
        findings={validation.issues}
        pill={plural(issueCount, "validation issue")}
        noun="error"
        dialogLabel="Workflow validation errors"
        title="Fix validation errors"
        subtitle="Select a block to see its errors beside its configuration."
        announcement={{
          text: `${plural(issueCount, "workflow validation issue")}. ${validation.issues[0]?.message ?? ""}`,
          urgent: true,
        }}
        nodeNames={nodeNames}
        onSelectNode={onSelectNode}
      />
      {noticeSummary}
    </>
  );
}

function NodeFindings({
  id,
  tone,
  heading,
  findings,
}: {
  id?: string;
  tone: Tone;
  heading: string;
  findings: Finding[];
}) {
  if (findings.length === 0) return null;
  const colours = TONE[tone];
  return (
    <section id={id} aria-label={heading} className={`border-b px-[14px] py-3 ${colours.section}`}>
      <div className={`font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${colours.label}`}>
        {heading}
      </div>
      <ul className={`m-0 mt-1.5 space-y-1.5 p-0 font-body text-[12px] leading-[1.45] ${colours.text}`}>
        {findings.map((finding, index) => (
          <li key={`${finding.code}-${index}`} className="list-none">
            <FindingDetail finding={finding} tone={tone} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NodeValidationErrors({
  nodeId,
  issues,
}: {
  nodeId: string;
  issues: WorkflowDefinitionValidationIssue[];
}) {
  return (
    <NodeFindings
      id={`${validationDescriptionId(nodeId)}-details`}
      tone="error"
      heading="Validation errors"
      findings={issues}
    />
  );
}

/** A selected block's notices: said beside its configuration, never blocking. */
export function NodeValidationNotices({ notices }: { notices: WorkflowDefinitionValidationNotice[] }) {
  return <NodeFindings tone="notice" heading="Worth fixing" findings={notices} />;
}
