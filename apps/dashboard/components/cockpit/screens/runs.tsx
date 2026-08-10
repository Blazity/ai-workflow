"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { CkCard, CkChip, CkStatusPill, CkTabs, CkPagination, TicketLink, PRLinks } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import { WindowSelector } from "@/components/cockpit/controls";
import { SpotlightTrigger } from "@/components/cockpit/spotlight-search";
import { windowPhrase, type TimeWindow } from "@/lib/window";
import { cancelRun } from "@/lib/api/cancel-run";
import type { RunsResponse } from "@shared/contracts";

const PAGE_SIZE = 25;

type CancelFeedback = { tone: "success" | "info" | "warn" | "error"; message: string };

const FEEDBACK_TONE_CLASS: Record<CancelFeedback["tone"], string> = {
  success: "text-success-fg",
  info: "text-neutral-700",
  warn: "text-[#7A5A00]",
  error: "text-fail-fg",
};

export function RunsScreen({
  data,
  window,
  q,
  canCancel = false,
}: {
  data: RunsResponse;
  window: TimeWindow;
  q: string;
  /** Owners and admins only, mirroring the worker's dispatch-role gate on the
   *  cancel endpoint. */
  canCancel?: boolean;
}) {
  const { openRun } = useCockpit();
  const router = useRouter();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, CancelFeedback>>({});
  const filtered = filter === "all" ? data.rows : data.rows.filter((r) => r.status === filter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const paged = filtered.slice(start, start + PAGE_SIZE);

  async function handleCancel(runId: string) {
    setBusyId(runId);
    setFeedback((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    const result = await cancelRun(runId);
    setBusyId(null);
    // Only drop the confirm arm this cancel resolved, not one a different row
    // armed while this request was in flight.
    setConfirmId((c) => (c === runId ? null : c));
    switch (result.outcome) {
      case "cancelled":
        setFeedback((c) => ({ ...c, [runId]: { tone: "success", message: "Run cancelled." } }));
        router.refresh();
        break;
      case "already_terminal":
        setFeedback((c) => ({ ...c, [runId]: { tone: "info", message: "Run had already ended." } }));
        router.refresh();
        break;
      case "unconfirmed":
        setFeedback((c) => ({
          ...c,
          [runId]: { tone: "warn", message: "Could not confirm the cancel. Try again." },
        }));
        break;
      case "forbidden":
        setFeedback((c) => ({
          ...c,
          [runId]: { tone: "error", message: "You do not have permission to cancel this run." },
        }));
        break;
      case "not_found":
        setFeedback((c) => ({ ...c, [runId]: { tone: "error", message: "Run not found." } }));
        break;
      case "error":
        setFeedback((c) => ({ ...c, [runId]: { tone: "error", message: "Something went wrong. Try again." } }));
        break;
    }
  }

  return (
    <div className="flex flex-col gap-4 px-6 pt-5 pb-8">
      {/* Spotlight ticket search (⌘K) + global window control — same placement across screens */}
      <div className="flex items-center justify-between gap-4">
        <SpotlightTrigger />
        <div className="flex items-center gap-2">
          <WindowSelector value={window} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Workflow runs</div>
        <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">
          {data.total} runs · {windowPhrase(window)}
          {q && <span className="text-neutral-500"> · matching “{q}”</span>}
        </h2>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <CkTabs active={filter} onChange={(f) => { setFilter(f); setPage(0); }} tabs={[
          { id: "all", label: "All" },
          { id: "success", label: "Success" },
          { id: "running", label: "Running" },
          { id: "awaiting", label: "Awaiting input" },
          { id: "failed", label: "Failed" },
          { id: "blocked", label: "Blocked" }]
        } />
      </div>

      <CkCard pad={0}>
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-neutral-100 text-neutral-700 font-mono text-[10px] uppercase tracking-[0.06em]">
              {["Status", "Ticket · title", "Workflow", "Model", "Started", "Duration", "Tokens", "Cost", "Actions"].map((h, i) =>
                <th key={i} className={`px-3 py-2.5 font-medium border-b border-neutral-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center font-body text-[13px] text-neutral-500">
                  {q
                    ? `No runs match “${q}” in the ${windowPhrase(window)}.`
                    : `No runs in the ${windowPhrase(window)}.`}
                </td>
              </tr>
            )}
            {paged.map((r, i) => {
              const showCancel = canCancel && r.status === "running";
              const rowFeedback = feedback[r.id];
              return (
              <tr
                key={r.id}
                role="button"
                tabIndex={0}
                aria-label={`Open run ${r.id}: ${r.ticketTitle}`}
                onClick={() => openRun(r)}
                onKeyDown={(event) => {
                  // Ignore keydowns that bubbled up from a nested control (the
                  // Cancel button below), otherwise Enter on that button would
                  // also open the run instead of activating the button.
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openRun(r);
                  }
                }}
                className={`cursor-pointer hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px] ${i < paged.length - 1 ? "border-b border-neutral-200" : ""}`}
              >
                <td className="px-3 py-2.5"><CkStatusPill status={r.status} /></td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col gap-1">
                    <span className="block font-semibold text-neutral-900 max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap">{r.ticketTitle}</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                      <PRLinks run={r} />
                      <span className="font-mono text-[10px] text-neutral-500">{r.id}</span>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <CkChip>{r.workflowName}</CkChip>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-neutral-700">{r.model}</td>
                <td className="px-3 py-2.5 text-right font-mono text-[11px] text-neutral-500">{r.startedAtMin}m ago</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium">{r.duration === null ? "—" : `${r.duration}s`}</td>
                <td className="px-3 py-2.5 text-right font-mono text-neutral-700">{r.tokens === null ? "—" : `${(r.tokens / 1000).toFixed(1)}k`}</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium">{r.cost === null ? "—" : `$${r.cost.toFixed(2)}`}</td>
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-col items-end gap-1">
                    {showCancel ? (
                      confirmId === r.id ? (
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          <span className="font-mono text-[10px] text-neutral-700 whitespace-nowrap">Cancel run?</span>
                          <DarkButton
                            disabled={busyId === r.id}
                            onClick={() => handleCancel(r.id)}
                            type="button"
                          >
                            {busyId === r.id ? "Cancelling…" : "Confirm"}
                          </DarkButton>
                          <GhostButton
                            disabled={busyId === r.id}
                            onClick={() => setConfirmId(null)}
                            type="button"
                          >
                            Keep running
                          </GhostButton>
                        </div>
                      ) : (
                        <GhostButton danger onClick={() => setConfirmId(r.id)} type="button">
                          Cancel
                        </GhostButton>
                      )
                    ) : null}
                    {rowFeedback ? (
                      <span className={`font-mono text-[10px] whitespace-nowrap ${FEEDBACK_TONE_CLASS[rowFeedback.tone]}`}>
                        {rowFeedback.message}
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        <CkPagination
          page={page}
          totalPages={totalPages}
          total={filtered.length}
          start={start}
          shown={paged.length}
          onChange={setPage}
        />
      </CkCard>
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
