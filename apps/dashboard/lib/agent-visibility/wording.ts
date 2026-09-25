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
  REPOSITORY_STATES,
  USABLE_REPOSITORY_STATES,
  type AgentBriefingOrigin,
  type AgentBriefingPart,
  type AgentBriefingRepository,
  type AgentBriefingWorkScopeEntry,
  type ClarificationDelivery,
  type ClarificationReading,
  type MissingBriefingReason,
} from "@shared/agent-visibility";
import { REPOSITORY_RELATIONSHIP_KINDS } from "@shared/contracts";

import type { CaptureCounts } from "./contract";
import { plural } from "./format";

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
  /** `settled` is the one tone that is not a problem: there is no briefing
   *  because there was nothing to send, and the screen says so quietly rather
   *  than in the colour it uses for a record it could not keep. */
  tone: "waiting" | "lost" | "not_kept" | "settled";
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
      // Nothing went wrong here, and the words have to say so plainly: this is
      // what every run whose ticket names its own repository shows, and a
      // sentence about a record that was not kept would send a person hunting
      // a defect that does not exist.
      if (reason.cause === "not_needed") {
        return {
          title: "No prompt was needed",
          body: "This block asks a model only when it cannot work the answer out on its own, and this attempt did not have to. Nothing went out to a model here, and nothing is missing.",
          failure: null,
          tone: "settled",
        };
      }
      const ending =
        reason.attemptState === null ? "ended" : (ATTEMPT_ENDINGS[reason.attemptState] ?? `ended as ${reason.attemptState}`);
      // A cause a newer worker writes is shown as itself beside what this
      // build still knows for certain: the prompt never went out.
      const unknownCause =
        reason.cause === undefined
          ? ""
          : ` The worker recorded the cause "${reason.cause}", which this dashboard has no words for yet.`;
      return {
        title: "Never sent",
        body: `This attempt ${ending} before its prompt went out, so the agent got nothing.${unknownCause}`,
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

/**
 * What capture did with a run's sends, at a glance.
 *
 * A refusal is invisible until somebody opens the one briefing that is not
 * there, which is the whole point of the counters: "eleven sends, two refused"
 * is readable without opening anything. So the line always leads with how many
 * sends there were, and names every send that was not recorded.
 *
 * A counter a newer worker adds shows up as the gap between the worker's own
 * sum and the five named here, and is said as a gap rather than swallowed.
 *
 * IT SAYS WHOSE COUNT IT IS, because it is rendered at the top of ONE Block
 * Attempt's panel while counting the whole run. Without those two words the
 * panel reads "all recorded" and then, two lines down, the reason this
 * attempt has no briefing, and a person reading top to bottom is told both
 * that everything was kept and that this was not.
 */
export function captureLine(capture: CaptureCounts): { text: string; whole: boolean } {
  const named: [number, string][] = [
    [capture.skipped, "refused"],
    [capture.disabled, "made while recording was off"],
    [capture.failed, "lost"],
    [capture.conflict, "already recorded differently"],
  ];
  const counted = capture.captured + named.reduce((sum, [count]) => sum + count, 0);
  const parts = named.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (capture.sends > counted) {
    parts.push(`${capture.sends - counted} this dashboard has no words for`);
  }
  const sends = plural(capture.sends, "send");
  return parts.length === 0
    ? { text: `This whole run: ${sends}, all recorded`, whole: true }
    : { text: `This whole run: ${sends}, ${capture.captured} recorded, ${parts.join(", ")}`, whole: false };
}

/**
 * Why a block has no briefing at all, where no run exists to say it.
 *
 * "Has not run yet" ends in dispatching the workflow; "sends no prompt" ends
 * in nothing at all. They must never read alike, which is why the worker sends
 * them as two kinds rather than one empty answer.
 */
export function nodeAbsenceSentence(kind: string): { title: string; body: string } {
  switch (kind) {
    case "never_ran":
      return {
        title: "This block has not run yet",
        body: "No run of this workflow has reached this block, so nothing has gone out from it. Dispatch the workflow and what it sent will be here.",
      };
    case "sends_no_prompt":
      return {
        title: "No prompt goes out from this block",
        body: "Briefings record what a model was sent. This block sends no prompt, so it has none.",
      };
    default:
      return {
        title: "There is no briefing, for a reason this dashboard does not know",
        body: `The worker answered "${kind}", which this build has no words for yet. A newer dashboard will say what it means.`,
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

/**
 * Which turn of which loop an attempt ran in.
 *
 * Both values are shown as the worker recorded them: it reads them off the
 * activation scope (`root/loop:<node>:<index>`). The index counts from 1
 * (`spawnLoopIteration` starts at 1 and each continuation passes
 * `iteration + 1`, `packages/workflow-graph/scheduler.ts`), so iteration 3 is
 * the third turn and needs no arithmetic here.
 *
 * It never becomes "turn 3 of 50": nothing on this page knows how many turns
 * the loop ran, and a confident wrong number is the thing this whole screen
 * exists to stop.
 */
export function iterationLine(iteration: { loopNodeId: string; index: number }): string {
  return `loop ${iteration.loopNodeId}, iteration ${iteration.index}`;
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
      represented_by_plan: "the plan stands in for it",
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

/**
 * Two facts that reach a person on three surfaces at once: the map's state
 * chip, the record's entry chip one row below it, and the line saying why a
 * question offered a repository. The words live here once, because the same
 * fact spelled "unusable" on one row and "nothing to check out" on the next
 * reads as two different problems, and a person then looks for two remedies.
 *
 * Both are the same slug in all three vocabularies: `WORK_SCOPE_ASK_REASONS`
 * records why a repository was asked about, `WORK_SCOPE_UNAVAILABLE_REASONS`
 * what the record made of the answer, and `REPOSITORY_STATES` what the send
 * could then do with it (`repository-map/map.ts` maps one to the next).
 */
const CLOSED_DOOR_WORDS = {
  not_enabled: "not enabled",
  unusable: "nothing to check out",
} as const;

function sentenceCase(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One chip, next to the repository key, above the worker's own reason.
 *
 * The two closed states this build must never blur into the others: `disabled`
 * and `not_enabled` are a switch on the Repositories page, and `unusable` is
 * not, so it says what is true of the provider instead of sending an operator
 * to a switch that is already on. `refused` is this run's own rule closing the
 * door, never a person's decision, so it says whose door and for how long:
 * reading it as `excluded` sends somebody looking for a decision nobody made.
 */
const REPOSITORY_STATE_LABELS: Record<string, string> = {
  write: "Write",
  read_only: "Read only",
  offered: "Offered",
  excluded: "Excluded",
  disabled: "Disabled",
  not_enabled: sentenceCase(CLOSED_DOOR_WORDS.not_enabled),
  unusable: sentenceCase(CLOSED_DOOR_WORDS.unusable),
  outside_catalog: "Outside the catalog",
  refused: "Refused for this run",
};

export function repositoryStateLabel(state: string): string {
  return labelFrom(REPOSITORY_STATE_LABELS, state);
}

/**
 * Usable is not a list to keep here. The package owns which states let a send
 * touch a repository (`USABLE_REPOSITORY_STATES`), and a second copy of that
 * rule in the dashboard is a copy that drifts: the first new usable state
 * would arrive coloured as a failure. A state this build has never heard of
 * stays neutral, because colouring a slug we cannot read is a guess.
 */
export function repositoryStateTone(state: string): "success" | "running" | "neutral" | "failed" | "warn" {
  if (state === "write") return "success";
  if (isKnownSlug(USABLE_REPOSITORY_STATES, state)) return "running";
  return isKnownSlug(REPOSITORY_STATES, state) ? "failed" : "neutral";
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

/** `Unavailable` alone says a door is shut and not which one, so the reason
 *  rides the chip, in the words the map's own chip uses for that same fact. */
export function entryStateLabel(entry: Pick<AgentBriefingWorkScopeEntry, "state" | "unavailableReason">): string {
  const state = labelFrom(ENTRY_STATE_LABELS, entry.state);
  if (entry.state !== "unavailable" || !entry.unavailableReason) return state;
  return `${state}: ${labelFrom(CLOSED_DOOR_WORDS, entry.unavailableReason)}`;
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
  // Not a guess and not a person's decision: an edge an operator drew on the
  // Repositories page, re-read on the next run, which is why this entry can
  // disappear on its own when that edge goes.
  related_repository: "the catalog relates it to a repository this work names",
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
    ...CLOSED_DOOR_WORDS,
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
