export interface FailedTicketMeta {
  runId: string;
  error: string;
  failedAt: string;
}

/**
 * What started a run: 'ticket' is the classic AI-column trigger, 'pr_trigger'
 * covers the PR webhook triggers. Stored on active_runs.run_kind (default
 * 'ticket'); reconcile and the Jira webhook branch on it.
 */
export type RunKind = "ticket" | "pr_trigger";

export type RunClaimState = "reserved" | "bound";

export interface RunReservation {
  subjectKey: string;
  ticketKey: string | null;
  ownerToken: string;
  kind: RunKind;
}

export interface ActiveRunEntry extends RunReservation {
  runId: string | null;
  state: RunClaimState;
  createdAt: number;
  updatedAt: number;
}

export interface RunRegistryAdapter {
  /** Atomically reserve an unclaimed provider-neutral subject. */
  reserve(reservation: RunReservation): Promise<boolean>;
  /** A workflow candidate CAS-binds itself; retries/losers cannot overwrite it. */
  bindRun(subjectKey: string, ownerToken: string, runId: string): Promise<boolean>;
  /** Owner-only handoff is permitted only while the reservation remains unbound. */
  handoff(subjectKey: string, currentOwnerToken: string, nextOwnerToken: string): Promise<boolean>;
  get(subjectKey: string): Promise<ActiveRunEntry | null>;
  /** Discard a reservation only before any workflow candidate has bound it. */
  releaseReservation(subjectKey: string, ownerToken: string): Promise<boolean>;
  /** Owner/run matching terminal compare-and-delete. The boolean gates pending drain. */
  release(subjectKey: string, ownerToken: string, runId: string): Promise<boolean>;
  listAll(): Promise<ActiveRunEntry[]>;

  /** Register every externally allocated sandbox under the exact active owner. */
  registerSandbox(subjectKey: string, ownerToken: string, sandboxId: string): Promise<void>;
  listSandboxes(subjectKey: string, ownerToken: string): Promise<string[]>;

  /** Mark a ticket as failed (moveTicket to backlog failed in catch block). */
  markFailed(ticketKey: string, meta: FailedTicketMeta): Promise<void>;
  /** Check if a ticket has a failure marker. */
  isTicketFailed(ticketKey: string): Promise<boolean>;
  /** List all failed ticket markers. */
  listAllFailed(): Promise<Array<{ ticketKey: string; meta: FailedTicketMeta }>>;
  /** Remove the failure marker for a ticket. */
  clearFailedMark(ticketKey: string): Promise<void>;
}

/**
 * Per-ticket Slack thread parent store. Implemented alongside RunRegistryAdapter
 * by PostgresRunRegistry, but exposed as a separate interface so the messaging
 * adapter only depends on the slice it needs.
 *
 * Lifetime: an entry survives across multiple workflow runs for the same
 * ticket. Terminal run release does NOT clear it — see clearParent().
 */
export interface ThreadStore {
  /** Returns the Slack message id (timestamp) anchoring this ticket's thread, or null. */
  getParent(ticketKey: string): Promise<string | null>;
  /** Records the message id as the parent for this ticket. Overwrites any prior value. */
  setParent(ticketKey: string, messageId: string): Promise<void>;
  /** Removes the entry. Used after Slack reports the parent message no longer exists. */
  clearParent(ticketKey: string): Promise<void>;
}
