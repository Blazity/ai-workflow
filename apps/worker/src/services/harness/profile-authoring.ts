/**
 * Authoring a harness profile: the draft, its published versions, and the
 * lifecycle a profile moves through (forked, archived, restored, deleted).
 *
 * Every operation here binds its own connection and takes the actor the
 * request authenticated. The store decides whether the actor may write and
 * whether the revision it was handed still matches, and it raises
 * HarnessProfileStoreError with the status the caller puts on the wire.
 */
import { deleteHarnessProfileWithUsage } from "../../db/harness-profile-detail-store.js";
import { getDb } from "../../db/client.js";
import { refreshHarnessSkillArtifact } from "../../harness-profiles/skill-refresh.js";
import {
  archiveHarnessProfile,
  createHarnessProfile,
  forkHarnessProfile,
  publishHarnessProfile,
  replaceHarnessProfileSkillArtifact,
  restoreArchivedHarnessProfile,
  restoreHarnessProfileVersion,
  updateHarnessProfileDraft,
  type HarnessProfileActor,
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

export function createHarnessProfileDraft(input: {
  slug: unknown;
  draft: unknown;
  actor: HarnessProfileActor;
}) {
  return createHarnessProfile(getDb(), input);
}

export function saveHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: number;
  draft: unknown;
  actor: HarnessProfileActor;
}) {
  return updateHarnessProfileDraft(getDb(), input);
}

export function publishHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return publishHarnessProfile(getDb(), input);
}

export function restoreHarnessProfileDraftVersion(input: {
  profileId: string;
  version: number;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return restoreHarnessProfileVersion(getDb(), input);
}

export function forkHarnessProfileDraft(input: {
  profileId: string;
  slug: unknown;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return forkHarnessProfile(getDb(), input);
}

export function archiveHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
}) {
  return archiveHarnessProfile(getDb(), input);
}

export function unarchiveHarnessProfileDraft(input: {
  profileId: string;
  expectedRevision: unknown;
  actor: HarnessProfileActor;
}) {
  return restoreArchivedHarnessProfile(getDb(), {
    profileId: input.profileId,
    expectedRevision: uncheckedRevision(input.expectedRevision),
    actor: input.actor,
  });
}

export function removeHarnessProfile(input: {
  profileId: string;
  expectedRevision: unknown;
  actor: HarnessProfileActor;
}) {
  return deleteHarnessProfileWithUsage(getDb(), {
    profileId: input.profileId,
    expectedRevision: uncheckedRevision(input.expectedRevision),
    actor: input.actor,
  });
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
  const db = getDb();
  const artifact = await refreshHarnessSkillArtifact(db, {
    githubRepository: configuredGitHubSkillRepository,
    organizationId: input.actor.organizationId,
    actorId: input.actor.id,
    artifactHash: input.artifactHash,
  });
  return {
    profile: await replaceHarnessProfileSkillArtifact(db, {
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
