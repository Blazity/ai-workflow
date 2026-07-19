export interface FailedTicketMeta {
  runId: string;
  error: string;
  failedAt: string;
}

export interface FailedTicketOwner {
  subjectKey: string;
  ownerToken: string;
  runId: string;
}

/**
 * What started a run: 'ticket' is the classic AI-column trigger, 'pr_trigger'
 * covers the PR webhook triggers. Stored on active_runs.run_kind (default
 * 'ticket'); reconcile and the Jira webhook branch on it.
 */
export type RunKind = "ticket" | "pr_trigger";

/** Unbound reservations stop occupying capacity and become ineligible to bind
 * after this grace period. Both checks must use the same boundary. */
export const RESERVATION_BIND_GRACE_MS = 5 * 60 * 1000;

export type RunClaimState =
  | "reserved"
  | "bound"
  | "parking"
  | "parked"
  | "cancelling";

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

/** Ticket cancellation release CAS. `null` means reconciliation observed no
 * human status fence; the guarded delete then requires that none appeared
 * before release. */
export interface TicketCancellationReleaseGuard {
  latestFenceId: number | null;
  mutationVersion: number;
}

export interface RunRegistryAdapter {
  /** Atomically reserve an unclaimed provider-neutral subject. */
  reserve(reservation: RunReservation): Promise<boolean>;
  /** A workflow candidate CAS-binds its fresh reservation; retries, losers, and
   * candidates whose capacity grace expired cannot overwrite it. */
  bindRun(subjectKey: string, ownerToken: string, runId: string): Promise<boolean>;
  /** Exact clarification registration barrier. Repeating it while the same run
   * is already parking is successful; no later sandbox registration can win. */
  beginParking(subjectKey: string, ownerToken: string, runId: string): Promise<boolean>;
  /** Atomically clears the exact predecessor's drained registrations and marks
   * it eligible for clarification handoff. */
  finishParking(subjectKey: string, ownerToken: string, runId: string): Promise<boolean>;
  /** Owner-only handoff is permitted only while the reservation remains unbound. */
  handoff(subjectKey: string, currentOwnerToken: string, nextOwnerToken: string): Promise<boolean>;
  /**
   * Clarification-only CAS: hand one exact drained `parked` run to an unbound
   * successor reservation. `finishParking` has already cleared the exact
   * predecessor's sandbox registrations before this transition is eligible.
   */
  handoffBoundRun?(
    subjectKey: string,
    currentOwnerToken: string,
    currentRunId: string,
    nextOwnerToken: string,
  ): Promise<boolean>;
  /** Clarification-only rollback: restore an admitted successor reservation to
   * its exact parked predecessor without ever dropping the subject claim. */
  restoreParkedRun?(
    subjectKey: string,
    successorOwnerToken: string,
    predecessorOwnerToken: string,
    predecessorRunId: string,
  ): Promise<boolean>;
  get(subjectKey: string): Promise<ActiveRunEntry | null>;
  /** Atomically closes an exact owner to new binds, handoffs, and sandbox
   * registrations before cancellation enumerates its external resources. */
  beginCancellation(
    subjectKey: string,
    ownerToken: string,
    runId: string | null,
  ): Promise<boolean>;
  /** Exact compare-and-delete for a claim already closed by beginCancellation. */
  releaseCancellation(
    subjectKey: string,
    ownerToken: string,
    runId: string | null,
    ticketGuard?: TicketCancellationReleaseGuard,
  ): Promise<boolean>;
  /** Discard a reservation only before any workflow candidate has bound it. */
  releaseReservation(subjectKey: string, ownerToken: string): Promise<boolean>;
  /** Atomically discard only a reservation whose bind grace has expired.
   * Database-backed implementations use their database clock so cleanup and
   * bind eligibility share one monotonic boundary. */
  releaseExpiredReservation?(subjectKey: string, ownerToken: string): Promise<boolean>;
  /** Owner/run matching terminal compare-and-delete. The boolean gates pending drain. */
  release(subjectKey: string, ownerToken: string, runId: string): Promise<boolean>;
  listAll(): Promise<ActiveRunEntry[]>;
  /** Capacity-only view. Implementations may omit safely parked owners, while
   * listAll remains the source of truth for ownership and reconciliation. */
  listCapacityConsumers?(): Promise<ActiveRunEntry[]>;

  /** Register every externally allocated sandbox under the exact active owner.
   * Callers with a bound Workflow id can also require that exact run. */
  registerSandbox(
    subjectKey: string,
    ownerToken: string,
    sandboxId: string,
    runId?: string,
  ): Promise<void>;
  unregisterSandbox?(
    subjectKey: string,
    ownerToken: string,
    sandboxId: string,
  ): Promise<boolean>;
  listSandboxes(subjectKey: string, ownerToken: string): Promise<string[]>;

  /** Mark a ticket as failed only while the exact bound run still owns it.
   * Rolling compatibility for old callers is enforced by the database trigger,
   * not by weakening this source contract. */
  markFailed(
    ticketKey: string,
    meta: FailedTicketMeta,
    owner: FailedTicketOwner,
  ): Promise<void>;
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
