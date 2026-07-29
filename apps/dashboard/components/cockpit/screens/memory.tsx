// apps/dashboard/components/cockpit/screens/memory.tsx
// Client component: the listing is server-rendered data, but deleting a
// document is a destructive mutation that needs a confirmation step and has to
// update the listing without a full page reload.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { CkCard, CkChip } from "@/components/ui";
import { readErrorMessage } from "@/lib/api/error-message";
import type {
  MemoryDocumentDto,
  MemoryDocumentSummaryDto,
} from "@shared/contracts";

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_70px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_70px_120px_150px] items-center gap-3";

type DocumentKey = { subjectKey: string; docPath: string };

/** The dashboard never touches the database: deletion goes through the Next
 *  proxy route in app/api/memory, which forwards to the worker. */
export function memoryDeleteUrl(doc: DocumentKey): string {
  return `/api/memory?subjectKey=${encodeURIComponent(doc.subjectKey)}&docPath=${encodeURIComponent(doc.docPath)}`;
}

function sameDocument(a: DocumentKey, b: DocumentKey): boolean {
  return a.subjectKey === b.subjectKey && a.docPath === b.docPath;
}

type DeleteState = {
  doc: DocumentKey;
  phase: "confirming" | "deleting" | "deleted";
  error: string | null;
};

export function MemoryScreen({
  documents,
  selection,
  selected,
  canDelete = false,
}: {
  documents: MemoryDocumentSummaryDto[];
  /** The document key taken from the URL, or null on the plain listing. */
  selection: DocumentKey | null;
  /** The selected document, or null when the key no longer resolves. */
  selected: MemoryDocumentDto | null;
  /** Owners and admins only, mirroring the worker's role rule. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const documentsKey = JSON.stringify(documents);
  const [appliedKey, setAppliedKey] = useState(documentsKey);
  // Scoping the state to the open document means navigating to another one
  // drops a half-finished confirmation instead of carrying it over.
  const pending =
    deleteState && selection && sameDocument(deleteState.doc, selection) ? deleteState : null;
  const removed = pending?.phase === "deleted" ? pending.doc : null;
  const visible = removed
    ? documents.filter((doc) => !sameDocument(doc, removed))
    : documents;

  // A fresh server render supersedes the local state, so the optimistic filter
  // and the post-delete message can never sit on top of live data.
  useEffect(() => {
    if (documentsKey === appliedKey) return;
    setDeleteState(null);
    setAppliedKey(documentsKey);
  }, [documentsKey, appliedKey]);

  async function remove(doc: DocumentKey) {
    setDeleteState({ doc, phase: "deleting", error: null });
    try {
      const res = await fetch(memoryDeleteUrl(doc), { method: "DELETE" });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      // Hiding the row locally is only the optimistic half; refresh is what
      // makes the server-rendered listing agree, the way every other mutating
      // cockpit screen does it.
      setDeleteState({ doc, phase: "deleted", error: null });
      router.refresh();
    } catch (err) {
      setDeleteState({
        doc,
        phase: "confirming",
        error: err instanceof Error ? err.message : "Unable to delete this document",
      });
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          Agent memory
        </div>
        <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
          {visible.length} {visible.length === 1 ? "document" : "documents"}
        </h2>
      </div>

      {selection ? (
        <CkCard
          eyebrow={selection.subjectKey}
          title={selection.docPath}
          action={
            <div className="flex items-center gap-2">
              {canDelete && selected && pending?.phase !== "deleted" ? (
                pending ? (
                  <>
                    <span className="font-mono text-[11px] text-neutral-700">
                      Delete from the store?
                    </span>
                    <DarkButton
                      disabled={pending.phase === "deleting"}
                      onClick={() => remove(selection)}
                      type="button"
                    >
                      {pending.phase === "deleting" ? "Deleting…" : "Confirm delete"}
                    </DarkButton>
                    <GhostButton
                      disabled={pending.phase === "deleting"}
                      onClick={() => setDeleteState(null)}
                      type="button"
                    >
                      Cancel
                    </GhostButton>
                  </>
                ) : (
                  <GhostButton
                    danger
                    onClick={() =>
                      setDeleteState({ doc: selection, phase: "confirming", error: null })
                    }
                    type="button"
                  >
                    Delete
                  </GhostButton>
                )
              ) : null}
              <Link
                href="/memory"
                className="font-mono text-[11px] uppercase tracking-[0.04em] text-mariner hover:underline"
              >
                Close
              </Link>
            </div>
          }
        >
          {pending?.phase === "deleted" ? (
            // Honest about the one thing deletion cannot promise: there is no
            // tombstone, so the same fact can be distilled again from a source
            // that is still there.
            <div className="py-6 text-center font-body text-[13px] text-neutral-500">
              Deleted from the store. A later run can learn this again.
            </div>
          ) : selected ? (
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[11px] text-neutral-500">
                {formatBytes(selected.bytes)} · updated {formatDateTime(selected.updatedAt)} · run{" "}
                {selected.sourceRunId}
              </div>
              {pending ? (
                <div className="font-mono text-[11px] text-neutral-700">
                  Deleting removes the stored text now. A later run can learn this again.
                </div>
              ) : null}
              {pending?.error ? <InlineError>{pending.error}</InlineError> : null}
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

        {visible.length === 0 ? (
          <div className="px-4 py-10 text-center font-body text-[13px] text-neutral-500">
            Nothing remembered yet. Documents appear here once a run writes to its memory.
          </div>
        ) : (
          <div className="flex flex-col">
            {visible.map((doc, index) => {
              const active =
                selection?.subjectKey === doc.subjectKey && selection?.docPath === doc.docPath;
              return (
                <Link
                  key={`${doc.subjectKey}:${doc.docPath}`}
                  href={`/memory?subject=${encodeURIComponent(doc.subjectKey)}&doc=${encodeURIComponent(doc.docPath)}`}
                  className={`${ROW_GRID} px-4 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px] ${
                    active ? "bg-[#ECECFD]" : "hover:bg-neutral-100"
                  } ${index < visible.length - 1 ? "border-b border-neutral-200" : ""}`}
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

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[3px] border border-fail-bg bg-fail-bg px-3 py-2 text-[13px] text-fail-fg">
      {children}
    </div>
  );
}

function GhostButton({
  children,
  danger = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...props}
      className={[
        "inline-flex items-center justify-center whitespace-nowrap rounded-[3px] border bg-white px-2.5 py-[5px] font-mono text-[10px] font-medium uppercase tracking-[0.04em] transition disabled:cursor-default disabled:opacity-40",
        danger
          ? "border-[#F3CFC7] text-fail-fg hover:bg-fail-bg"
          : "border-neutral-200 text-neutral-900 hover:bg-app-bg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function DarkButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="inline-flex items-center justify-center whitespace-nowrap rounded-[3px] border border-neutral-900 bg-neutral-900 px-3.5 py-[5px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white transition hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
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
