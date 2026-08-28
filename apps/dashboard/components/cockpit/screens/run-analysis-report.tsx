"use client";

import React from "react";
import Link from "next/link";
import type {
  RunAnalysisPhaseUsage,
  RunAnalysisReport,
  RunAnalysisUsageSnapshot,
  RunStatus,
} from "@shared/contracts";
import { CkCard, CkChip } from "@/components/ui";
import { PromptPreview } from "@/components/cockpit/prompt-library/prompt-preview";
import { runHref } from "@/lib/run-href";

function stageLabel(stage: RunAnalysisReport["stage"]): string {
  if (stage === "published") return "PR/MR published";
  if (stage === "no_change") return "No change needed";
  return "Research complete";
}

function stageTone(stage: RunAnalysisReport["stage"]): "success" | "warn" | "mariner" {
  return stage === "published" ? "success" : stage === "no_change" ? "warn" : "mariner";
}

function costLabel(snapshot: RunAnalysisUsageSnapshot | null): string {
  if (!snapshot) return "Not reached";
  return `$${snapshot.costUsd.toFixed(2)}${snapshot.costKnown ? "" : "+"}`;
}

function phaseCostLabel(phase: RunAnalysisPhaseUsage): string {
  return phase.costUsd === null ? "Unknown" : `$${phase.costUsd.toFixed(2)}`;
}

function tokenLabel(tokens: RunAnalysisPhaseUsage["tokens"]): string {
  if (!tokens) return "Unknown";
  return `${tokens.input} in / ${tokens.cachedInput} cached / ${tokens.output} out`;
}

function deliveryLabel(delivery: RunAnalysisReport["jira"]["research"]): string {
  if (delivery.state === "posted") return "Posted";
  if (delivery.state === "failed") return delivery.error ? `Failed: ${delivery.error}` : "Failed";
  if (delivery.state === "pending") return "Pending";
  return "Not applicable";
}

function DeliveryStatus({
  label,
  delivery,
}: {
  label: string;
  delivery: RunAnalysisReport["jira"]["research"];
}) {
  return (
    <span>
      {label}: {delivery.commentUrl ? (
        <a
          href={delivery.commentUrl}
          target="_blank"
          rel="noreferrer"
          className="text-mariner underline-offset-2 hover:underline"
        >
          {deliveryLabel(delivery)} ↗
        </a>
      ) : deliveryLabel(delivery)}
    </span>
  );
}

function Disclosure({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border-t border-neutral-200 pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 border-0 bg-transparent p-0 text-left font-mono text-[11px] uppercase tracking-[0.04em] text-neutral-800"
      >
        <span>{title}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="mt-3 min-w-0">{children}</div>}
    </div>
  );
}

