"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CkCard, CkChip, CkStatusPill, CkPagination, TicketLink, PRLinks } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import { WindowSelector } from "@/components/cockpit/controls";
import { SpotlightTrigger } from "@/components/cockpit/spotlight-search";
import { windowPhrase, type TimeWindow } from "@/lib/window";
import { cancelRun } from "@/lib/api/client";
import { runModelLabel } from "@/lib/run-model";
import { hasActiveRun, useRunRefresh } from "@/lib/use-run-refresh";
import { RunRefreshControl } from "@/components/cockpit/run-refresh-control";
import type { RunsResponse } from "@shared/contracts";
import { Button } from "@/components/ui/button";
import {
  formatRunAge,
  RUN_STATUS_FILTERS,
  runIdentity,
  runStatusHref,
  type RunStatusFilter,
} from "@/lib/runs-display";

const PAGE_SIZE = 25;
const EM_DASH = "\u2014";

type CancelFeedback = { tone: "success" | "info" | "warn" | "error"; message: string };

const FEEDBACK_TONE_CLASS: Record<CancelFeedback["tone"], string> = {
  success: "text-success-fg",
  info: "text-neutral-700",
  warn: "text-neutral-800",
  error: "text-fail-fg",
};

export function RunsScreen({
  data,
  window,
  q,
  status = "all",
  canCancel = false,
}: {
  data: RunsResponse;
  window: TimeWindow;
  q: string;
  status?: RunStatusFilter;
  /** Owners and admins only, mirroring the worker's dispatch-role gate on the
   *  cancel endpoint. */
  canCancel?: boolean;
}) {
  const { openRun } = useCockpit();
  const router = useRouter();
  const [lastGoodData, setLastGoodData] = useState<RunsResponse | null>(
    () => (data.available ? data : null),
  );
  useEffect(() => {
    if (data.available) setLastGoodData(data);
  }, [data]);
  const stale = !data.available && lastGoodData !== null;
  const shownData = stale ? lastGoodData : data;
  // Never "off": the row set itself is what this screen watches, so a list whose
  // visible runs have all finished still has to notice the next run starting.
  const { isRefreshing, refresh } = useRunRefresh({
    key: "runs-desktop",
    cadence: shownData.rows.some((run) => hasActiveRun(run.status))
      ? "live"
      : "idle",
  });
  const [filter, setFilter] = useState<RunStatusFilter>(status);
  const [page, setPage] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, CancelFeedback>>({});
  useEffect(() => {
    setFilter(status);
    setPage(0);
  }, [status]);
  const filtered = filter === "all" ? shownData.rows : shownData.rows.filter((r) => r.status === filter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const paged = filtered.slice(start, start + PAGE_SIZE);
  const showActions = canCancel && filtered.some((run) => run.status === "running");

  function changeFilter(next: RunStatusFilter) {
    setFilter(next);
    setPage(0);
    router.replace(runStatusHref({ status: next, window, q }), { scroll: false });
  }

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
    <div className="flex flex-col gap-4 px-4 pb-8 pt-5 lg:px-6">
      {/* Spotlight ticket search (⌘K) and global window control, same placement across screens */}
      <div className="flex items-center justify-between gap-4">
        <SpotlightTrigger />
        <div className="flex items-center gap-2">
          <WindowSelector value={window} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Workflow runs</div>
        <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">
          {filtered.length} runs · {windowPhrase(window)}
          {q && <span className="text-neutral-500"> · matching “{q}”</span>}
        </h2>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex flex-wrap gap-1.5">
          {RUN_STATUS_FILTERS.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={filter === item.id ? "selected" : "secondary"}
              aria-pressed={filter === item.id}
              onClick={() => changeFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <RunRefreshControl
          isRefreshing={isRefreshing}
          error={stale ? "Refresh failed; showing last good data." : null}
          onRefresh={refresh}
        />
      </div>

      <CkCard pad={0}>
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-neutral-100 text-neutral-700 font-mono text-[10px] uppercase tracking-[0.06em]">
              {["Status", "Ticket · title", "Workflow", "Model", "Started", "Duration", "Tokens", "Cost", ...(showActions ? ["Actions"] : [])].map((h, i) =>
                <th key={i} className={`px-3 py-2.5 font-medium border-b border-neutral-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 && (
              <tr>
                <td colSpan={showActions ? 9 : 8} className="px-3 py-10 text-center font-body text-[13px] text-neutral-500">
                  {q
                    ? `No runs match “${q}” in the ${windowPhrase(window)}.`
                    : `No runs in the ${windowPhrase(window)}.`}
                </td>
              </tr>
            )}
            {paged.map((r, i) => {
              const showCancel = canCancel && r.status === "running";
              const rowFeedback = feedback[r.id];
              const identity = runIdentity(r);
              return (
              <tr
                key={r.id}
                role="button"
                tabIndex={0}
                aria-label={`Open run ${r.id}: ${identity.primary}`}
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
                    <span className="block font-semibold text-neutral-900 max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap">{identity.primary}</span>
                    <div className="flex items-center gap-1.5 flex-wrap [&_a]:min-h-6">
                      {identity.showTicketLink && <TicketLink ticket={r.ticket} url={r.ticketUrl} />}
                      <PRLinks run={r} />
                      {identity.showRunIdMeta && <span className="font-mono text-[10px] text-neutral-500">{r.id}</span>}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <CkChip>{r.workflowName}</CkChip>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-neutral-700">{r.model ? runModelLabel(r.model) : EM_DASH}</td>
                <td className="px-3 py-2.5 text-right font-mono text-[11px] text-neutral-500">{formatRunAge(r.startedAtMin)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium">{r.duration === null ? EM_DASH : `${r.duration}s`}</td>
                <td className="px-3 py-2.5 text-right font-mono text-neutral-700">{r.tokens === null ? EM_DASH : `${(r.tokens / 1000).toFixed(1)}k`}</td>
                <td className="px-3 py-2.5 text-right font-mono font-medium">{r.cost === null ? EM_DASH : `$${r.cost.toFixed(2)}`}</td>
                {showActions && <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-col items-end gap-1">
                    {showCancel ? (
                      confirmId === r.id ? (
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          <span className="font-mono text-[10px] text-neutral-700 whitespace-nowrap">Cancel run?</span>
                          <Button
                            disabled={busyId === r.id}
                            onClick={() => handleCancel(r.id)}
                            type="button"
                          >
                            {busyId === r.id ? "Cancelling…" : "Confirm"}
                          </Button>
                          <Button
                            disabled={busyId === r.id}
                            onClick={() => setConfirmId(null)}
                            type="button"
                            variant="secondary"
                          >
                            Keep running
                          </Button>
                        </div>
                      ) : (
                        <Button variant="danger" onClick={() => setConfirmId(r.id)} type="button">
                          Cancel
                        </Button>
                      )
                    ) : null}
                    {rowFeedback ? (
                      <span className={`font-mono text-[10px] whitespace-nowrap ${FEEDBACK_TONE_CLASS[rowFeedback.tone]}`}>
                        {rowFeedback.message}
                      </span>
                    ) : null}
                  </div>
                </td>}
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
