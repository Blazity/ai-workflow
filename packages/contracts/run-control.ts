/**
 * Run control as something outside the product asks for it, and as core
 * answers.
 *
 * A person types a command in a chat app. Deciding which runs are live,
 * cancelling one, and clearing a stuck claim are the product's own business,
 * and every messaging provider would otherwise re-implement them. So the
 * provider verifies the request, turns it into one of these commands, and
 * renders the answer in its own markup; core decides and answers in data.
 *
 * The answers carry values, never sentences: a provider that received prose
 * could only paste it, and the day a second provider ships, its copy would be
 * ours rather than its own. The one exception is `reason` on a failure a
 * provider is expected to show verbatim.
 */

/** What the person asked for. Closed: core answers exactly these. */
export type RunControlCommand =
  | { readonly kind: "list" }
  | { readonly kind: "status"; readonly ticketKey: string }
  | { readonly kind: "cancel"; readonly ticketKey: string; readonly actor?: string }
  | { readonly kind: "inspect"; readonly ticketKey: string }
  | { readonly kind: "summary" }
  | { readonly kind: "reset"; readonly ticketKey: string };

/** One live run, with the link a person can open. */
export interface RunControlRun {
  readonly ticketKey: string;
  readonly runId: string;
  /** Deep link to the ticket, built by core from the tracker it talks to. */
  readonly ticketUrl: string;
}

/** A ticket core remembers having failed, and when. */
export interface RunControlFailedRun {
  readonly ticketKey: string;
  readonly runId: string;
  readonly ticketUrl: string;
  readonly failedAt: string;
}

/** What a cancel did. `not_tracked` is not a failure: there was nothing to stop. */
export type RunControlCancelOutcome =
  | "cancelled"
  | "cancelled_mid_dispatch"
  | "not_tracked"
  | "unconfirmed"
  | "claim_not_cleared";

/** What a reset can clear. A name per row it touches, never a sentence. */
export type RunControlResetTarget = "reservation" | "failure_mark" | "conversation";

export interface RunControlResetOutcome {
  readonly cleared: readonly RunControlResetTarget[];
  readonly failures: readonly {
    readonly target: RunControlResetTarget;
    readonly reason: string;
  }[];
  /**
   * An active run holds this ticket. Reset deliberately does not touch it, and
   * the person needs to be told that cancel is the command that would.
   */
  readonly blockedByActiveRun: boolean;
}

/** Everything core knows about one ticket's place in the registry. */
export interface RunControlEntry {
  readonly ticketKey: string;
  readonly ticketUrl: string;
  readonly runId: string | null;
  readonly sandboxId: string | null;
  /** ISO 8601, or null when the registry holds no entry. */
  readonly claimedAt: string | null;
  /** The messaging conversation this ticket is anchored on, if any. */
  readonly conversation: string | null;
  readonly failed: boolean;
}

/** Core's answer, as data a provider renders. */
export type RunControlAnswer =
  | { readonly kind: "runs"; readonly runs: readonly RunControlRun[] }
  | {
      readonly kind: "run_status";
      readonly ticketKey: string;
      readonly ticketUrl: string;
      readonly runId: string | null;
      readonly hasSandbox: boolean;
    }
  | {
      readonly kind: "cancelled";
      readonly ticketKey: string;
      readonly ticketUrl: string;
      readonly runId: string | null;
      readonly outcome: RunControlCancelOutcome;
    }
  | { readonly kind: "entry"; readonly entry: RunControlEntry }
  | {
      readonly kind: "registry";
      readonly active: readonly RunControlRun[];
      readonly failed: readonly RunControlFailedRun[];
    }
  | {
      readonly kind: "reset";
      readonly ticketKey: string;
      readonly ticketUrl: string;
      readonly outcome: RunControlResetOutcome;
    };

/**
 * What a provider is handed after core has run the command.
 *
 * `failed` exists because the work happens after the acknowledgement a chat
 * app is timing: without it, a handler that throws leaves the person reading
 * "Working on ..." for ever.
 *
 * A failure carries a `reference` and NOT the error. What went wrong inside
 * core (a failed query quotes its SQL and its parameters) is written to the
 * worker's log under that reference, and the integration writes the sentence
 * a person reads, which names the reference so an admin can find the line.
 * Core's error text is not for a chat channel, which may be shared with
 * another company. What the person typed is the integration's to remember
 * (in its own `deliverTo`), so the sentence can say what did not happen.
 */
export type RunControlOutcome =
  | { readonly kind: "answered"; readonly answer: RunControlAnswer }
  | {
      readonly kind: "failed";
      /** The id the worker's log line for this failure carries. */
      readonly reference: string;
    };
