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
  /** Remove the ticket -> runId mapping (also clears any linked sandboxId). */
  unregister(ticketKey: string): Promise<void>;
  /** Get all tracked ticket -> runId pairs. */
  listAll(): Promise<Array<{ ticketKey: string; runId: string }>>;

  /**
   * Record the sandboxId that backs this ticket's workflow. Lets cleanup
   * paths (reconcile, cancelRun, webhook-cancel) stop the sandbox by id
   * instead of listing all sandboxes and inspecting each one's checked-out
   * branch.
   */
  registerSandbox(ticketKey: string, sandboxId: string): Promise<void>;
  /** Get the sandboxId for a ticket, or null if none registered. */
  getSandboxId(ticketKey: string): Promise<string | null>;

  /**
   * Wall-clock timestamp (ms since epoch) when the ticket's current entry
   * was first recorded, or null if unknown. Reconcile uses this to skip
   * cleanup of entries that look like orphans but are actually mid-
   * transition — without this, a cron tick that fires between a ticket
   * entering the registry and its Jira transition completing would wipe
   * the entry as a "stale orphan".
   */
  getEntryCreatedAt(ticketKey: string): Promise<number | null>;

  /** Mark a ticket as failed (moveTicket to backlog failed in catch block). */
  markFailed(ticketKey: string, meta: FailedTicketMeta): Promise<void>;
  /** Check if a ticket has a failure marker. */
  isTicketFailed(ticketKey: string): Promise<boolean>;
  /** List all failed ticket markers. */
  listAllFailed(): Promise<Array<{ ticketKey: string; meta: FailedTicketMeta }>>;
  /** Remove the failure marker for a ticket. */
  clearFailedMark(ticketKey: string): Promise<void>;
}
