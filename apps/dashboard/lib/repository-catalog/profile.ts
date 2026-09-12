// apps/dashboard/lib/repository-catalog/profile.ts
//
// Turning a tab's edit into one upsert body.
//
// The route takes a PATCH-shaped body now: every profile field is optional and
// an OMITTED field means unchanged, carried forward inside the statement that
// mints the version (`repositoryCatalogUpsertRequestSchema` in
// packages/contracts, and the upsert CTE in the worker's repository tier). So
// the body carries the dirty fields and nothing else: saving Rules sends the
// rules, and the Scripts tab's groups are never on the wire at all.
//
// That is not only tidier. Sending the whole merged profile meant a save built
// on a baseline the screen read minutes ago REPLACED whatever had landed since,
// and it meant a stored value the operator was not editing (a script group name
// the engine refuses, say) failed a save whose only edit was a line of prose.
// `expectedProfileVersion` closes the first: the write itself carries the
// version this screen loaded, and a moved profile is refused by the statement
// rather than by a read in front of it.
import type {
  RepositoryCatalogEntry,
  RepositoryCatalogUpsertRequest,
  RepositoryProfileField,
  RepositoryProfileVersion,
} from "@shared/contracts";
import {
  isRepositoryScriptGroupName,
  REPOSITORY_PROFILE_FIELDS,
} from "@shared/contracts";

/**
 * Every field one profile version carries that a tab can edit.
 *
 * Derived from the contract twice over: the KEYS are the contract's own list of
 * editable profile fields, and each value type is the one the wire declares. So
 * a field added to `REPOSITORY_PROFILE_FIELDS` stops this file compiling until
 * the screen can edit it, instead of being silently absent from every draft,
 * every dirty check and every save body.
 */
export type RepositoryProfileDraft = {
  [Field in RepositoryProfileField]: RepositoryProfileVersion[Field];
};

export type { RepositoryProfileField };

/**
 * The draft a freshly opened entry starts from.
 *
 * A repository with no profile yet (`profileVersion === 0`, which is how "known
 * but not configured" is spelled) starts empty rather than absent, so the tabs
 * are editable from the first visit instead of needing a create step nobody
 * asked for.
 */
