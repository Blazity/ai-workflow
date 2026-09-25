import type { Run, RunStatus, RunsResponse } from "@shared/contracts";
import { windowMinutes, type TimeWindow } from "./window";

export type RunStatusFilter = "all" | RunStatus;

export const RUN_STATUS_FILTERS: ReadonlyArray<{
  id: RunStatusFilter;
  label: string;
}> = [
  { id: "all", label: "ALL" },
  { id: "success", label: "SUCCESS" },
  { id: "running", label: "RUNNING" },
  { id: "awaiting", label: "AWAITING INPUT" },
  { id: "failed", label: "FAILED" },
  { id: "blocked", label: "BLOCKED" },
];

const RUN_STATUS_FILTER_IDS = new Set(
  RUN_STATUS_FILTERS.map((filter) => filter.id),
);

export function parseRunStatusFilter(value: unknown): RunStatusFilter {
  return typeof value === "string" && RUN_STATUS_FILTER_IDS.has(value as RunStatusFilter)
    ? (value as RunStatusFilter)
    : "all";
}

export function runStatusHref({
  status,
  window,
  q,
}: {
  status: RunStatusFilter;
  window: TimeWindow;
  q: string;
}): string {
  const params = new URLSearchParams();
  if (window !== "24h") params.set("window", window);
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  const query = params.toString();
  return query ? `/runs?${query}` : "/runs";
}

export function runIdentity(run: Pick<Run, "id" | "ticket" | "ticketTitle">): {
  primary: string;
  showTicketLink: boolean;
  showRunIdMeta: boolean;
} {
  const ticket = run.ticket.trim();
  const title = run.ticketTitle.trim();
  if (!ticket) {
    return { primary: run.id, showTicketLink: false, showRunIdMeta: false };
  }
  const distinctTitle = title !== "" && title !== ticket;
  return {
    primary: distinctTitle ? title : ticket,
    showTicketLink: distinctTitle,
    showRunIdMeta: true,
  };
}

/**
 * What a run list is counting, told apart.
 *
 * A run belongs to a window when it started inside it: that is the worker's
 * definition, for its list and for the Overview's "Runs" tile alike. The list a
 * screen shows also carries runs the live board adds because they are still
 * open, a run parked days ago on a question among them. Those are listed, since
 * somebody has to act on them, but counting them as the window's runs put two
 * numbers for one window on two screens (QA: 27 on the Overview, 30 on Runs).
 */
export interface ListedRunsTally {
  /** Runs of the filter that started inside the window. */
  inWindow: number;
  /** Listed runs of the filter that started earlier and wait for an answer. */
  olderAwaiting: number;
  /** Listed runs of the filter that started earlier and are still running. */
  olderRunning: number;
}

export function tallyListedRuns(
  data: Pick<RunsResponse, "rows" | "total" | "counts">,
  filter: RunStatusFilter,
  window: TimeWindow,
): ListedRunsTally {
  const reach = windowMinutes(window);
  // Only an open run can be listed from before the window: the store lists the
  // window's runs, and the live board adds the ones still running or waiting.
  const older = data.rows.filter(
    (run) =>
      run.startedAtMin >= reach &&
      (run.status === "awaiting" || run.status === "running") &&
      (filter === "all" || run.status === filter),
  );
  const olderAwaiting = older.filter((run) => run.status === "awaiting").length;
  const olderRunning = older.length - olderAwaiting;
  const listed = filter === "all" ? data.total : data.counts[filter];
  return { inWindow: Math.max(0, listed - older.length), olderAwaiting, olderRunning };
}

function runs(count: number): string {
  return count === 1 ? "run" : "runs";
}

/** The line under a heading that names the older open runs it lists, or null
 *  when it lists none. */
export function olderOpenRunsSentence(tally: ListedRunsTally): string | null {
  const { olderAwaiting, olderRunning } = tally;
  if (olderAwaiting > 0 && olderRunning > 0) {
    return `Also listed: ${olderAwaiting} older ${runs(olderAwaiting)} still waiting for input and ${olderRunning} still running.`;
  }
  if (olderAwaiting > 0) {
    return `Also listed: ${olderAwaiting} older ${runs(olderAwaiting)} still waiting for input.`;
  }
  if (olderRunning > 0) {
    return `Also listed: ${olderRunning} older ${runs(olderRunning)} still running.`;
  }
  return null;
}
