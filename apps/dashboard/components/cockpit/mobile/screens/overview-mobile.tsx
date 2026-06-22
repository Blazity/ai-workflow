// apps/dashboard/components/cockpit/mobile/screens/overview-mobile.tsx
"use client";

import { useState } from "react";

import { CkKPI, CkChip, CkStatusPill, TicketLink, CkPagination } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import { WindowSelector } from "@/components/cockpit/controls";
import { windowPhrase, windowShort, type TimeWindow } from "@/lib/window";
import type { OverviewScreenData } from "@/components/cockpit/screens/overview";

export function OverviewMobileScreen({
  data,
  window,
}: {
  data: OverviewScreenData;
  window: TimeWindow;
}) {
  const { openRun } = useCockpit();
  const k = data.kpis;
  const wShort = windowShort(window);

  const PAGE_SIZE = 6;
  const [runsPage, setRunsPage] = useState(0);
  const allRecent = data.recentRuns.rows;
  const recent = allRecent.slice(
    runsPage * PAGE_SIZE,
    runsPage * PAGE_SIZE + PAGE_SIZE,
  );
  const runsTotalPages = Math.max(1, Math.ceil(allRecent.length / PAGE_SIZE));

  const liveRows = data.liveRuns.rows;
  const running = liveRows.filter((r) => r.status === "running");
  const awaiting = liveRows.filter((r) => r.status === "awaiting");
  const workflows = data.workflows.rows;

  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">{windowPhrase(window)}</div>
          <h2 className="font-display text-xl font-medium text-neutral-900 m-0">Overview</h2>
        </div>
        <WindowSelector value={window} size="sm" />
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <CkKPI label={`Runs ${wShort}`} value={k.runs24h ? k.runs24h.value.toLocaleString("en-US") : "—"} />
        <CkKPI label="p95" value={k.p95 ? `${k.p95.valueSec}s` : "—"} />
        <CkKPI label={`Errors ${wShort}`} value={k.errors24h ? k.errors24h.value.toString() : "—"} />
        <CkKPI label={`Cost ${wShort}`} value={k.cost24h ? `$${k.cost24h.value.toFixed(0)}` : "—"} />
      </div>

      {running.length > 0 && (
        <div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-mariner mb-2">Now running · {running.length}</div>
          <div className="flex flex-col gap-2">
            {running.map((r) => (
              <button
                key={r.id}
                onClick={() => openRun(r)}
                className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm px-3 py-2.5 active:bg-neutral-100"
              >
                <div className="flex items-center gap-2">
                  <CkStatusPill status="running" />
                  <span className="font-semibold text-[13px] text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap flex-1">{r.workflowName}</span>
                  {r.elapsed != null && <span className="font-mono text-[10px] text-neutral-500">{r.elapsed.toFixed(1)}s</span>}
                </div>
                {r.currentSpan && (
                  <>
                    <div className="mt-2 h-1.5 bg-app-bg rounded-[1px] overflow-hidden">
                      <div className="h-full bg-mariner rounded-[1px]" style={{ width: `${(r.progress ?? 0) * 100}%` }} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px]">
                      <span className="text-neutral-900 font-medium overflow-hidden text-ellipsis whitespace-nowrap flex-1">{r.currentSpan}</span>
                      <span className="text-neutral-500">{r.spanIndex ?? "—"}/{r.spansTotal ?? "—"}</span>
                    </div>
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-[#A2351C] mb-2">Input needed · {awaiting.length}</div>
          <div className="flex flex-col gap-2">
            {awaiting.map((r) => (
              <div key={r.id} className="bg-[#FFFCFA] border border-[#FFE4D6] rounded-sm px-3 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <CkStatusPill status="awaiting" />
                  <span
                    onClick={() => openRun(r)}
                    className="font-semibold text-[13px] text-neutral-900 cursor-pointer"
                  >{r.workflowName}</span>
                  {r.ticket && r.ticketUrl && <TicketLink ticket={r.ticket} url={r.ticketUrl} />}
                  {typeof r.askedAtMin === "number" && (
                    <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.askedAtMin}m ago</span>
                  )}
                </div>
                {r.question && (
                  <p className="font-body text-[13px] leading-[1.5] text-neutral-800 m-0 mt-2 border-l-2 border-burnt-orange pl-2.5">{r.question}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-neutral-500 mb-2">Recent runs</div>
        <div className="flex flex-col gap-2">
          {recent.map((r) => (
            <button
              key={r.id}
              onClick={() => openRun(r)}
              className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm px-3 py-2.5 flex items-center gap-2.5 active:bg-neutral-100"
            >
              <CkStatusPill status={r.status} />
              <span className="font-semibold text-[13px] text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap flex-1">{r.ticketTitle}</span>
              <TicketLink ticket={r.ticket} url={r.ticketUrl} />
            </button>
          ))}
        </div>
        {allRecent.length > PAGE_SIZE && (
          <div className="mt-2 border border-neutral-200 rounded-sm overflow-hidden">
            <CkPagination
              page={runsPage}
              totalPages={runsTotalPages}
              total={allRecent.length}
              start={runsPage * PAGE_SIZE}
              shown={recent.length}
              onChange={setRunsPage}
            />
          </div>
        )}
      </div>

      {workflows.length > 0 && (
        <div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-neutral-500 mb-2">Workflows</div>
          <div className="flex flex-col gap-2">
            {workflows.map((w) => (
              <div key={w.id} className="bg-panel border border-neutral-200 rounded-sm px-3 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-[13px] text-neutral-900">{w.name}</span>
                  {w.primary && <CkChip tone="mariner">primary</CkChip>}
                  <span className="font-mono text-[10px] text-neutral-500">· {w.gateway}</span>
                </div>
                <div className="grid grid-cols-4 gap-2 mt-2.5 pt-2 border-t border-neutral-200">
                  <Stat label="Runs" value={w.runs24h === null ? "—" : w.runs24h.toLocaleString("en-US")} />
                  <Stat label="p95" value={w.p95 === null ? "—" : `${w.p95}s`} />
                  <Stat label="Err" value={w.errRate === null ? "—" : `${(w.errRate * 100).toFixed(1)}%`} />
                  <Stat label="Cost" value={w.costToday === null ? "—" : `$${w.costToday.toFixed(0)}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono">
      <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">{label}</div>
      <div className="text-[13px] font-semibold text-neutral-900">{value}</div>
    </div>
  );
}
