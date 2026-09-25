/**
 * The words memory records are written in: events, sources, topics, trust,
 * status. One list each, read by the code that writes them and by the check
 * constraints of `memory_events` and `memory_entry_state`, so a word missing
 * here is refused by the database as well as by the compiler.
 *
 * Kept apart from the table schemas so the memory module can name them
 * without reaching a table: nothing here imports drizzle.
 */

/** What an entry is about: closed, each with a fixed description in the core.
 *  Missing or unknown is `other`. */
export const MEMORY_TOPICS = [
  "setup",
  "commands",
  "testing",
  "ci-deploy",
  "structure",
  "conventions",
  "data",
  "integrations",
  "domain",
  "other",
] as const;
export type MemoryTopic = (typeof MEMORY_TOPICS)[number];

/** How sure an entry's placement is. */
export const MEMORY_AREA_STATUSES = ["resolved", "ambiguous", "directory_only", "unresolved"] as const;
export type MemoryAreaStatus = (typeof MEMORY_AREA_STATUSES)[number];

/** What backs an entry. */
export const MEMORY_TRUSTS = ["human", "derived", "checked", "learned"] as const;
export type MemoryTrust = (typeof MEMORY_TRUSTS)[number];

/** Whether an entry is usable. */
export const MEMORY_ENTRY_STATUSES = ["active", "disputed", "stale", "retired"] as const;
export type MemoryEntryStatus = (typeof MEMORY_ENTRY_STATUSES)[number];

/** The kinds of entry that carry a state: facts and lessons, never notebooks. */
export const MEMORY_STATE_KINDS = ["facts", "lessons"] as const;
export type MemoryStateKind = (typeof MEMORY_STATE_KINDS)[number];

/** At most this many candidate areas are kept for an ambiguous placement. */
export const MAX_MEMORY_AREA_CANDIDATES = 8;
/** At most this many anchors per entry. */
export const MAX_MEMORY_ANCHORS = 5;

/** One open dispute on an entry. `reason` is the dispute's screened words,
 *  cleaned of secrets on the way in and again on the way out; null when they
 *  could not be cleaned and were not stored. */
export interface MemoryOpenDispute {
  readonly runId: string;
  readonly ticketKey: string | null;
  readonly outcome: string;
  readonly evidence: string;
  readonly reason: string | null;
}

/**
 * Every memory event, one closed list. The table's check constraint is written
 * from this list, so a word missing here is refused by the database as well as
 * by the compiler; adding one is a generated migration that drops and re-adds
 * `memory_events_event_check`.
 *
 * Where each word comes from: the memory rebuild plan (D3 and D10) and the
 * quality design's ledger additions. A forget is `removed` with reason
 * `forgotten`; there is no separate word for it.
 */
export const MEMORY_EVENT_KINDS = [
  // What a prompt build handed the agent and what it left out.
  "recalled",
  // Writes and their refusals.
  "added",
  "updated",
  "removed",
  "duplicate",
  "rejected",
  "redacted",
  "unavailable",
  "contradicted",
  "confirmed",
  "superseded_by_store",
  "imported",
  "store_changed",
  // The ticket notebook.
  "notebook_saved",
  "notebook_withheld",
  "notebook_absent",
  "notebook_truncated",
  // Org knowledge by proposal.
  "proposed_org",
  "promoted",
  "kept_local",
  "dismissed",
  "moved",
  // Placement, trust and status.
  "classified",
  "reclassified",
  "pinned",
  "unpinned",
  "trust_changed",
  "disputed",
  "dispute_resolved",
  "stale",
  "unstale",
  "reanchored",
  "rederived",
  "retired",
  "restored",
  // Learning waits for acceptance.
  "proposed",
  "proposal_applied",
  "proposal_held",
  "proposal_dropped",
  "reviewed",
  // What each invocation read, looked up and reported.
  "feedback_rejected",
  "lookup_rejected",
  "lookups",
  "collected",
  "hooks_unobserved",
  "tree_unwritten",
  "focus_unmatched",
  "sweep_skipped",
] as const;
export type MemoryEventKind = (typeof MEMORY_EVENT_KINDS)[number];

/** Which path wrote the fact an event is about. */
export const MEMORY_EVENT_SOURCES = [
  "distill",
  "feedback",
  "human",
  "seed",
  "sweep",
  "acceptance",
  "system",
] as const;
export type MemoryEventSource = (typeof MEMORY_EVENT_SOURCES)[number];

/** What an event's entry is: a fact or lesson of a subject, or a ticket notebook. */
export const MEMORY_EVENT_ENTRY_KINDS = ["facts", "lessons", "notebook"] as const;
export type MemoryEventEntryKind = (typeof MEMORY_EVENT_ENTRY_KINDS)[number];

/** Who did it: a run, the worker on its own (a sweep, an acceptance), a
 *  person on the dashboard, or an MCP client. */
export type MemoryEventActor = "run" | "system" | `admin:${string}` | `mcp:${string}`;

/**
 * The resolutions that end a proposal's wait for its pull request. A held
 * proposal waits for a human instead, so for the PR it is resolved too.
 */
export const MEMORY_PROPOSAL_RESOLUTIONS = [
  "proposal_applied",
  "proposal_held",
  "proposal_dropped",
] as const satisfies readonly MemoryEventKind[];

/**
 * One item of an event's detail that carries memory text: an entry a recall
 * sent or left out, an item a write lost, a claim of a distill. Only here, in
 * `text` and in `previous_text` does the ledger hold memory text, which is
 * what lets a forget find and blank every copy. `textHash` is the normalised
 * text hash of `text` as it was stored; it stays when the text is blanked.
 */
export interface MemoryEventDetailItem {
  readonly text?: string | null;
  readonly textHash?: string | null;
  readonly [field: string]: unknown;
}

/**
 * The small structured part of an event: codes, ids, counts and the items
 * above. Free text belongs in `items[].text` and nowhere else in it.
 * `textWithheld` says the texts of this row were not stored because they
 * could not be cleaned of this deployment's secrets.
 */
export interface MemoryEventDetail {
  readonly items?: readonly MemoryEventDetailItem[];
  readonly textWithheld?: "unreadable" | "unscrubbable";
  readonly [field: string]: unknown;
}
