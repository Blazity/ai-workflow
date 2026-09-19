/**
 * The words the briefing and round views use for the values a worker records.
 *
 * Every function here takes an open slug. A value this build has no words for
 * is shown as itself, never as "other" and never dropped: the worker deploys
 * separately and may know values the dashboard does not yet.
 */
import {
  AGENT_BRIEFING_CUT_CAUSES,
  isKnownSlug,
  type AgentBriefingOrigin,
  type AgentBriefingPart,
  type AgentBriefingRepository,
  type AgentBriefingWorkScopeEntry,
  type ClarificationDelivery,
  type ClarificationReading,
  type MissingBriefingReason,
} from "@shared/agent-visibility";
import { REPOSITORY_RELATIONSHIP_KINDS } from "@shared/contracts";

function labelFrom(labels: Record<string, string>, value: string): string {
  return Object.hasOwn(labels, value) ? labels[value]! : value;
}

/* ── Why a briefing is missing ─────────────────────────────────────────── */

export interface MissingSentence {
  /** Short, for a heading or a chip. */
  title: string;
  /** What happened and what it means for "what did the agent get". */
  body: string;
  /** The recorded failure, when there is one, shown as it was recorded. */
  failure: string | null;
  tone: "waiting" | "lost" | "not_kept";
}

const ATTEMPT_ENDINGS: Record<string, string> = {
  cancelled: "was cancelled",
  skipped: "was skipped",
  failed: "failed",
};

export function missingBriefingSentence(reason: MissingBriefingReason): MissingSentence {
  switch (reason.kind) {
    case "not_sent_yet":
      return {
        title: "Not sent yet",
        body: "This attempt is still preparing its prompt. The briefing appears here once the prompt goes out.",
        failure: null,
        tone: "waiting",
      };
    case "never_sent": {
      const ending =
        reason.attemptState === null ? "ended" : (ATTEMPT_ENDINGS[reason.attemptState] ?? `ended as ${reason.attemptState}`);
      return {
        title: "Never sent",
        body: `This attempt ${ending} before its prompt went out, so the agent got nothing.`,
        failure: reason.failure ? `${reason.failure.category}: ${reason.failure.message}` : null,
        tone: "lost",
      };
    }
    case "not_recorded": {
      const causes: Record<string, string> = {
        predates_capture:
          "This attempt ran on a version of AI Workflow from before briefings were recorded, so what the agent got was not kept.",
        capture_disabled:
          "Recording briefings was switched off when this attempt ran, so what the agent got was not kept.",
        capture_skipped:
          "The prompt went out, but writing its briefing failed or was refused. The worker logged a warning for this run and attempt.",
      };
      return {
        title: "Not recorded",
        body: Object.hasOwn(causes, reason.cause)
          ? causes[reason.cause]!
          : `The worker recorded the cause "${reason.cause}", which this dashboard has no words for yet.`,
        failure: null,
        tone: "not_kept",
      };
    }
    case "expired":
      return {
        title: "Expired",
        body: "This briefing was recorded, then removed together with the run's replay when retention ran out.",
        failure: null,
        tone: "not_kept",
      };
  }
}

/* ── What a run can still say ──────────────────────────────────────────── */

export interface RunStateSentence {
  title: string;
  body: string;
  tone: "waiting" | "lost" | "not_kept";
}

/**
 * The run's own state, for the case the per-attempt reasons cannot reach:
 * after retention a run has no attempts at all, and an empty list on its own
 * reads as "we lost it" rather than "we kept it and retention removed it".
 * `available` has nothing to say, and so returns null.
 */
export function runStateSentence(state: string): RunStateSentence | null {
  switch (state) {
    case "available":
      return null;
    case "expired":
      return {
        title: "These briefings expired",
        body: "What this run's agents were sent was recorded and kept with the run's replay, then removed when its retention ran out. Nothing was lost by accident.",
        tone: "not_kept",
      };
    case "replay_gone":
      return {
        title: "This run's replay is gone",
        body: "The replay this run's briefings were stored with is no longer held, so what its agents were sent went with it.",
        tone: "not_kept",
      };
    case "predates_capture":
      return {
        title: "This run predates briefings",
        body: "This run finished before AI Workflow recorded what agents are sent, so there is nothing to show for it. Runs from after that change carry their prompts.",
        tone: "not_kept",
      };
    default:
      return {
        title: "This run is in a state this dashboard does not know",
        body: `The worker recorded the state "${state}", which this build has no words for yet. A newer dashboard will say what it means.`,
        tone: "not_kept",
      };
  }
}

/* ── Sends ─────────────────────────────────────────────────────────────── */

