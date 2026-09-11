import type { HarnessProfileDraftManifest, HarnessProfileManifest } from "@shared/contracts";

import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
  getHarnessProfile,
  mapHarnessProfileRow,
  type HarnessProfileActor,
  HarnessProfileStoreError,
} from "../db/repositories/harness-profiles.js";
import { upgradeHarnessDraftToHistoricalV2 } from "./capability-catalog.js";
import {
  HarnessProfileManifestError,
  parseHarnessProfileDraftManifest,
} from "./manifest.js";

type Db = Parameters<typeof getHarnessProfile>[0];
type HarnessProfileRepository = ReturnType<typeof createHarnessProfileRepository>;

function positiveRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new HarnessProfileStoreError(400, "Invalid draft revision");
  }
  return value;
}

function draftFromManifest(manifest: HarnessProfileManifest): HarnessProfileDraftManifest {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = manifest;
  try {
    return parseHarnessProfileDraftManifest(draft);
  } catch (error) {
    if (error instanceof HarnessProfileManifestError) {
      throw new HarnessProfileStoreError(400, error.message, { issues: error.issues });
    }
    throw error;
  }
}

function upgradedDraft(manifest: HarnessProfileManifest): HarnessProfileDraftManifest {
  const draft = draftFromManifest(manifest);
  return draft.schemaVersion === 1
    ? upgradeHarnessDraftToHistoricalV2(draft)
    : draft;
}

export async function restoreHarnessProfileVersionOnDb(
  db: Db,
  input: RestoreHarnessProfileVersionInput,
) {
  return restoreHarnessProfileVersion(
    input,
    createHarnessProfileRepository(db),
  );
}

type RestoreHarnessProfileVersionInput = {
  profileId: string;
  version: number;
  expectedRevision: number;
  actor: HarnessProfileActor;
};

export function restoreHarnessProfileVersion(
  input: RestoreHarnessProfileVersionInput,
  repository: HarnessProfileRepository = createConnectedHarnessProfileRepository(),
) {
  return restoreHarnessProfileVersionWithRepository(repository, input);
}

async function restoreHarnessProfileVersionWithRepository(
  repository: HarnessProfileRepository,
  input: {
    profileId: string;
    version: number;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
) {
  positiveRevision(input.expectedRevision);
  positiveRevision(input.version);
  const profile = await repository.getProfile({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!profile) throw new HarnessProfileStoreError(404, "Profile not found");
  if (profile.readOnly) {
    throw new HarnessProfileStoreError(403, "System profiles are read-only");
  }
  if (profile.archivedAt !== null) {
    throw new HarnessProfileStoreError(409, "Profile is archived");
  }
  if (profile.draftRevision !== input.expectedRevision) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  const source = await repository.getVersionRaw({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
    version: input.version,
  });
  if (!source) {
    throw new HarnessProfileStoreError(404, "Profile version not found");
  }
  const updated = await repository.replaceDraftPrepared({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
    expectedRevision: input.expectedRevision,
    actorId: input.actor.id,
    draft: upgradedDraft(source.manifest),
    restoredFromVersion: source.version,
  });
  if (!updated) {
    throw new HarnessProfileStoreError(
      409,
      "Profile changed while it was being restored",
    );
  }
  return updated;
}

export async function forkHarnessProfileOnDb(
  db: Db,
  input: ForkHarnessProfileInput,
) {
  return forkHarnessProfile(input, createHarnessProfileRepository(db));
}

type ForkHarnessProfileInput = {
  profileId: string;
  slug: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
};

export function forkHarnessProfile(
  input: ForkHarnessProfileInput,
  repository: HarnessProfileRepository = createConnectedHarnessProfileRepository(),
) {
  return forkHarnessProfileWithRepository(repository, input);
}

type ReplaceHarnessProfileSkillArtifactInput = {
  profileId: string;
  expectedRevision: number;
  previousArtifactHash: string;
  nextArtifactHash: string;
  actor: HarnessProfileActor;
};

export function replaceHarnessProfileSkillArtifact(
  input: ReplaceHarnessProfileSkillArtifactInput,
  repository: HarnessProfileRepository = createConnectedHarnessProfileRepository(),
) {
  return replaceHarnessProfileSkillArtifactWithRepository(repository, input);
}

export function replaceHarnessProfileSkillArtifactOnDb(
  db: Db,
  input: ReplaceHarnessProfileSkillArtifactInput,
) {
  return replaceHarnessProfileSkillArtifactWithRepository(
    createHarnessProfileRepository(db),
    input,
  );
}

async function replaceHarnessProfileSkillArtifactWithRepository(
  repository: HarnessProfileRepository,
  input: ReplaceHarnessProfileSkillArtifactInput,
) {
  const profile = await repository.getProfile({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!profile) throw new HarnessProfileStoreError(404, "Profile not found");
  if (profile.readOnly) {
    throw new HarnessProfileStoreError(403, "System profiles are read-only");
  }
  if (profile.archivedAt !== null) {
    throw new HarnessProfileStoreError(409, "Profile is archived");
  }
  if (profile.draftRevision !== input.expectedRevision) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  const draft = profile.draftManifest;
  const index = draft.skills.findIndex(
    (skill) => skill.artifactHash === input.previousArtifactHash,
  );
  if (index < 0) {
    throw new HarnessProfileStoreError(
      400,
      "Profile does not reference the skill artifact",
    );
  }
  if (input.previousArtifactHash === input.nextArtifactHash) {
    return mapHarnessProfileRow(profile);
  }
  const artifact = await repository.getArtifactByHash({
    organizationId: input.actor.organizationId,
    artifactHash: input.nextArtifactHash,
  });
  if (!artifact) {
    throw new HarnessProfileStoreError(404, "Replacement skill artifact not found");
  }
  const nextDraft = structuredClone(draft);
  nextDraft.skills[index] = {
    artifactHash: artifact.artifactHash,
    name: artifact.name,
  };
  const updated = await repository.replaceDraftPrepared({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
    expectedRevision: input.expectedRevision,
    actorId: input.actor.id,
    draft: nextDraft,
    restoredFromVersion: profile.draftRestoredFromVersion,
  });
  if (!updated) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  return updated;
}

async function forkHarnessProfileWithRepository(
  repository: HarnessProfileRepository,
  input: {
    profileId: string;
    slug: string;
    expectedRevision: number;
    actor: HarnessProfileActor;
  },
) {
  positiveRevision(input.expectedRevision);
  const source = await repository.getProfile({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!source) throw new HarnessProfileStoreError(404, "Profile not found");
  if (source.draftRevision !== input.expectedRevision) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  const draft = parseHarnessProfileDraftManifest(source.draftManifest);
  return mapHarnessProfileRow(await repository.insertProfile({
    slug: input.slug,
    draft: draft.schemaVersion === 1
      ? upgradeHarnessDraftToHistoricalV2(draft)
      : draft,
    actor: input.actor,
  }));
}
