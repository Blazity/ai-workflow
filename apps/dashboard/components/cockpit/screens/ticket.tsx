"use client";

import { CkChip, CkStatusPill } from "@/components/ui";
import { useTicketSelection } from "@/components/cockpit/screens/ticket-selection";
import type { TicketRunsResponse } from "@shared/contracts";

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
}
/** "2 success · 1 failed" — only nonzero buckets, in a stable order. */
function outcomeSummary(counts: TicketRunsResponse["totals"]["counts"]): string {
  const order: (keyof typeof counts)[] = ["success", "running", "awaiting", "failed", "blocked"];
  return order
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`)
    .join(" · ");
}

/**
 * Header rollup + runs rail. Renders into the `header` and `rail` grid areas of
 * the ticket page; the trace lives in a sibling `detail` boundary, so selecting
 * a run never re-renders or refetches this shell. The active run is derived from
 * the URL on the client (plus an optimistic pending id) so the highlight moves
 * the instant you click, before the server responds.
 */
export function TicketScreen({
  ticketKey,
  data,
}: {
  ticketKey: string;
  data: TicketRunsResponse;
}) {
  const { ticket, runs, totals } = data;
  const title = ticket?.title || ticketKey;

  const { select, pendingRun, urlRun } = useTicketSelection();
  // Default to the newest run (runs[0]) — mirrors pickSelectedRunId, which the
  // detail panel uses when `?run=` is absent, so the rail highlight matches what
  // the trace shows.
  const activeId = pendingRun ?? urlRun ?? runs[0]?.id ?? null;

  const onSelect = (runId: string) => {
    if (runId === activeId) return;
    select(runId);
  };

  return (
    <>
      {/* Sticky rollup header — spans both columns */}
      <div
        style={{ gridArea: "header" }}
        className="flex flex-col gap-2 px-6 pt-5 pb-4 border-b border-neutral-200 bg-app-bg"
      >
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="font-mono text-[11px] text-neutral-700">{ticket?.key ?? ticketKey}</span>
          {ticket?.url && (
            <a
              href={ticket.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-mariner no-underline"
            >
              Open ticket ↗
            </a>
          )}
        </div>
        <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">
          {title}
        </h2>
        <div className="flex items-center gap-2 flex-wrap font-mono text-[11px] text-neutral-700">
          <CkChip tone="coal">{fmtCost(totals.cost)}</CkChip>
          <span>{fmtTokens(totals.tokens)} tok</span>
          <span className="text-neutral-300">·</span>
          <span>{totals.runCount} {totals.runCount === 1 ? "run" : "runs"}</span>
          {outcomeSummary(totals.counts) && (
            <>
              <span className="text-neutral-300">·</span>
              <span>{outcomeSummary(totals.counts)}</span>
            </>
          )}
        </div>
      </div>

      {/* Runs rail */}
      <nav
        aria-label={`Runs for ${ticketKey}`}
        style={{ gridArea: "rail" }}
        className="border-r border-neutral-200 overflow-y-auto min-h-0 bg-panel"
      >
        {runs.length === 0 ? (
          <div className="px-6 py-16 text-center font-body text-[13px] text-neutral-500">
            No runs recorded for {ticketKey}.
          </div>
        ) : (
          runs.map((r) => {
            const active = r.id === activeId;
            return (
              <button
                key={r.id}
                type="button"
                aria-current={active}
                onClick={() => onSelect(r.id)}
                className={`relative w-full appearance-none border-0 border-b border-neutral-200 cursor-pointer text-left flex flex-col gap-1.5 px-4 py-3 ${
                  active ? "bg-mariner-100" : "bg-panel hover:bg-neutral-100"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-mariner" aria-hidden="true" />
                )}
                <div className="flex items-center gap-2">
                  <CkStatusPill status={r.status} />
                  <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
                </div>
                {r.statusReason && (r.status === "blocked" || r.status === "failed") && (
                  <div
                    className="font-mono text-[10px] text-neutral-500 truncate"
                    title={r.statusReason}
                  >
                    {r.statusReason}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-neutral-700">
                  <span className="truncate">{r.model}</span>
                  <span className="shrink-0">{r.cost === null ? "—" : fmtCost(r.cost)}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px] text-neutral-500">
                  <span className="truncate">{r.id}</span>
                  {r.prNumber && <span className="shrink-0">PR #{r.prNumber}</span>}
                </div>
              </button>
            );
          })
        )}
      </nav>
    </>
  );
}
