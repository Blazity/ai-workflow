// apps/dashboard/lib/repository-catalog/suggestion.ts
//
// A model's reading of a repository, turned into something an admin reviews one
// group at a time.
//
// The rule the whole module exists to keep: **a proposal is never a submittable
// form**. The worker hands back a LIST of proposed groups rather than the
// stored scripts entry precisely so nothing here can post it, and this module
// keeps that property by only ever producing a diff plus an explicit accept of
// one named group. There is no "use all".
import type {
  PrePrCheckGroupConfig,
  PrePrCheckRepositoryConfig,
  RepositorySuggestionDropReason,
  RepositorySuggestionDroppedGroup,
  RepositorySuggestionProposedGroup,
} from "@shared/contracts";

/** Shown above every proposal. Says where the text came from and what the
 *  commands will do if they are saved, because "suggested by a model" and "runs
 *  in the sandbox checks" are two separate facts and an admin needs both before
 *  reading a command list. */
export const SUGGESTION_REVIEW_NOTICE =
  "Generated from this repository's own files by a model, README prose included. Script group commands run in the sandbox checks, so read every command before saving.";

export const SUGGESTION_PENDING_NOTE = "This can take up to 90 seconds.";

/** Said instead, while the screen is repeating a call the provider refused, so
 *  a wait that is actually the second attempt does not read as the first. */
export const SUGGESTION_RETRY_NOTE =
  "The provider did not answer, so this is one automatic retry. It is the only one.";

/**
 * The only failure the screen repeats by itself.
 *
 * A timeout is NOT retried: the worker already waited 90 seconds for the model
 * and the call is billed whether or not it answered, so repeating it spends a
 * second unpriced call on a model that is merely slow. A provider that is not
 * answering at all is the opposite case: the call cost nothing and the next one
 * usually lands.
 */
export const AUTO_RETRY_CODE = "suggestion_provider_unavailable";

/** How one proposed group compares with what the repository declares today. */
type SuggestedGroupStatus = "new" | "changed" | "unchanged";

export interface SuggestedGroupDiff {
  name: string;
  status: SuggestedGroupStatus;
  /** Verbatim, in the order the model gave them. Never reordered or
   *  deduplicated: an admin ticking a group is accepting these exact lines. */
  proposedCommands: string[];
  /** What the repository runs for this group name today, or an empty list for a
   *  group it does not have. */
  currentCommands: string[];
  /** Model provenance, carried through so a screen cannot lose it. */
  provenance: "model";
}

function commandsOf(group: PrePrCheckGroupConfig | undefined): string[] {
  return Array.isArray(group?.commands) ? [...group.commands] : [];
}

function currentGroups(
  entry: PrePrCheckRepositoryConfig | null,
): Record<string, PrePrCheckGroupConfig> {
  const groups = entry?.groups;
  return groups && typeof groups === "object" ? groups : {};
}

/**
 * One diff per proposed group, against the groups the repository has now.
 *
 * A group whose commands already match is reported `unchanged` rather than
 * dropped: an admin who cannot see that the model agreed with the current
 * configuration cannot tell agreement from an answer that skipped the group.
 */
export function proposedGroupDiffs(
  current: PrePrCheckRepositoryConfig | null,
  proposed: readonly RepositorySuggestionProposedGroup[],
): SuggestedGroupDiff[] {
  const groups = currentGroups(current);
  return proposed.map((group) => {
    const currentCommands = commandsOf(groups[group.name]);
    const proposedCommands = [...group.commands];
    const exists = Object.hasOwn(groups, group.name);
    const status: SuggestedGroupStatus = !exists
      ? "new"
      : JSON.stringify(currentCommands) === JSON.stringify(proposedCommands)
        ? "unchanged"
        : "changed";
    return {
      name: group.name,
      status,
      proposedCommands,
      currentCommands,
      provenance: group.provenance,
    };
  });
}

export function groupDiffSummary(diff: SuggestedGroupDiff): string {
  if (diff.status === "new") return "new group";
  if (diff.status === "unchanged") return "identical to the saved group";
  return `replaces ${diff.currentCommands.length} command${
    diff.currentCommands.length === 1 ? "" : "s"
  } with ${diff.proposedCommands.length}`;
}

