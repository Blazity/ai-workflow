// apps/dashboard/components/cockpit/mobile/screens/overview-mobile.tsx
"use client";

import { useState } from "react";
import Link from "next/link";

import { CkKPI, CkChip, CkStatusPill, TicketLink, CkPagination } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import { WindowSelector } from "@/components/cockpit/controls";
import { windowPhrase, windowShort, type TimeWindow } from "@/lib/window";
import type { OverviewScreenData } from "@/components/cockpit/screens/overview";
import { Button } from "@/components/ui/button";

const EM_DASH = "\u2014";

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
        <CkKPI label={`Runs ${wShort}`} value={k.runs24h ? k.runs24h.value.toLocaleString("en-US") : EM_DASH} />
        <CkKPI label="p95" value={k.p95 ? `${k.p95.valueSec}s` : EM_DASH} />
        <CkKPI label={`Errors ${wShort}`} value={k.errors24h ? k.errors24h.value.toString() : EM_DASH} />
        <CkKPI label={`Cost ${wShort}`} value={k.cost24h ? `$${k.cost24h.value.toFixed(0)}` : EM_DASH} />
      </div>

      {running.length > 0 && (
        <div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-mariner mb-2">Now running · {running.length}</div>
          <div className="flex flex-col gap-2">
            {running.map((r) => (
              <Button
                key={r.id}
                onClick={() => openRun(r)}
                variant="secondary"
                className="h-auto w-full justify-start px-0 py-0 normal-case tracking-normal"
              >
                <span className="flex w-full flex-col px-3 py-2.5 text-left">
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
                      <span className="text-neutral-500">{r.spanIndex ?? EM_DASH}/{r.spansTotal ?? EM_DASH}</span>
                    </div>
                  </>
                )}
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div>
          <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-fail-fg mb-2">Input needed · {awaiting.length}</div>
          <div className="flex flex-col gap-2">
            {awaiting.map((r) => {
              // A plan parked for human approval has no clarification: send
              // the card to Approvals instead of the run trace's answer form.
              const isApproval = r.awaitingKind === "approval";
              return (
                // Anchors are not allowed inside buttons, so the card is a div
                // with a stretched overlay control as the TicketLink's sibling;
                // the relative wrapper keeps the link on top and clickable.
                <div
                  key={r.id}
                  className="relative rounded-sm border border-orange-200 bg-orange-100 px-3 py-2.5 active:bg-orange-200"
                >
                  {isApproval ? (
                    <Link
                      href="/approvals"
                      aria-label={`Review plan: ${r.workflowName}`}
                      className="appearance-none absolute inset-0 cursor-pointer rounded-sm"
                    />
                  ) : (
                    <Button
                      type="button"
                      onClick={() => openRun(r)}
                      aria-label={`Open run: ${r.workflowName}`}
                      variant="ghost"
                      className="absolute inset-0 h-auto w-full"
                    >
                      <span className="sr-only">{r.workflowName}</span>
                    </Button>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <CkStatusPill status="awaiting" />
                    <span className="font-semibold text-[13px] text-neutral-900">{r.workflowName}</span>
                    {r.ticket && r.ticketUrl && (
                      <span className="relative">
                        <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                      </span>
                    )}
                    {typeof r.askedAtMin === "number" && (
                      <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.askedAtMin}m ago</span>
                    )}
                  </div>
                  {isApproval ? (
                    <p className="font-body text-[13px] leading-[1.5] text-neutral-700 m-0 mt-2">
                      Plan submitted for approval before this run continues.
                    </p>
                  ) : (
                    r.question && (
                      <p className="font-body text-[13px] leading-[1.5] text-neutral-800 m-0 mt-2 border-l-2 border-burnt-orange pl-2.5">{r.question}</p>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-neutral-500 mb-2">Recent runs</div>
        <div className="flex flex-col gap-2">
          {recent.map((r) => (
            <Button
              key={r.id}
              onClick={() => openRun(r)}
              variant="secondary"
              className="h-auto w-full justify-start px-3 py-2.5 normal-case tracking-normal"
            >
              <CkStatusPill status={r.status} />
              <span className="font-semibold text-[13px] text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap flex-1">{r.ticketTitle}</span>
              <TicketLink ticket={r.ticket} url={r.ticketUrl} />
            </Button>
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
                  <Stat label="Runs" value={w.runs24h === null ? EM_DASH : w.runs24h.toLocaleString("en-US")} />
                  <Stat label="p95" value={w.p95 === null ? EM_DASH : `${w.p95}s`} />
                  <Stat label="Err" value={w.errRate === null ? EM_DASH : `${(w.errRate * 100).toFixed(1)}%`} />
                  <Stat label="Cost" value={w.costToday === null ? EM_DASH : `$${w.costToday.toFixed(0)}`} />
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
