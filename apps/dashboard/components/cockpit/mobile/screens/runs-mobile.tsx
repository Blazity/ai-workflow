// apps/dashboard/components/cockpit/mobile/screens/runs-mobile.tsx
"use client";

import { useState } from "react";
import { CkStatusPill, CkChip, TicketLink, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { RunsResponse } from "@shared/contracts";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Success" },
  { id: "running", label: "Running" },
  { id: "awaiting", label: "Awaiting input" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
];

export function RunsMobileScreen({ data }: { data: RunsResponse }) {
  const { openRun } = useCockpit();
  const [filter, setFilter] = useState("all");
  const rows = filter === "all" ? data.rows : data.rows.filter((r) => r.status === filter);

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-6">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Workflow runs</div>
        <h2 className="font-display text-xl font-medium text-neutral-900 m-0">{data.total} runs · 24h</h2>
      </div>

      {/* Horizontally scrollable filter chips */}
      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`flex-none appearance-none cursor-pointer px-3 py-1.5 rounded-[3px] border font-mono text-[11px] uppercase tracking-[0.04em] ${
              filter === f.id ? "bg-neutral-900 text-white border-neutral-900" : "bg-panel text-neutral-700 border-neutral-200"
            }`}
          >{f.label}</button>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <button
            key={r.id}
            onClick={() => openRun(r)}
            className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm p-3.5 active:bg-neutral-100"
          >
            <div className="flex items-center gap-2">
              <CkStatusPill status={r.status} />
              <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
            </div>
            <div className="font-semibold text-neutral-900 text-[14px] mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{r.ticketTitle}</div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <TicketLink ticket={r.ticket} url={r.ticketUrl} />
              {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
              <CkChip>{r.workflowName}</CkChip>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3 pt-2.5 border-t border-neutral-200 font-mono">
              <Metric label="Dur" value={r.duration === null ? "—" : `${r.duration}s`} />
              <Metric label="Cost" value={r.cost === null ? "—" : `$${r.cost.toFixed(2)}`} />
              <Metric
                label="Eval"
                value={r.evalScore === null ? "—" : `${(r.evalScore * 100).toFixed(0)}`}
                tone={r.evalScore === null ? undefined : r.evalScore > 0.9 ? "ok" : r.evalScore > 0.85 ? "warn" : "fail"}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "fail" }) {
  const color = tone === "ok" ? "text-success-fg" : tone === "warn" ? "text-[#7A5A00]" : tone === "fail" ? "text-fail-fg" : "text-neutral-900";
  return (
    <div>
      <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">{label}</div>
      <div className={`text-[13px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}
