import type { Run, RunStatus } from "@shared/contracts";

export interface SearchHit {
  id: string;
  ticket: string;
  ticketTitle: string;
  workflowName: string;
  status: RunStatus;
  startedAtMin: number;
  runCount: number;
}

/**
 * Collapse run rows into one hit per ticket. Input is newest-first, so the kept
 * row is the newest run of each ticket; additional runs only bump `runCount`.
 * Ticketless rows (gate runs) stay individual. Insertion order is preserved.
 */
export function dedupeHitsByTicket(rows: Run[]): SearchHit[] {
  const byTicket = new Map<string, SearchHit>();
  const out: SearchHit[] = [];
  for (const r of rows) {
    const hit: SearchHit = {
      id: r.id,
      ticket: r.ticket,
      ticketTitle: r.ticketTitle,
      workflowName: r.workflowName,
      status: r.status,
      startedAtMin: r.startedAtMin,
      runCount: 1,
    };
    if (!r.ticket) {
      out.push(hit);
      continue;
    }
    const existing = byTicket.get(r.ticket);
    if (existing) {
      existing.runCount += 1;
    } else {
      byTicket.set(r.ticket, hit);
      out.push(hit);
    }
  }
  return out;
}