function UsageTable({ report }: { report: RunAnalysisReport }) {
  const rows: Array<[string, RunAnalysisUsageSnapshot | null]> = [
    ["Research", report.usage.research],
    ["Publication", report.usage.publication],
    ["Final", report.usage.final],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse font-mono text-[11px]">
        <thead><tr className="text-left text-neutral-500"><th className="pb-2 pr-3 font-normal">Snapshot / phase</th><th className="pb-2 pr-3 font-normal">Cost</th><th className="pb-2 pr-3 font-normal">Tokens</th><th className="pb-2 pr-3 font-normal">Model</th><th className="pb-2 font-normal">Duration / turns</th></tr></thead>
        <tbody>
          {rows.map(([name, snapshot]) => (
            <React.Fragment key={name}>
              <tr className="border-t border-neutral-200 align-top">
                <td className="py-2 pr-3 font-medium text-neutral-900">{name}</td>
                <td className="py-2 pr-3 text-neutral-800">{costLabel(snapshot)}</td>
                <td className="py-2 pr-3 text-neutral-700">{snapshot?.tokensInput === null || !snapshot ? "Unknown" : `${snapshot.tokensInput} in / ${snapshot.tokensCached ?? 0} cached / ${snapshot.tokensOutput ?? 0} out`}</td>
                <td className="py-2 pr-3 text-neutral-500">{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleString()}` : "—"}</td>
                <td className="py-2 text-neutral-500">—</td>
              </tr>
              {snapshot ? Object.entries(snapshot.phases).map(([phaseName, phase]) => (
                <tr key={`${name}:${phaseName}`} className="border-t border-neutral-100 align-top">
                  <td className="py-2 pr-3 pl-3 text-neutral-700">↳ {phaseName}</td>
                  <td className="py-2 pr-3 text-neutral-700">{phaseCostLabel(phase)}</td>
                  <td className="py-2 pr-3 text-neutral-700">{tokenLabel(phase.tokens)}</td>
                  <td className="py-2 pr-3 text-neutral-700">{phase.model ?? "Unknown"}</td>
                  <td className="py-2 text-neutral-700">{phase.durationMs}ms / {phase.numTurns} turns</td>
                </tr>
              )) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunAnalysisReportCard({ report, runStatus: _runStatus, currentRunId }: { report: RunAnalysisReport | null; runStatus: RunStatus; currentRunId: string }) {
  if (!report) return null;
  const finalOrPublication = report.usage.final ?? report.usage.publication ?? report.usage.research;
  const sourceDiffers = report.sourceResearchRunId !== currentRunId;
  return (
    <CkCard eyebrow="Run analysis" title="Analysis report" action={<CkChip tone={stageTone(report.stage)}>{stageLabel(report.stage)}</CkChip>}>
      <div className="flex min-w-0 flex-col gap-4 font-body text-[13px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-neutral-600">
          <span>Captured {new Date(report.researchCompletedAt).toLocaleString()}</span>
          {sourceDiffers && <Link href={runHref({ id: report.sourceResearchRunId, ticket: "" })} className="text-mariner underline-offset-2 hover:underline">Source research run: {report.sourceResearchRunId}</Link>}
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric label="Repositories inspected" value={report.repositories.length} />
          <Metric label="Evidence items" value={report.evidenceStatus === "not_retained" ? "—" : report.evidence.length} />
          <Metric label="Expansion rounds" value={report.expansionRounds} />
          <Metric label="Current cost" value={costLabel(finalOrPublication)} />
        </div>
        {report.sanitization.truncated || Object.keys(report.sanitization.redactions).length > 0 ? (
          <div role="status" className="rounded-[3px] border border-[#F0D9A8] bg-[#FFF9E8] px-3 py-2 text-[12px] text-[#6E5200]">Some report content was redacted or truncated for safety.</div>
        ) : null}
        {report.evidenceStatus === "not_retained" && <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 text-[12px] text-neutral-700">Source evidence was not retained.</div>}
        <div className="min-w-0 overflow-hidden">
          <h3 className="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-500">Repositories analyzed</h3>
          <div className="flex min-w-0 flex-col gap-2">
            {report.repositories.map((repo) => <div key={`${repo.provider}:${repo.repoPath}`} className="grid min-w-0 gap-1 rounded-[3px] border border-neutral-200 bg-off-white p-2 md:grid-cols-[1.3fr_.5fr_1fr_1.4fr] md:items-start"><span className="break-all font-mono text-[11px] text-neutral-900">{repo.provider}:{repo.repoPath}</span><span className="font-mono text-[10px] uppercase text-neutral-600">{repo.access}</span><span className="break-all font-mono text-[10px] text-neutral-600">{repo.researchBranch}@{repo.researchBaseSha ? repo.researchBaseSha.slice(0, 8) : "unknown SHA"}<span className="block text-neutral-500">base: {repo.defaultBranch}</span></span><span className="break-words text-[12px] text-neutral-700">{repo.rationale}</span></div>)}
          </div>
        </div>
        <Disclosure title="What was checked" defaultOpen={report.evidenceStatus === "captured"}>
          {report.evidenceStatus === "not_retained" ? <p className="m-0 text-neutral-600">Source evidence was not retained.</p> : report.evidence.length > 0 ? <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-neutral-800">{report.evidence.map((item, index) => <li key={index} className="break-words">{item}</li>)}</ol> : <p className="m-0 text-neutral-600">No evidence items were captured.</p>}
        </Disclosure>
        <Disclosure title="Decisions">
          <div className="flex flex-col gap-2 text-neutral-800">
            <p className="m-0">Expansion rounds: {report.expansionRounds}</p>
            <DecisionList title="Requests" items={report.repositoryRequests} />
            <DecisionList title="Write repositories" items={report.writeRepositories} />
            {report.resolutionEvidence.length > 0 && <p className="m-0 break-words">Resolution evidence: {report.resolutionEvidence.join(" · ")}</p>}
          </div>
        </Disclosure>
        <Disclosure title="Implementation plan" defaultOpen>
          <div className="min-w-0 overflow-hidden"><PromptPreview body={report.planMarkdown || "No implementation plan was retained."} /></div>
        </Disclosure>
        <div className="border-t border-neutral-200 pt-3"><h3 className="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-500">Usage</h3><UsageTable report={report} /></div>
        {report.publication && <div className="border-t border-neutral-200 pt-3"><h3 className="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-500">Published</h3><div className="flex flex-col gap-2"><div className="flex flex-wrap gap-2">{report.publication.prs.map((pr) => <a key={`${pr.provider}:${pr.repoPath}:${pr.id}`} href={pr.url} target="_blank" rel="noreferrer" className="max-w-full break-all text-mariner underline-offset-2 hover:underline">{pr.provider}:{pr.repoPath} #{pr.id} ↗</a>)}</div><p className="m-0 whitespace-pre-wrap break-words text-neutral-800">{report.publication.changeSummary}</p></div></div>}
        <div className="border-t border-neutral-200 pt-3"><h3 className="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-500">Jira delivery</h3><div className="grid gap-1 font-mono text-[11px] text-neutral-700 md:grid-cols-2"><DeliveryStatus label="Research" delivery={report.jira.research} /><DeliveryStatus label="PR/MR" delivery={report.jira.pullRequest} /></div>{(report.jira.research.state === "failed" || report.jira.pullRequest.state === "failed") && <p className="m-0 mt-2 text-[12px] text-fail-fg">Automatic retries exhausted; code delivery was not blocked.</p>}</div>
      </div>
    </CkCard>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="min-w-0 rounded-[3px] border border-neutral-200 bg-off-white px-2.5 py-2"><div className="font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-500">{label}</div><div className="mt-1 break-words font-display text-lg text-neutral-900">{value}</div></div>;
}

function DecisionList({
  title,
  items,
}: {
  title: string;
  items: RunAnalysisReport["repositoryRequests"];
}) {
  if (items.length === 0) return <p className="m-0">{title}: none</p>;
  return (
    <div>
      <p className="m-0">{title}:</p>
      <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-5">
        {items.map((item) => (
          <li key={`${item.provider}:${item.repoPath}`} className="break-words">
            <span className="font-mono">{item.provider}:{item.repoPath}</span> — {item.rationale}
          </li>
        ))}
      </ul>
    </div>
  );
}