/** What one send was, in the words of the pass that made it. */
export function sendTitle(identity: { kind: string; passLabel?: string | undefined }): string {
  const kinds: Record<string, string> = {
    discovery: "Repository discovery",
    agent: "Agent pass",
    llm: "Model call",
  };
  const kind = labelFrom(kinds, identity.kind);
  return identity.passLabel ? `${kind}: ${identity.passLabel}` : kind;
}

/* ── Origins ───────────────────────────────────────────────────────────── */

const ORIGIN_LABELS: Record<string, string> = {
  platform: "Our rule",
  ticket: "Ticket",
  ticket_comment: "Ticket comment",
  attachment: "Attachment",
  clarification: "Clarification answer",
  run: "Run",
  workspace: "Workspace",
  research_plan: "Research plan",
  pull_request: "Pull request",
  review_result: "Review result",
  pre_sandbox: "Before the sandbox",
  repository_discovery: "Repository discovery",
  research_note: "Run note",
  block_prompt: "Block prompt",
  bound_data: "Bound data",
  prompt_slot: "Prompt slot",
  preview_example: "Preview example",
  profile: "Harness profile",
  repository_file: "Repository file",
  repository_rules: "Repository rules",
  repo_memory: "Repository memory",
  repository_selection: "Repository selection",
  repository_catalog: "Repository catalog",
  repository: "Repository instructions",
  memory: "Memory",
  block: "Block prompt",
  runtime: "Run data",
  discovery: "Discovery prompt",
  system: "System prompt",
};

/** Our own rule text, as opposed to anything the run or a person contributed. */
export function isOurs(origin: AgentBriefingOrigin): boolean {
  return origin.kind === "platform";
}

/**
 * Who or what a part's text came from, as a person reads it: the kind, then
 * the person or thing it names. "Ticket comment by Filip", "Clarification
 * answer, round 2, by Anna", "Run note on github:acme/legacy".
 */
export function originLabel(origin: AgentBriefingOrigin): { kind: string; detail: string | null } {
  const kind = labelFrom(ORIGIN_LABELS, origin.kind);
  switch (origin.kind) {
    case "ticket_comment":
      return { kind, detail: origin.label ? `by ${origin.label}` : (origin.ref ?? null) };
    case "clarification":
      return {
        kind,
        detail:
          [origin.ref ? `round ${origin.ref}` : null, origin.label ? `by ${origin.label}` : null]
            .filter(Boolean)
            .join(", ") || null,
      };
    case "research_note":
    case "pull_request":
      return {
        kind,
        detail: [origin.ref ? `on ${origin.ref}` : null, origin.label ?? null].filter(Boolean).join(", ") || null,
      };
    default:
      return {
        kind,
        detail: [origin.ref ?? null, origin.label ?? null].filter(Boolean).join(", ") || null,
      };
  }
}

/* ── What happened to a part ───────────────────────────────────────────── */

export interface PartFate {
  label: string;
  sentence: string;
  /** `lost`: the agent never got it; `kept`: we kept less than it got;
   *  `deliberate`: our decision not to send it; `empty`: nothing to send. */
  tone: "lost" | "kept" | "deliberate" | "empty";
}

function cutCause(cause: string | undefined): string {
  if (cause === undefined) return "an unrecorded cause";
  if (!isKnownSlug(AGENT_BRIEFING_CUT_CAUSES, cause)) return `"${cause}"`;
  return cause === "section_cap"
    ? "the 200,000 character section cap"
    : "the 16,000 character budget for clarification answers";
}

/** Everything that kept a part's text from the agent or from our copy, most
 *  serious first. Empty when the part was sent and kept whole. */
export function partFates(part: AgentBriefingPart): PartFate[] {
  const fates: PartFate[] = [];
  if (part.withheld) {
    const reasons: Record<string, string> = {
      pr_feedback_present: "the pull request carries review feedback",
    };
    fates.push({
      label: "Withheld on purpose",
      sentence: `Not sent, deliberately (${labelFrom(reasons, part.withheld.reason)}). ${part.withheld.text}`,
      tone: "deliberate",
    });
  }
  if (part.cutBeforeSend === "whole") {
    fates.push({
      label: "Cut before sending",
      sentence: `Removed whole by ${cutCause(part.cutCause)}. The agent never got this part${
        part.originalLengthUtf16 ? ` (${part.originalLengthUtf16.toLocaleString("en-US")} characters)` : ""
      }.`,
      tone: "lost",
    });
  } else if (part.cutBeforeSend === "partial") {
    fates.push({
      label: "Cut before sending",
      sentence: `Shortened by ${cutCause(part.cutCause)}${
        part.originalLengthUtf16 ? ` from ${part.originalLengthUtf16.toLocaleString("en-US")} characters` : ""
      }. The agent got only the text shown here.`,
      tone: "lost",
    });
  }
  if (part.truncatedForStorage === "whole") {
    fates.push({
      label: "Not kept",
      sentence: "The agent got this part; our storage budget did not keep any of it.",
      tone: "kept",
    });
  } else if (part.truncatedForStorage === "partial") {
    fates.push({
      label: "Trimmed for storage",
      sentence: "The agent got all of this part; we kept only the beginning shown here.",
      tone: "kept",
    });
  }
  if (part.empty) {
    fates.push({
      label: "Empty",
      sentence: "This slot was part of the prompt and held no text.",
      tone: "empty",
    });
  }
  return fates;
}

