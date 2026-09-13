import type { Run, RunStatus } from "@shared/contracts";
import type { TimeWindow } from "./window";

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
