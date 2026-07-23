"use client";

import { useRef, useState } from "react";
import type {
  WorkflowDefinitionV2,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import { readErrorMessage } from "@/lib/api/error-message";

export interface EffectivePromptPreviewProvenance {
  kind: "profile" | "repository" | "prompt" | "runtime";
  id: string;
  version: number | null;
  hash: string;
}

export interface EffectivePromptPreviewSection {
  kind: "profile" | "repository" | "block" | "runtime";
  title: string;
  content: string;
  hash: string;
  provenance: EffectivePromptPreviewProvenance[];
}

export interface EffectivePromptPreviewUnresolvedSource {
  kind: "profile" | "repository" | "data" | "slot";
  reference: string;
  message: string;
}

export interface EffectivePromptPreviewResponse {
  blockId: string;
  prompt: string;
  hash: string;
  sections: EffectivePromptPreviewSection[];
  provenance: EffectivePromptPreviewProvenance[];
  unresolvedSources: EffectivePromptPreviewUnresolvedSource[];
  issues: WorkflowDefinitionValidationIssue[];
}

const previewButton =
  "appearance-none rounded-xs border border-mariner bg-panel px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40";

function Provenance({
  entries,
}: {
  entries: readonly EffectivePromptPreviewProvenance[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {entries.map((entry, index) => (
        <div
          key={`${entry.kind}:${entry.id}:${entry.version}:${index}`}
          className="rounded-xs border border-neutral-200 bg-off-white px-2 py-1 font-mono text-[8px] leading-[1.4] text-neutral-600"
        >
          <span className="uppercase">{entry.kind}</span>
          {" · "}
          {entry.id}
          {entry.version === null ? "" : ` · v${entry.version}`}
          <span className="mt-0.5 block break-all text-neutral-500">
            {entry.hash}
          </span>
        </div>
      ))}
    </div>
  );
}

export function EffectivePromptPreviewResultView({
  result,
}: {
  result: EffectivePromptPreviewResponse;
}) {
  return (
    <div className="space-y-2">
      {result.issues.length > 0 && (
        <div role="alert" className="rounded-xs border border-red-200 bg-red-50 px-2 py-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-red-800">
            Preview errors
          </div>
          <ul className="m-0 mt-1 space-y-1 p-0">
            {result.issues.map((issue, index) => (
              <li
                key={`${issue.code}:${issue.path}:${index}`}
                className="list-none font-body text-[10px] leading-[1.35] text-red-800"
              >
                {issue.path && (
                  <span className="font-mono">{issue.path}: </span>
                )}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.unresolvedSources.length > 0 && (
        <div className="rounded-xs border border-neutral-200 bg-off-white px-2 py-2">
          <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-600">
            Resolved at runtime
          </div>
          <ul className="m-0 mt-1 space-y-1 p-0">
            {result.unresolvedSources.map((source, index) => (
              <li
                key={`${source.kind}:${source.reference}:${index}`}
                className="list-none font-body text-[10px] leading-[1.35] text-neutral-600"
              >
                <span className="font-mono">
                  {source.kind} · {source.reference}
                </span>
                {": "}
                {source.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.sections.map((section, index) => (
        <article
          key={`${section.kind}:${section.title}:${index}`}
          className="overflow-hidden rounded-xs border border-neutral-200 bg-panel"
        >
          <div className="border-b border-neutral-200 bg-app-bg px-2 py-1.5">
            <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-500">
              {index + 1} · {section.kind}
            </div>
            <div className="font-body text-[11px] font-semibold text-neutral-800">
              {section.title}
            </div>
          </div>
          <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-words px-2 py-2 font-mono text-[10px] leading-[1.5] text-neutral-700">
            {section.content}
          </pre>
          <div className="border-t border-neutral-200 px-2 py-1.5">
            <div className="break-all font-mono text-[8px] text-neutral-500">
              {section.hash}
            </div>
            <Provenance entries={section.provenance} />
          </div>
        </article>
      ))}

      <details className="rounded-xs border border-neutral-200 bg-panel px-2 py-1.5">
        <summary className="cursor-pointer font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-600">
          Compiled prompt · {result.hash}
        </summary>
        <pre className="m-0 mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-[1.5] text-neutral-700">
          {result.prompt}
        </pre>
      </details>
    </div>
  );
}

export function EffectivePromptPreview({
  definitionId,
  definition,
  blockId,
}: {
  definitionId: number;
  definition: WorkflowDefinitionV2;
  blockId: string;
}) {
  const [result, setResult] =
    useState<EffectivePromptPreviewResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const load = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setOpen(true);
    try {
      const response = await fetch(
        `/api/workflow-definitions/${definitionId}/prompt-preview`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ definition, blockId }),
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        setError(await readErrorMessage(response));
        setResult(null);
        return;
      }
      setResult((await response.json()) as EffectivePromptPreviewResponse);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to preview this prompt.",
      );
      setResult(null);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <section className="mt-2 overflow-hidden rounded-xs border border-neutral-200 bg-panel">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            Effective prompt
          </div>
          <p className="m-0 mt-0.5 font-body text-[10px] text-neutral-500">
            Preview the exact ordered sections for this unsaved workflow.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className={previewButton}
        >
          {loading ? "Building…" : result ? "Refresh" : "Preview"}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close effective prompt preview"
            className="appearance-none border-none bg-transparent font-mono text-[12px] text-neutral-500"
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-[560px] overflow-y-auto border-t border-neutral-200 p-2">
          {error ? (
            <div role="alert" className="rounded-xs border border-red-200 bg-red-50 px-2 py-2 font-body text-[10px] text-red-800">
              {error}
            </div>
          ) : result ? (
            <EffectivePromptPreviewResultView result={result} />
          ) : (
            <div className="py-4 text-center font-mono text-[9px] text-neutral-500">
              Building preview…
            </div>
          )}
        </div>
      )}
    </section>
  );
}
