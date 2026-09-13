// apps/dashboard/components/cockpit/mobile/screens/runs-mobile.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CkStatusPill, CkChip, TicketLink, PRLinks } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import { WindowSelector } from "@/components/cockpit/controls";
import { windowPhrase, type TimeWindow } from "@/lib/window";
import { cancelRun } from "@/lib/api/client";
import { hasActiveRun, useRunRefresh } from "@/lib/use-run-refresh";
import { RunRefreshControl } from "@/components/cockpit/run-refresh-control";
import type { RunsResponse } from "@shared/contracts";
import { Button } from "@/components/ui/button";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Success" },
  { id: "running", label: "Running" },
  { id: "awaiting", label: "Awaiting input" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
];

const EM_DASH = "\u2014";

type CancelFeedback = { tone: "success" | "info" | "warn" | "error"; message: string };

const FEEDBACK_TONE_CLASS: Record<CancelFeedback["tone"], string> = {
  success: "text-success-fg",
  info: "text-neutral-700",
  warn: "text-neutral-800",
  error: "text-fail-fg",
};

export function RunsMobileScreen({
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
  const [lastGoodData, setLastGoodData] = useState<RunsResponse | null>(
    () => (data.available ? data : null),
  );
  useEffect(() => {
    if (data.available) setLastGoodData(data);
  }, [data]);
  const stale = !data.available && lastGoodData !== null;
  const shownData = stale ? lastGoodData : data;
  // Never "off", see the desktop list: new runs have to be able to show up.
  const { isRefreshing, refresh } = useRunRefresh({
    key: "runs-mobile",
    cadence: shownData.rows.some((run) => hasActiveRun(run.status))
      ? "live"
      : "idle",
  });
  const [filter, setFilter] = useState("all");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, CancelFeedback>>({});
  const rows = filter === "all" ? shownData.rows : shownData.rows.filter((r) => r.status === filter);

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
    <div className="flex flex-col gap-3 px-4 pt-4 pb-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Workflow runs</div>
          <h2 className="font-display text-xl font-medium text-neutral-900 m-0">{shownData.total} runs · {windowPhrase(window)}</h2>
        </div>
        <div className="flex flex-col items-end gap-2">
          <WindowSelector value={window} size="sm" />
          <RunRefreshControl
            isRefreshing={isRefreshing}
            error={stale ? "Refresh failed; showing last good data." : null}
            onRefresh={refresh}
          />
        </div>
      </div>

      {/* Horizontally scrollable filter chips */}
      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className="flex-none"
            variant={filter === f.id ? "selected" : "secondary"}
          >{f.label}</Button>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        {rows.length === 0 && (
          <div className="bg-panel border border-neutral-200 rounded-sm px-4 py-8 text-center font-body text-[13px] text-neutral-500">
            {q
              ? `No runs match “${q}” in the ${windowPhrase(window)}.`
              : `No runs in the ${windowPhrase(window)}.`}
          </div>
        )}
        {rows.map((r) => {
          const showCancel = canCancel && r.status === "running";
          const rowFeedback = feedback[r.id];
          return (
          // A real button (Cancel, below) cannot nest inside another button,
          // so the row itself is a div playing the button role,
          // matching the desktop table's <tr role="button"> for the same reason.
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            aria-label={`Open run ${r.id}: ${r.ticketTitle}`}
            onClick={() => openRun(r)}
            onKeyDown={(event) => {
              // Ignore keydowns bubbled up from the nested Cancel control,
              // otherwise Enter on that button would also open the run.
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openRun(r);
              }
            }}
            className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm p-3.5 active:bg-neutral-100"
          >
            <div className="flex items-center gap-2">
              <CkStatusPill status={r.status} />
              {showCancel && confirmId !== r.id ? (
                <Button
                  variant="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmId(r.id);
                  }}
                  type="button"
                >
                  Cancel
                </Button>
              ) : null}
              <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
            </div>
            {showCancel && confirmId === r.id ? (
              <div
                className="flex items-center gap-1.5 flex-wrap mt-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="font-mono text-[10px] text-neutral-700">Cancel run?</span>
                <Button disabled={busyId === r.id} onClick={() => handleCancel(r.id)} type="button">
                  {busyId === r.id ? "Cancelling…" : "Confirm"}
                </Button>
                <Button variant="secondary" disabled={busyId === r.id} onClick={() => setConfirmId(null)} type="button">
                  Keep running
                </Button>
              </div>
            ) : null}
            {rowFeedback ? (
              <div className={`font-mono text-[10px] mt-1.5 ${FEEDBACK_TONE_CLASS[rowFeedback.tone]}`}>
                {rowFeedback.message}
              </div>
            ) : null}
            <div className="font-semibold text-neutral-900 text-[14px] mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{r.ticketTitle}</div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <TicketLink ticket={r.ticket} url={r.ticketUrl} />
              <PRLinks run={r} />
              <CkChip>{r.workflowName}</CkChip>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3 pt-2.5 border-t border-neutral-200 font-mono">
              <Metric label="Dur" value={r.duration === null ? EM_DASH : `${r.duration}s`} />
              <Metric label="Cost" value={r.cost === null ? EM_DASH : `$${r.cost.toFixed(2)}`} />
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "fail" }) {
  const color = tone === "ok" ? "text-success-fg" : tone === "warn" ? "text-neutral-800" : tone === "fail" ? "text-fail-fg" : "text-neutral-900";
  return (
    <div>
      <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">{label}</div>
      <div className={`text-[13px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}
