"use client";

import { useRouter } from "next/navigation";
import { CkChip, CkStatusPill, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { TicketRunsResponse } from "@shared/contracts";

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
}

/** "← All runs" header shown above a run's trace on mobile (no split view). */
export function MobileBackToRuns({ ticketKey }: { ticketKey: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/ticket/${encodeURIComponent(ticketKey)}`)}
      className="self-start appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-mariner cursor-pointer uppercase tracking-[0.04em]"
    >
      ← All runs · {ticketKey}
    </button>
  );
}

export function TicketMobileScreen({
  ticketKey,
  data,
}: {
  ticketKey: string;
  data: TicketRunsResponse;
}) {
  const { openRun } = useCockpit();
  const { ticket, runs, totals } = data;

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-6">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] text-neutral-500">{ticket?.key ?? ticketKey}</span>
        <h2 className="font-display text-xl font-medium text-neutral-900 m-0">
          {ticket?.title || ticketKey}
        </h2>
        <div className="flex items-center gap-2 flex-wrap font-mono text-[11px] text-neutral-700 mt-1">
          <CkChip tone="coal">{fmtCost(totals.cost)}</CkChip>
          <span>{fmtTokens(totals.tokens)} tok</span>
          <span className="text-neutral-300">·</span>
          <span>{totals.runCount} {totals.runCount === 1 ? "run" : "runs"}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {runs.length === 0 && (
          <div className="bg-panel border border-neutral-200 rounded-sm px-4 py-8 text-center font-body text-[13px] text-neutral-500">
            No runs recorded for {ticketKey}.
          </div>
        )}
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => openRun(r)}
            className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm p-3.5 active:bg-neutral-100"
          >
            <div className="flex items-center gap-2">
              <CkStatusPill status={r.status} />
              <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <CkChip>{r.workflowName}</CkChip>
              {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3 pt-2.5 border-t border-neutral-200 font-mono">
              <div>
                <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">Dur</div>
                <div className="text-[13px] font-semibold text-neutral-900">{r.duration === null ? "—" : `${r.duration}s`}</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">Cost</div>
                <div className="text-[13px] font-semibold text-neutral-900">{r.cost === null ? "—" : fmtCost(r.cost)}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