export function draftFromProfile(
  profile: RepositoryProfileVersion | null,
): RepositoryProfileDraft {
  return {
    description: profile?.description ?? "",
    rules: profile?.rules ?? "",
    relationships: structuredClone(profile?.relationships ?? []),
    scriptGroups: structuredClone(profile?.scriptGroups ?? null),
    gateGroups: structuredClone(profile?.gateGroups ?? null),
    batchTimeoutMinutes: profile?.batchTimeoutMinutes ?? null,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Which fields this draft actually moves. Drives both the Save blocker ("no
 *  changes to save") and the reason prompt, which exists to record WHY a
 *  version was minted and is pointless for a version that changes nothing. */
export function changedProfileFields(
  saved: RepositoryProfileDraft,
  draft: RepositoryProfileDraft,
): RepositoryProfileField[] {
  // The contract's list, in the contract's order, so what this reports back
  // matches what the worker reports in `changedFields` element for element.
  return REPOSITORY_PROFILE_FIELDS.filter(
    (field) => !sameValue(saved[field], draft[field]),
  );
}

export function isProfileDirty(
  saved: RepositoryProfileDraft,
  draft: RepositoryProfileDraft,
): boolean {
  return changedProfileFields(saved, draft).length > 0;
}

/**
 * The upsert body: the dirty fields, and nothing else.
 *
 * `provider` and `path` come off the stored row, never off the draft: identity
 * is what the route checks the id against, and a screen that could edit it
 * would be a way to write one repository's profile onto another.
 *
 * `displayName` and `defaultBranch` are not sent AT ALL. This screen does not
 * edit them, it only displays them, and they move underneath it: a provider
 * import or the default-branch backfill can fill a branch while a tab sits open
 * on a draft that read it as empty. Sending them back would let a Rules save
 * from a stale screen quietly undo that. Omitted means unchanged on the route,
 * so leaving them out is the whole fix.
 *
 * Every profile field is sent only when it CHANGED. An omitted field means
 * unchanged on the route, so a Rules save never carries the script groups, and
 * a stored value nobody edited is never revalidated, never resent, and never
 * able to refuse a save it has nothing to do with.
 *
 * `enabled` is deliberately absent. Writing a profile says what to run in a
 * repository; it never says the agent may enter one. That is the enabled route,
 * which is its own click and its own audit line.
 */
export function buildProfileUpsert(input: {
  repository: Pick<RepositoryCatalogEntry, "provider" | "path">;
  saved: RepositoryProfileDraft;
  draft: RepositoryProfileDraft;
  reason: string;
  /** The profile version this screen loaded. Sent as the concurrency token, so
   *  a profile that moved since refuses the write instead of being replaced by
   *  it. */
  expectedProfileVersion: number;
}): RepositoryCatalogUpsertRequest {
  const changed = new Set(changedProfileFields(input.saved, input.draft));
  return {
    provider: input.repository.provider,
    path: input.repository.path,
    ...(changed.has("description") ? { description: input.draft.description } : {}),
    ...(changed.has("rules") ? { rules: input.draft.rules } : {}),
    ...(changed.has("relationships")
      ? { relationships: input.draft.relationships }
      : {}),
    ...(changed.has("scriptGroups") ? { scriptGroups: input.draft.scriptGroups } : {}),
    ...(changed.has("gateGroups") ? { gateGroups: input.draft.gateGroups } : {}),
    ...(changed.has("batchTimeoutMinutes")
      ? { batchTimeoutMinutes: input.draft.batchTimeoutMinutes }
      : {}),
    reason: input.reason,
    expectedProfileVersion: input.expectedProfileVersion,
  };
}

/**
 * The refusal when the stored profile moved while this screen held a draft.
 *
 * The worker refuses it now: the PUT carries `expectedProfileVersion` and the
 * write itself selects no candidate row when the version has moved, which is
 * what closes the window a read-then-write left open. The wording is the same
 * one the screen used to produce from its own pre-flight, because the
 * operator's next move has not changed.
 */
export function staleProfileNotice(version: number): string {
  return `This repository moved to v${version} while you were editing. Reload to see the change before saving.`;
}

/** What the screen says when the worker answers that the save changed nothing.
 *  Not an error: the stored profile already says what was asked for. */
export const NOTHING_TO_SAVE_NOTICE =
  "Nothing was saved: the stored profile already matches this. No version was minted.";

/** Group names the engine's own rule refuses, read off the entry the save is
 *  about to send. */
function invalidGroupNames(
  scriptGroups: Record<string, unknown> | null | undefined,
): string[] {
  const groups = (scriptGroups as { groups?: unknown } | null | undefined)?.groups;
  if (groups === null || groups === undefined || typeof groups !== "object") return [];
  return Object.keys(groups).filter((name) => !isRepositoryScriptGroupName(name));
}

/**
 * The save error, with the tab that actually holds the offending value.
 *
 * Only a save that actually CARRIES the script groups can be refused for them
 * now, so a refusal names something the operator just edited. The names are
 * still read back off the body that was sent rather than trusted from the
 * worker's unqualified `invalid_script_group_name`, which on its own says
 * nothing about which group.
 */
export function profileSaveErrorNotice(
  message: string,
  scriptGroups: Record<string, unknown> | null | undefined,
): string {
  if (!message.includes("invalid_script_group_name")) return message;
  const bad = invalidGroupNames(scriptGroups);
  const subject =
    bad.length === 0
      ? "A script group name is not valid"
      : `${bad.length === 1 ? "The script group" : "The script groups"} ${bad
          .map((name) => `"${name}"`)
          .join(", ")} ${bad.length === 1 ? "is" : "are"} not valid`;
  return `${subject}, so this save was refused. The Scripts tab holds ${
    bad.length === 1 ? "it" : "them"
  }.`;
}

/** Said above every reason box. Saving mints a version and moves what the next
 *  run executes, so the box is required rather than optional. */
export const REASON_REQUIRED_NOTE =
  "A reason is recorded with the version and shown on the History tab. Say what changed and why, not what the form already says.";

export const REASON_MISSING_BLOCKER = "a reason is required";
export const NOTHING_CHANGED_BLOCKER = "nothing has changed yet";

/** The Save blocker, or null when the save may go. */
export function profileSaveBlocker(input: {
  changed: readonly RepositoryProfileField[];
  reason: string;
  canEdit: boolean;
}): string | null {
  if (!input.canEdit) return "changing a repository needs the owner or admin role";
  if (input.changed.length === 0) return NOTHING_CHANGED_BLOCKER;
  if (input.reason.trim().length === 0) return REASON_MISSING_BLOCKER;
  return null;
}