/* ── Repositories in a briefing ────────────────────────────────────────── */

const REPOSITORY_STATE_LABELS: Record<string, string> = {
  write: "Write",
  read_only: "Read only",
  offered: "Offered",
  excluded: "Excluded",
  disabled: "Disabled",
  not_enabled: "Not enabled",
  outside_catalog: "Outside the catalog",
};

export function repositoryStateLabel(state: string): string {
  return labelFrom(REPOSITORY_STATE_LABELS, state);
}

export function repositoryStateTone(state: string): "success" | "running" | "neutral" | "failed" | "warn" {
  if (state === "write") return "success";
  if (state === "read_only" || state === "offered") return "running";
  if (state === "excluded" || state === "disabled" || state === "not_enabled" || state === "outside_catalog") {
    return "failed";
  }
  return "neutral";
}

function relationshipSentence(kind: string, target: string): string {
  const known = REPOSITORY_RELATIONSHIP_KINDS.find((entry) => entry.kind === kind);
  return known ? known.sentence.replace("{target}", target) : `${kind} ${target}`;
}

export function relationshipLine(relationship: { kind: string; target: string; note?: string | undefined }): string {
  const sentence = relationshipSentence(relationship.kind, relationship.target);
  return relationship.note ? `${sentence} (${relationship.note})` : sentence;
}

/** Why a repository is in the context at all. */
export function inclusionSentence(inclusion: AgentBriefingRepository["inclusion"]): string {
  switch (inclusion.cause) {
    case "named":
      return "The ticket or event names it.";
    case "event_repository":
      return "The event happened on it.";
    case "attached":
      return "A person attached it to the run.";
    case "related":
      return inclusion.via
        ? `Related: ${inclusion.via.key} ${relationshipSentence(inclusion.via.relationship, "this repository")}.`
        : "Related to another repository in the context.";
    case "offered_by_question":
      return "A question put it in front of a person.";
    case "chosen_by_workflow":
      return "A person handed the decision back and the workflow took it.";
    case "work_scope_entry":
      return "The repository record has an entry for it.";
    case "catalog":
      // About listing, never about state: a disabled or archived repository is
      // listed here too, and saying "enabled" next to "Disabled" is a lie.
      return "It is listed in the catalog.";
    default:
      return `Included because of "${inclusion.cause}".`;
  }
}

/** Whose words the description the agent read are. */
export function descriptionSource(source: string): string {
  const sources: Record<string, string> = {
    catalog: "The operator's description from the catalog",
    provider: "The provider's listing text; the catalog has no description",
    none: "No description",
  };
  return labelFrom(sources, source);
}

export function renderingLabel(rendering: string): string {
  const renderings: Record<string, string> = { full: "Full entry", line: "One line" };
  return labelFrom(renderings, rendering);
}

/* ── The repository record ─────────────────────────────────────────────── */

const ENTRY_STATE_LABELS: Record<string, string> = {
  selected: "Selected",
  excluded: "Excluded",
  unavailable: "Unavailable",
};

export function entryStateLabel(entry: Pick<AgentBriefingWorkScopeEntry, "state" | "unavailableReason">): string {
  const state = labelFrom(ENTRY_STATE_LABELS, entry.state);
  if (entry.state !== "unavailable" || !entry.unavailableReason) return state;
  const reasons: Record<string, string> = { not_enabled: "not enabled", unusable: "unusable" };
  return `${state}: ${labelFrom(reasons, entry.unavailableReason)}`;
}

export function entryStateTone(state: string): "success" | "failed" | "neutral" {
  if (state === "selected") return "success";
  if (state === "excluded" || state === "unavailable") return "failed";
  return "neutral";
}

const ENTRY_ORIGIN_LABELS: Record<string, string> = {
  person: "a person decided",
  delegated: "the workflow chose, asked to by a person",
  workflow_owned_branch: "the workflow's own branch",
  ticket_text: "the ticket names it",
  trigger_policy: "the trigger's repository policy",
  inferred: "a guess the next answer may overrule",
};

