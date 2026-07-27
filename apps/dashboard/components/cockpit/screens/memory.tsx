// apps/dashboard/components/cockpit/screens/memory.tsx
// Server-rendered: the screen is read-only, so it needs no client state and
// navigates with plain links.
import Link from "next/link";

import { CkCard, CkChip } from "@/components/ui";
import type {
  MemoryDocumentDto,
  MemoryDocumentSummaryDto,
} from "@shared/contracts";

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_70px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_70px_120px_150px] items-center gap-3";

export function MemoryScreen({
  documents,
  selection,
  selected,
}: {
  documents: MemoryDocumentSummaryDto[];
  /** The document key taken from the URL, or null on the plain listing. */
  selection: { subjectKey: string; docPath: string } | null;
  /** The selected document, or null when the key no longer resolves. */
  selected: MemoryDocumentDto | null;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          Agent memory
        </div>
        <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
          {documents.length} {documents.length === 1 ? "document" : "documents"}
        </h2>
      </div>

      {selection ? (
        <CkCard
          eyebrow={selection.subjectKey}
          title={selection.docPath}
          action={
            <Link
              href="/memory"
              className="font-mono text-[11px] uppercase tracking-[0.04em] text-mariner hover:underline"
            >
              Close
            </Link>
          }
        >
          {selected ? (
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[11px] text-neutral-500">
                {formatBytes(selected.bytes)} · updated {formatDateTime(selected.updatedAt)} · run{" "}
                {selected.sourceRunId}
              </div>
              {/* Plain text in a <pre>: memory is written by the agent, so it is
                  never rendered as HTML or markdown. */}
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-xs border border-neutral-200 bg-off-white p-3 font-mono text-[12px] leading-[1.5] text-coal">
                {selected.content}
              </pre>
            </div>
          ) : (
            <div className="py-6 text-center font-body text-[13px] text-neutral-500">
              This document is no longer stored.
            </div>
          )}
        </CkCard>
      ) : null}

      <CkCard pad={0}>
        <div
          className={`${ROW_GRID} bg-neutral-100 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700`}
        >
          <span>Subject</span>
          <span>Document</span>
          <span className="text-right">Size</span>
          <span className="hidden lg:block text-right">Updated</span>
          <span className="hidden lg:block text-right">Source run</span>
        </div>

        {documents.length === 0 ? (
          <div className="px-4 py-10 text-center font-body text-[13px] text-neutral-500">
            Nothing remembered yet. Documents appear here once a run writes to its memory.
          </div>
        ) : (
          <div className="flex flex-col">
            {documents.map((doc, index) => {
              const active =
                selection?.subjectKey === doc.subjectKey && selection?.docPath === doc.docPath;
              return (
                <Link
                  key={`${doc.subjectKey}:${doc.docPath}`}
                  href={`/memory?subject=${encodeURIComponent(doc.subjectKey)}&doc=${encodeURIComponent(doc.docPath)}`}
                  className={`${ROW_GRID} px-4 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px] ${
                    active ? "bg-[#ECECFD]" : "hover:bg-neutral-100"
                  } ${index < documents.length - 1 ? "border-b border-neutral-200" : ""}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {doc.ticketKey ? (
                      <CkChip>{doc.ticketKey}</CkChip>
                    ) : (
                      <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-neutral-500">
                        No ticket
                      </span>
                    )}
                    <span className="truncate font-mono text-[11px] text-neutral-700">
                      {doc.subjectKey}
                    </span>
                  </span>
                  <span className="truncate font-body text-[13px] font-semibold text-neutral-900">
                    {doc.docPath}
                  </span>
                  <span className="text-right font-mono text-[11px] text-neutral-700">
                    {formatBytes(doc.bytes)}
                  </span>
                  <span className="hidden lg:block text-right font-mono text-[11px] text-neutral-500">
                    {formatDateTime(doc.updatedAt)}
                  </span>
                  <span className="hidden lg:block truncate text-right font-mono text-[11px] text-neutral-500">
                    {doc.sourceRunId}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </CkCard>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
