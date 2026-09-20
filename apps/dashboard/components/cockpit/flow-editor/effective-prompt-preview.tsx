"use client";

/**
 * What this block sends, in two views an operator can tell apart.
 *
 * "Sent last time" is one real briefing out of one real run, rendered by the
 * run replay's own component. "Would send now" is a compile of the definition
 * in this editor, saved or not. They must never blur into one another: the
 * first is evidence, the second is a projection, and a projection dressed as
 * evidence is what this whole surface exists to stop.
 *
 * WHAT A PREVIEW CANNOT KNOW is said on the preview rather than left to be
 * discovered. The worker's preview compiles the same sections execution does
 * (`packages/prompts/effective-prompt.ts`), but it has no prepared workspace
 * and no run, so runtime values are examples derived from each binding's
 * schema and the repository instructions and repo memory a run adds are only
 * named, under "Resolved at runtime". The alternative, a preview that looks
 * complete and is not, is how an operator ends up debugging the wrong prompt.
 */
import { useRef, useState } from "react";
import type {
  WorkflowDefinitionV2,
} from "@shared/contracts";
import {
  apiClient,
  type EffectivePromptPreviewProvenance,
  type EffectivePromptPreviewResponse,
} from "@/lib/api/client";
import { Button, IconButton } from "@/components/ui";

import { LastBriefingView } from "./last-briefing-view";

export type { EffectivePromptPreviewResponse } from "@/lib/api/client";

/** Which of the two things a person is looking at. */
type View = "now" | "then";

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
      <div className="rounded-xs border border-neutral-200 bg-off-white px-2 py-2">
        <div className="font-mono text-[8px] uppercase tracking-[0.05em] text-neutral-600">
          A preview is not a send
        </div>
        <p className="m-0 mt-1 font-body text-[10px] leading-[1.35] text-neutral-600">
          The values below are examples built from each binding&apos;s schema, not what a run would carry. Repository
          instructions and repo memory are added when a workspace is prepared, so they are named under &ldquo;Resolved
          at runtime&rdquo; rather than shown.
        </p>
      </div>

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
  // The editor opens on the compile, because that is what the person pressing
  // this button in the middle of an edit came for. "Sent last time" is one
  // click away and loads only when asked: it is a read of a past run and has
  // no business costing anything while nobody is looking at it.
  const [view, setView] = useState<View>("now");
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
    setView("now");
    try {
      const response = await apiClient.workflowDefinitions.promptPreview(
        definitionId,
        definition,
        blockId,
        { signal: controller.signal },
      );
      if (!response.ok) {
        setError(response.errorMessage);
        setResult(null);
        return;
      }
      setResult(response.data);
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
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.06em] text-neutral-700">
            What this block sends
          </div>
          <p className="m-0 mt-0.5 font-body text-[10px] text-neutral-500">
            {open && view === "then"
              ? "The last briefing this block produced, from the run it came out of."
              : "The ordered sections compiled from this workflow as it is in the editor, saved or not."}
          </p>
        </div>
        {/* Compiling belongs to the view that compiles. In the past view this
            button would either do nothing a person can see or throw them back
            to the preview, which is not what "refresh" means to them. */}
        {!open || view === "now" ? (
          <Button
            type="button"
            variant="text"
            size="sm"
            disabled={loading}
            onClick={() => void load()}
            className="appearance-none rounded-xs border border-mariner bg-panel px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner disabled:opacity-40"
          >
            {loading ? "Building…" : result ? "Refresh" : "Preview"}
          </Button>
        ) : null}
        {open && (
          <IconButton
            type="button"
            variant="text"
            size="sm"
            onClick={() => setOpen(false)}
            aria-label="Close what this block sends"
            className="appearance-none border-none bg-transparent font-mono text-[12px] text-neutral-500"
          >
            ×
          </IconButton>
        )}
      </div>
      {open && (
        <>
          {/* The two views are named by time, not by mechanism: "sent last
              time" and "would send now" is the distinction the operator
              actually makes, and it is the one that stops a projection from
              being read as a record. */}
          <div
            role="group"
            aria-label="What this block sends"
            className="flex flex-wrap gap-1.5 border-t border-neutral-200 px-2.5 py-2"
          >
            <Button
              type="button"
              variant={view === "then" ? "selected" : "secondary"}
              size="sm"
              aria-pressed={view === "then"}
              onClick={() => setView("then")}
              className="h-auto py-1 font-mono text-[9px] uppercase tracking-[0.04em]"
            >
              Sent last time
            </Button>
            <Button
              type="button"
              variant={view === "now" ? "selected" : "secondary"}
              size="sm"
              aria-pressed={view === "now"}
              onClick={() => setView("now")}
              className="h-auto py-1 font-mono text-[9px] uppercase tracking-[0.04em]"
            >
              Would send now
            </Button>
          </div>
          <div className="max-h-[560px] overflow-y-auto border-t border-neutral-200 p-2">
            {view === "then" ? (
              <LastBriefingView definitionId={definitionId} nodeId={blockId} />
            ) : error ? (
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
        </>
      )}
    </section>
  );
}