export function entryOriginLabel(origin: string): string {
  return labelFrom(ENTRY_ORIGIN_LABELS, origin);
}

export function actorLabel(actor: AgentBriefingWorkScopeEntry["decidedBy"]): string {
  if (actor.kind === "person") return actor.actorLabel ?? actor.actorId ?? "a person";
  if (actor.kind === "run") return actor.runId ? `run ${actor.runId}` : "a run";
  return actor.actorLabel ?? actor.kind;
}

/* ── Rounds ────────────────────────────────────────────────────────────── */

export function roundStatusLabel(status: string): string {
  const statuses: Record<string, string> = {
    pending: "Waiting for an answer",
    answered: "Answered",
    expired: "Expired",
    cancelled: "Cancelled",
    resume_failed: "Answered, run could not resume",
    superseded: "Replaced by a later question",
  };
  return labelFrom(statuses, status);
}

export function roundStatusTone(status: string): "awaiting" | "success" | "failed" | "neutral" {
  if (status === "pending") return "awaiting";
  if (status === "answered") return "success";
  if (status === "resume_failed") return "failed";
  return "neutral";
}

export function askedBecauseLabel(reason: string): string {
  const reasons: Record<string, string> = {
    not_enabled: "not enabled",
    unusable: "unusable",
    outside_policy: "outside the trigger's policy",
    selection: "to choose from",
  };
  return labelFrom(reasons, reason);
}

export function surfaceLabel(surface: string): string {
  const surfaces: Record<string, string> = {
    jira: "Jira",
    dashboard: "the dashboard",
    mcp: "MCP",
    other: "another surface",
  };
  return labelFrom(surfaces, surface);
}

export function authorLabel(author: ClarificationDelivery["author"]): string {
  if (author.kind === "several_people") return `${author.display} (several people)`;
  return author.display;
}

/** How an answer was read, as one sentence. */
export function readingSentence(reading: ClarificationReading): string {
  const { outcome } = reading;
  const keys = (outcome.repositoryKeys ?? []).join(", ");
  const more =
    outcome.repositoryKeyCount !== undefined && outcome.repositoryKeys !== undefined &&
    outcome.repositoryKeyCount > outcome.repositoryKeys.length
      ? ` and ${outcome.repositoryKeyCount - outcome.repositoryKeys.length} more`
      : "";
  switch (outcome.kind) {
    case "repositories":
      return `Chose ${keys}${more}.`;
    case "declined_all":
      return "Declined every repository offered.";
    case "declined_one":
      return `Declined ${outcome.repositoryKey ?? "the repository offered"}.`;
    case "delegated":
      return "Asked the workflow to decide.";
    case "unclear":
      return outcome.paraphrase ? `Unclear. Best guess: "${outcome.paraphrase}"` : "Unclear, with no guess worth offering.";
    default:
      return `Read as "${outcome.kind}".`;
  }
}

export function readerLabel(reading: ClarificationReading): string {
  if (reading.readBy === "model") return reading.model ? `read by ${reading.model}` : "read by a model";
  if (reading.readBy === "deterministic") return "read without a model (the provider could not be reached)";
  return `read by ${reading.readBy}`;
}

/* ── Sections and redactions ───────────────────────────────────────────── */

export function sectionKindLabel(kind: string): string {
  const kinds: Record<string, string> = {
    profile: "Harness profile",
    repository: "Repository instructions",
    memory: "Memory",
    block: "Block prompt",
    runtime: "Run data",
    discovery: "Discovery prompt",
    system: "System prompt",
  };
  return labelFrom(kinds, kind);
}

export function redactionLabel(kind: string): string {
  const kinds: Record<string, string> = {
    configured_secret: "a configured secret",
    token: "a token",
    jwt: "a JSON web token",
    private_key: "a private key",
    credential_url: "a URL with credentials",
    email: "an e-mail address",
    phone: "a phone number",
    payment_card: "a payment card number",
    iban: "a bank account number",
    payment_identifier: "a payment identifier",
    control_characters: "control characters",
  };
  return labelFrom(kinds, kind);
}

/** Why a join key (a provenance id, a profile id) was not stored. */
export function withheldKeyLabel(withheld: { reason: string; lengthUtf16: number }): string {
  const reasons: Record<string, string> = {
    too_long: "too long to store",
    redacted: "it held something the redaction detector reports",
  };
  return `key withheld (${labelFrom(reasons, withheld.reason)}, ${withheld.lengthUtf16.toLocaleString("en-US")} characters)`;
}
