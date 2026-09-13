"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CkChip, CkStatusPill, PRLinks } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { TicketRunsResponse } from "@shared/contracts";
import { hasActiveRun, useRunRefresh } from "@/lib/use-run-refresh";
import { RunRefreshControl } from "@/components/cockpit/run-refresh-control";
import { Button } from "@/components/ui/button";
import { NavItem } from "@/components/ui/nav-item";
import { formatRunAge } from "@/lib/runs-display";

const EM_DASH = "\u2014";

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
    <NavItem
      type="button"
      onClick={() => router.push(`/ticket/${encodeURIComponent(ticketKey)}`)}
      label={`← All runs · ${ticketKey}`}
      className="self-start px-0 text-mariner hover:bg-transparent"
    />
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
  const [lastGoodData, setLastGoodData] = useState<TicketRunsResponse | null>(
    () => (data.available ? data : null),
  );
  useEffect(() => {
    if (data.available) setLastGoodData(data);
  }, [data]);
  const stale = !data.available && lastGoodData !== null;
  const shownData = stale ? lastGoodData : data;
  const { ticket, runs, totals } = shownData;
  // A ticket's run list, so never "off": a retry creates a new run to show.
  const { isRefreshing, refresh } = useRunRefresh({
    key: "ticket-mobile",
    cadence: runs.some((run) => hasActiveRun(run.status)) ? "live" : "idle",
  });

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
        <RunRefreshControl
          isRefreshing={isRefreshing}
          error={stale ? "Refresh failed; showing last good data." : null}
          onRefresh={refresh}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        {runs.length === 0 && (
          <div className="bg-panel border border-neutral-200 rounded-sm px-4 py-8 text-center font-body text-[13px] text-neutral-500">
            No runs recorded for {ticketKey}.
          </div>
        )}
        {runs.map((r) => (
          <Button
            key={r.id}
            onClick={() => openRun(r)}
            className="h-auto w-full justify-start p-0 normal-case tracking-normal"
            variant="secondary"
          >
            <span className="flex w-full flex-col p-3.5 text-left">
            <div className="flex items-center gap-2">
              <CkStatusPill status={r.status} />
              <span className="ml-auto font-mono text-[10px] text-neutral-500">{formatRunAge(r.startedAtMin)}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap [&_a]:min-h-6">
              <CkChip>{r.workflowName}</CkChip>
              <PRLinks run={r} />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3 pt-2.5 border-t border-neutral-200 font-mono">
              <div>
                <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">Dur</div>
                <div className="text-[13px] font-semibold text-neutral-900">{r.duration === null ? EM_DASH : `${r.duration}s`}</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">Cost</div>
                <div className="text-[13px] font-semibold text-neutral-900">{r.cost === null ? EM_DASH : fmtCost(r.cost)}</div>
              </div>
            </div>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