const DROP_REASONS: Record<RepositorySuggestionDropReason, string> = {
  remote_execution:
    "refused: the command fetches something and runs it, which is not something a suggestion may offer",
  invalid_name:
    "refused: the checks engine cannot resolve this group name, so saving it would leave the group silently never running",
};

/** Why a group never reached the proposal. Listed rather than silently dropped:
 *  an admin who sees no test group has to be able to tell a repository with no
 *  tests from a model whose answer was refused. */
export function dropReasonLabel(group: RepositorySuggestionDroppedGroup): string {
  return DROP_REASONS[group.reason] ?? "refused";
}

/**
 * Fold the ticked groups into the scripts draft.
 *
 * Only the named groups move, and only into `groups`. Nothing else the proposal
 * carries (description, rules) travels with them: those are their own per-field
 * "use this" actions on their own tabs, because accepting a command list and
 * accepting a paragraph of prose are different decisions.
 *
 * Nothing is saved by this. The result is a draft the admin still saves with a
 * reason, through the ordinary profile route.
 */
export function acceptGroupsIntoEntry(
  entry: PrePrCheckRepositoryConfig,
  diffs: readonly SuggestedGroupDiff[],
  acceptedNames: ReadonlySet<string>,
): PrePrCheckRepositoryConfig {
  const accepted = diffs.filter((diff) => acceptedNames.has(diff.name));
  if (accepted.length === 0) return entry;
  const groups: Record<string, PrePrCheckGroupConfig> = { ...currentGroups(entry) };
  for (const diff of accepted) {
    groups[diff.name] = {
      ...groups[diff.name],
      commands: [...diff.proposedCommands],
    };
  }
  // A legacy flat command list and `groups` are mutually exclusive at the
  // engine boundary, so accepting a group converts the entry rather than
  // leaving both spellings on it.
  const { commands: _legacy, ...rest } = entry;
  return { ...rest, groups };
}

/**
 * What the screen says about a refused suggestion.
 *
 * Keyed on the worker's own code, never on provider text: a provider message
 * surfaced verbatim is how a model's prose reaches a screen that promised not
 * to trust it. `retryable` decides whether a Retry button is offered at all,
 * and the screen retries a 503 at most once on its own.
 */
export interface SuggestionFailureCopy {
  message: string;
  retryable: boolean;
}

export function suggestionFailureCopy(input: {
  status: number;
  code: string;
  retryAfterSeconds?: number;
}): SuggestionFailureCopy {
  switch (input.code) {
    case "profile_source_timed_out":
      return {
        message:
          "Reading the repository's files took too long, so no suggestion was made. Nothing was changed. Try again.",
        retryable: true,
      };
    case "suggestion_timed_out":
      return {
        message:
          "The model did not answer within 90 seconds, so no suggestion was made. The call still counts against the cost page as unpriced. Try again.",
        retryable: true,
      };
    case "suggestion_provider_unavailable":
      return {
        message:
          "The model provider is not answering right now. Nothing was changed. Try again in a minute.",
        retryable: true,
      };
    case "suggestion_rate_limited":
      return {
        message:
          input.retryAfterSeconds === undefined
            ? "This repository has had too many suggestions recently. Wait before asking again."
            : `This repository has had too many suggestions recently. Try again in ${input.retryAfterSeconds} seconds.`,
        retryable: false,
      };
    case "repository_missing_at_provider":
      return {
        message:
          "The provider no longer exposes this repository, so there were no files to read. Check the path, or re-import it.",
        retryable: false,
      };
    case "suggestion_malformed":
      return {
        message:
          "The model's answer did not match the shape this screen can read, so nothing is being offered. Asking again often works.",
        retryable: true,
      };
    case "suggestion_failed":
      return {
        message: "The suggestion failed. Nothing was changed.",
        retryable: true,
      };
    default:
      return {
        message:
          input.status === 403
            ? "Asking for a suggestion needs the owner or admin role."
            : "The suggestion failed. Nothing was changed.",
        retryable: input.status >= 500,
      };
  }
}

/** The proposal's own per-field actions, for the two markdown fields. Named
 *  here so the tab and its test agree on the wording. */
export const USE_THIS_LABEL = "Use this";
