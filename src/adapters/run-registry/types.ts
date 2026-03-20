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
}
