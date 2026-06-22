"use client";

import React, { useState } from "react";
import { CkCard, CkChip, CkStatusPill, CkTabs, CkPagination, TicketLink, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import { WindowSelector, LivePollControl } from "@/components/cockpit/controls";
import { SpotlightTrigger } from "@/components/cockpit/spotlight-search";
import { windowPhrase, type TimeWindow } from "@/lib/window";
import type { RunsResponse } from "@shared/contracts";

const PAGE_SIZE = 25;

export function RunsScreen({
  data,
  window,
  q,
}: {
  data: RunsResponse;
  window: TimeWindow;
  q: string;
}) {
  const { openRun } = useCockpit();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = filter === "all" ? data.rows : data.rows.filter((r) => r.status === filter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const paged = filtered.slice(start, start + PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4 px-6 pt-5 pb-8">
      {/* Spotlight ticket search (⌘K) + global window control — same placement across screens */}
      <div className="flex items-center justify-between gap-4">
        <SpotlightTrigger />
        <div className="flex items-center gap-2">
          <LivePollControl />
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
              {["Status", "Ticket · title", "Workflow", "Model", "Started", "Duration", "Tokens", "Cost"].map((h, i) =>
                <th key={i} className={`px-3 py-2.5 font-medium border-b border-neutral-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center font-body text-[13px] text-neutral-500">
                  {q
                    ? `No runs match “${q}” in the ${windowPhrase(window)}.`
                    : `No runs in the ${windowPhrase(window)}.`}
                </td>
              </tr>
            )}
            {paged.map((r, i) =>
              <tr
                key={r.id}
                role="button"
                tabIndex={0}
                aria-label={`Open run ${r.id}: ${r.ticketTitle}`}
                onClick={() => openRun(r)}
                onKeyDown={(event) => {
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
                    <div className="flex items-center gap-1.5">
                      <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                      {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
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
              </tr>
            )}
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
