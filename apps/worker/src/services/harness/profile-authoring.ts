/**
 * Authoring a harness profile: the draft, its published versions, and the
 * lifecycle a profile moves through (forked, archived, restored, deleted).
 *
 * Every operation here binds its own connection and takes the actor the
 * request authenticated. This service and the harness policy modules decide
 * whether that actor may write; repositories expose named row statements.
 */
import { canManageHarnessProfiles } from "@shared/contracts";
import { refreshConnectedHarnessSkillArtifact } from "../../harness-profiles/skill-refresh.js";
import { publishHarnessProfileDraft as publishHarnessProfileDraftPolicy } from "../../harness-profiles/publish-draft.js";
import {
  forkHarnessProfile,
  replaceHarnessProfileSkillArtifact,
  restoreHarnessProfileVersion,
} from "../../harness-profiles/draft-authoring.js";
import { removeConnectedHarnessProfile } from "../../harness-profiles/profile-deletion.js";
import {
  archiveConnectedHarnessProfile,
  createConnectedHarnessProfile,
  restoreConnectedHarnessProfile,
  updateConnectedHarnessProfileDraft,
} from "../../harness-profiles/profile-writes.js";
import { HarnessProfileManifestError, parseHarnessProfileDraftManifest } from "../../harness-profiles/manifest.js";
import {
  type HarnessProfileActor,
  HarnessProfileStoreError,
} from "../../db/repositories/harness-profiles.js";
import { configuredGitHubSkillRepository } from "./skill-sources.js";

/**
 * The revision the remove and unarchive handlers accept without checking it.
 * Preserved: an absent revision reaches the store as NaN, which the store
 * refuses with its own 400 rather than the handler refusing it first.
 */
function uncheckedRevision(value: unknown): number {
  return (value ?? Number.NaN) as number;
}

function requireHarnessProfileManager(actor: HarnessProfileActor): void {
  if (!canManageHarnessProfiles(actor.role as import("@shared/contracts").DashboardRole)) {
    throw new HarnessProfileStoreError(403, "Forbidden");
  }
}

function managed<T>(actor: HarnessProfileActor, operation: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(() => {
    requireHarnessProfileManager(actor);
    return operation();
  });
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function validatedSlug(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value) || value.length > 64) {
    throw new HarnessProfileStoreError(400, "Slug must be 1-64 lowercase letters, numbers, or hyphens");
  }
  return value;
}

function normalizedDraft(value: unknown) {
  try { return parseHarnessProfileDraftManifest(value); }
  catch (error) {
    if (error instanceof HarnessProfileManifestError) throw new HarnessProfileStoreError(400, error.message, { issues: error.issues });
    throw error;
  }
}

function validatedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new HarnessProfileStoreError(400, "Invalid draft revision");
  }
  return value;
}

export function createHarnessProfileDraft(input: {
  slug: unknown;
  draft: unknown;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () =>
    createConnectedHarnessProfile({
      ...input,
      slug: validatedSlug(input.slug),
      draft: normalizedDraft(input.draft),
    }),
  );
}

export function saveHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: number;
  draft: unknown;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () =>
    updateConnectedHarnessProfileDraft({
      ...input,
      expectedRevision: validatedRevision(input.expectedRevision),
      draft: normalizedDraft(input.draft),
    }),
  );
}

export function publishHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () => publishHarnessProfileDraftPolicy({
    ...input,
    expectedRevision: validatedRevision(input.expectedRevision),
  }));
}

export function restoreHarnessProfileDraftVersion(input: {
  profileId: string;
  version: number;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () => restoreHarnessProfileVersion({
    ...input,
    expectedRevision: validatedRevision(input.expectedRevision),
  }));
}

export function forkHarnessProfileDraft(input: {
  profileId: string;
  slug: unknown;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () => forkHarnessProfile({
    ...input,
    slug: validatedSlug(input.slug),
    expectedRevision: validatedRevision(input.expectedRevision),
  }));
}

export function archiveHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () => archiveConnectedHarnessProfile({
    ...input,
    expectedRevision: validatedRevision(input.expectedRevision),
  }));
}

export function unarchiveHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: unknown;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () => restoreConnectedHarnessProfile({
    profileId: input.profileId,
    expectedRevision: validatedRevision(uncheckedRevision(input.expectedRevision)),
    actor: input.actor,
  }));
}

export function removeHarnessProfile(input: {
  profileId: string;
  expectedRevision: unknown;
  actor: HarnessProfileActor;
}) {
  return managed(input.actor, () => removeConnectedHarnessProfile({
      profileId: input.profileId,
      expectedRevision: validatedRevision(uncheckedRevision(input.expectedRevision)),
      actor: input.actor,
    }));
}

/**
 * Re-read a pinned skill from its source and repoint the draft at the artifact
 * that came back. Both halves share one connection, and the GitHub client is
 * passed unbuilt so a deployment-local refresh never needs an installation the
 * tenant may not have.
 */
export async function refreshHarnessProfileSkill(input: {
  profileId: string;
  expectedRevision: number;
  artifactHash: string;
  actor: HarnessProfileActor;
}) {
  requireHarnessProfileManager(input.actor);
  validatedRevision(input.expectedRevision);
  const artifact = await refreshConnectedHarnessSkillArtifact({
    githubRepository: configuredGitHubSkillRepository,
    organizationId: input.actor.organizationId,
    actorId: input.actor.id,
    artifactHash: input.artifactHash,
  });
  return {
    profile: await replaceHarnessProfileSkillArtifact({
      profileId: input.profileId,
      expectedRevision: input.expectedRevision,
      previousArtifactHash: input.artifactHash,
      nextArtifactHash: artifact.artifactHash,
      actor: input.actor,
    }),
    artifact,
    // The same predicate the draft update returns early on: a refresh that
    // found identical bytes mints the identical hash.
    changed: artifact.artifactHash !== input.artifactHash,
  };
}
