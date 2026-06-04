"use client";

import React, { useState } from "react";
import { CkCard, CkChip, CkStatusPill, CkTabs, TicketLink, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { RunsResponse } from "@shared/contracts";

export function RunsScreen({ data }: { data: RunsResponse }) {
  const { openRun } = useCockpit();
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? data.rows : data.rows.filter((r) => r.status === filter);

  return (
    <div className="flex flex-col gap-4 px-6 pt-5 pb-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Workflow runs</div>
          <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">{data.total} runs · last 24h</h2>
        </div>
        <div className="flex gap-2">
          <CkTabs active={filter} onChange={setFilter} tabs={[
            { id: "all", label: "All" },
            { id: "success", label: "Success" },
            { id: "running", label: "Running" },
            { id: "awaiting", label: "Awaiting input" },
            { id: "failed", label: "Failed" },
            { id: "blocked", label: "Blocked" }]
          } />
          <button className="appearance-none border border-neutral-200 bg-panel px-3 py-1.5 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">+ Filter</button>
          <button className="appearance-none border border-neutral-900 bg-neutral-900 text-white px-3 py-1.5 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] cursor-pointer">Export ↓</button>
        </div>
      </div>

      <CkCard pad={0}>
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-neutral-100 text-neutral-700 font-mono text-[10px] uppercase tracking-[0.06em]">
              {["Status", "Ticket · title", "Workflow", "Model", "Started", "Duration", "Tokens", "Cost", "Eval", "Guard"].map((h, i) =>
                <th key={i} className={`px-3 py-2.5 font-medium border-b border-neutral-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) =>
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
                className={`cursor-pointer hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mariner focus-visible:outline-offset-[-2px] ${i < filtered.length - 1 ? "border-b border-neutral-200" : ""}`}
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
                <td className="px-3 py-2.5 text-right">
                  {r.evalScore === null ?
                    <span className="font-mono text-[11px] text-neutral-300">—</span> :
                    <span className={`font-mono text-[11px] font-semibold ${r.evalScore > 0.9 ? "text-success-fg" : r.evalScore > 0.85 ? "text-[#7A5A00]" : "text-fail-fg"}`}>{(r.evalScore * 100).toFixed(0)}</span>}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {r.guardrailHits !== null && r.guardrailHits > 0 ?
                    <CkChip tone="warn">{r.guardrailHits}</CkChip> :
                    <span className="font-mono text-[11px] text-neutral-300">—</span>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CkCard>
    </div>
  );
}
