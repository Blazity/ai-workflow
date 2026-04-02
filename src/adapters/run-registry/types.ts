export interface FailedTicketMeta {
  runId: string;
  error: string;
  failedAt: string;
}

export interface RunRegistryAdapter {
  /** Atomically claim a ticket key if not already taken. Returns true if claimed. */
  claim(ticketKey: string, runId: string): Promise<boolean>;
  /** Overwrite the mapping for a ticket (use after claim to update with real runId). */
  register(ticketKey: string, runId: string): Promise<void>;
  /** Get the runId for a ticket, or null if none registered. */
  getRunId(ticketKey: string): Promise<string | null>;
  /** Remove the ticket -> runId mapping. */
  unregister(ticketKey: string): Promise<void>;
  /** Get all tracked ticket -> runId pairs. */
  listAll(): Promise<Array<{ ticketKey: string; runId: string }>>;

  /** Mark a ticket as failed (moveTicket to backlog failed in catch block). */
  markFailed(ticketKey: string, meta: FailedTicketMeta): Promise<void>;
  /** Check if a ticket has a failure marker. */
  isTicketFailed(ticketKey: string): Promise<boolean>;
  /** List all failed ticket markers. */
  listAllFailed(): Promise<Array<{ ticketKey: string; meta: FailedTicketMeta }>>;
  /** Remove the failure marker for a ticket. */
  clearFailedMark(ticketKey: string): Promise<void>;
}
