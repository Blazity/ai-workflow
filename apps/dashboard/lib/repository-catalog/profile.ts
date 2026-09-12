// apps/dashboard/lib/repository-catalog/profile.ts
//
// Turning a tab's edit into one upsert body.
//
// The route is a PUT that mints a whole new profile version, and every field it
// does not receive is written at its schema default: omitting `description`
// stores an empty description, it does not leave the stored one alone
// (`repositoryCatalogUpsertRequestSchema` in packages/contracts, and
// `saveRepositoryProfile` which passes every parsed field straight through).
//
// So "save only what changed" is a promise about the RESULT, not about the
// wire: the body is built from the profile as it currently stands, with the
// editing tab's fields laid over it. Saving Rules then leaves the Scripts tab's
// groups exactly as they were, which is what the promise means, and there is no
// shape of this call that silently erases the tab an operator was not looking
// at.
import type {
  RepositoryCatalogEntry,
  RepositoryCatalogUpsertRequest,
  RepositoryProfileVersion,
  RepositoryRelationship,
} from "@shared/contracts";
import { isRepositoryScriptGroupName } from "@shared/contracts";

/** Every field one profile version carries that a tab can edit. */
export interface RepositoryProfileDraft {
  description: string;
  rules: string;
  relationships: RepositoryRelationship[];
  /** The repository scripts entry, verbatim, or null for "no checks apply". */
  scriptGroups: Record<string, unknown> | null;
  gateGroups: string[] | null;
}

export type RepositoryProfileField = keyof RepositoryProfileDraft;

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
  const fields: RepositoryProfileField[] = [
    "description",
    "rules",
    "relationships",
    "scriptGroups",
    "gateGroups",
  ];
  return fields.filter((field) => !sameValue(saved[field], draft[field]));
}

export function isProfileDirty(
  saved: RepositoryProfileDraft,
  draft: RepositoryProfileDraft,
): boolean {
  return changedProfileFields(saved, draft).length > 0;
}

/**
 * The upsert body.
 *
 * `provider` and `path` come off the stored row, never off the draft: identity
 * is what the route checks the id against, and a screen that could edit it
 * would be a way to write one repository's profile onto another.
 *
 * `enabled` is deliberately absent. Writing a profile says what to run in a
 * repository; it never says the agent may enter one. That is the enabled route,
 * which is its own click and its own audit line.
 */
export function buildProfileUpsert(input: {
  repository: Pick<RepositoryCatalogEntry, "provider" | "path" | "displayName" | "defaultBranch">;
  saved: RepositoryProfileDraft;
  draft: RepositoryProfileDraft;
  reason: string;
}): RepositoryCatalogUpsertRequest {
  const merged = { ...input.saved, ...pick(input.draft, changedProfileFields(input.saved, input.draft)) };
  return {
    provider: input.repository.provider,
    path: input.repository.path,
    displayName: input.repository.displayName,
    defaultBranch: input.repository.defaultBranch,
    description: merged.description,
    rules: merged.rules,
    relationships: merged.relationships,
    scriptGroups: merged.scriptGroups,
    gateGroups: merged.gateGroups,
    reason: input.reason,
  };
}

function pick(
  draft: RepositoryProfileDraft,
  fields: readonly RepositoryProfileField[],
): Partial<RepositoryProfileDraft> {
  const picked: Partial<RepositoryProfileDraft> = {};
  for (const field of fields) {
    // Each branch assigns one known key, which is what keeps this typed without
    // a cast: a Partial indexed by a union would widen every value to the
    // union of the five field types.
    if (field === "description") picked.description = draft.description;
    if (field === "rules") picked.rules = draft.rules;
    if (field === "relationships") picked.relationships = draft.relationships;
    if (field === "scriptGroups") picked.scriptGroups = draft.scriptGroups;
    if (field === "gateGroups") picked.gateGroups = draft.gateGroups;
  }
  return picked;
}

/**
 * The refusal when the stored profile moved while this screen held a draft.
 *
 * The upsert sends the whole merged profile (see the header), so a save built
 * on a stale baseline does not merge with the other edit, it replaces it. There
 * is no version token on the route, so the screen re-reads the row immediately
 * before the PUT and refuses rather than overwriting: a lost edit nobody is
 * told about is worse than a save an operator has to make twice.
 */
export function staleProfileNotice(version: number): string {
  return `This repository moved to v${version} while you were editing. Reload to see the change before saving.`;
}

/**
 * The refusal when the pre-flight read itself failed.
 *
 * Not "unmoved": the whole point of the read is that the PUT overwrites, so a
 * read nobody got an answer to has to stop the write rather than wave it
 * through. Nothing is sent, so trying again costs nothing.
 */
export const UNREADABLE_VERSION_NOTICE =
  "The current version could not be read, so this save was not sent. Try again.";

/** Group names the engine's own rule refuses, read off the entry the save is
 *  about to send. */
function invalidGroupNames(scriptGroups: Record<string, unknown> | null): string[] {
  const groups = (scriptGroups as { groups?: unknown } | null)?.groups;
  if (groups === null || typeof groups !== "object") return [];
  return Object.keys(groups).filter((name) => !isRepositoryScriptGroupName(name));
}

/**
 * The save error, with the tab that actually holds the offending value.
 *
 * The PUT carries every field, so a group name the Scripts tab stored long ago
 * refuses a save whose only edit was the Rules text. The worker's unqualified
 * `invalid_script_group_name` would send the operator to look at what they just
 * typed, so the names are read back off the body that was sent and the tab that
 * holds them is stated.
 */
export function profileSaveErrorNotice(
  message: string,
  scriptGroups: Record<string, unknown> | null,
): string {
  if (!message.includes("invalid_script_group_name")) return message;
  const bad = invalidGroupNames(scriptGroups);
  const subject =
    bad.length === 0
      ? "A stored script group name is not valid"
      : `${bad.length === 1 ? "The stored script group" : "The stored script groups"} ${bad
          .map((name) => `"${name}"`)
          .join(", ")} ${bad.length === 1 ? "is" : "are"} not valid`;
  return `${subject}, so this save was refused. The Scripts tab holds ${
    bad.length === 1 ? "it" : "them"
  }: every save sends the whole profile, so a stored value is checked even when it is not the one you edited.`;
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
