import { isDeepStrictEqual } from "node:util";

import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
  getHarnessProfile,
  getHarnessSkillArtifactEnvelopeByHashes,
  mapHarnessProfileRow,
  mapHarnessProfileVersionRow,
  type HarnessProfileActor,
  HarnessProfileStoreError,
} from "../db/repositories/harness-profiles.js";
import type { HarnessProfileDraftManifest, HarnessProfileManifest } from "@shared/contracts";
import {
  HarnessCapabilityCatalogError,
  requireFreshHarnessCapabilitiesFromRepository,
} from "./capability-catalog.js";
import {
  createConnectedHarnessCapabilityCatalogRepository,
  createHarnessCapabilityCatalogRepository,
} from "../db/repositories/harness-capability-catalogs.js";
import {
  compileHarnessProfileManifest,
  HarnessProfileManifestError,
  hashHarnessProfileManifest,
  isHistoricalHarnessProfileDraft,
  parseHarnessProfileDraftManifest,
  stableJson,
} from "./manifest.js";
import {
  HarnessSkillArtifactIntegrityError,
  verifyHarnessSkillArtifact,
} from "./skill-validation.js";
import { isUniqueViolation } from "../infra/unique-violation.js";

type Db = Parameters<typeof getHarnessProfile>[0];
type HarnessProfileRepository = ReturnType<typeof createHarnessProfileRepository>;
type CapabilityCatalogRepository = Parameters<
  typeof requireFreshHarnessCapabilitiesFromRepository
>[0];

/** Policy for a pre-publish draft. The repository only reads/writes rows. */
async function verifyDraftSkillArtifacts(
  repository: HarnessProfileRepository,
  input: { organizationId: string; draft: { skills: Array<{ artifactHash: string; name: string }> } },
): Promise<Awaited<ReturnType<typeof getHarnessSkillArtifactEnvelopeByHashes>>["artifacts"]> {
  const { artifacts, files } = await repository.getArtifactEnvelope({
    organizationId: input.organizationId,
    artifactHashes: input.draft.skills.map((skill) => skill.artifactHash),
  });
  if (artifacts.length !== input.draft.skills.length) {
    throw new HarnessProfileStoreError(400, "Profile references an unknown skill artifact");
  }
  const filesByArtifact = new Map<number, typeof files>();
  for (const file of files) {
    const current = filesByArtifact.get(file.artifactId) ?? [];
    current.push(file);
    filesByArtifact.set(file.artifactId, current);
  }
  const byHash = new Map(artifacts.map((artifact) => [artifact.artifactHash, artifact]));
  const names = new Set<string>();
  try {
    for (const skill of input.draft.skills) {
      const artifact = byHash.get(skill.artifactHash)!;
      if (skill.name !== artifact.name) {
        throw new HarnessProfileStoreError(400, `Profile skill "${skill.name}" does not match the pinned artifact name "${artifact.name}"`);
      }
      if (names.has(artifact.name)) {
        throw new HarnessProfileStoreError(400, `Profile contains duplicate canonical skill name "${artifact.name}"`);
      }
      names.add(artifact.name);
      const source = artifact.sourceKind === "local"
        ? artifact.localPath && artifact.localContentSha256
          ? { path: artifact.localPath, contentSha256: artifact.localContentSha256 }
          : null
        : artifact.sourceOwner && artifact.sourceRepository && artifact.sourcePath && artifact.sourceCommitSha
          ? { owner: artifact.sourceOwner, repository: artifact.sourceRepository, path: artifact.sourcePath, commitSha: artifact.sourceCommitSha }
          : null;
      if (!source) throw new HarnessSkillArtifactIntegrityError("Stored skill artifact source columns are invalid.");
      verifyHarnessSkillArtifact({
        artifactHash: artifact.artifactHash,
        name: artifact.name,
        description: artifact.description,
        source,
        files: (filesByArtifact.get(artifact.id) ?? []).map((file) => ({ path: file.path, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256, contentBase64: file.contentBase64 })),
      });
    }
  } catch (error) {
    if (error instanceof HarnessSkillArtifactIntegrityError) {
      throw new HarnessProfileStoreError(409, "Stored skill artifact failed integrity verification");
    }
    throw error;
  }
  return artifacts;
}

function positiveRevision(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new HarnessProfileStoreError(400, "Invalid draft revision");
  }
}

function normalizedDraft(value: unknown): HarnessProfileDraftManifest {
  try {
    return parseHarnessProfileDraftManifest(value);
  } catch (error) {
    if (error instanceof HarnessProfileManifestError) {
      throw new HarnessProfileStoreError(400, error.message, { issues: error.issues });
    }
    throw error;
  }
}

function draftFromManifest(manifest: HarnessProfileManifest): HarnessProfileDraftManifest {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = manifest;
  return normalizedDraft(draft);
}

function requireWritableProfile(
  profile: Awaited<ReturnType<typeof getHarnessProfile>>,
  input: { expectedRevision: number },
) {
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
  return profile;
}

async function validateCapabilities(
  repository: CapabilityCatalogRepository,
  organizationId: string,
  draft: HarnessProfileDraftManifest,
): Promise<void> {
  if (isHistoricalHarnessProfileDraft(draft)) return;
  let capabilities;
  try {
    capabilities = await requireFreshHarnessCapabilitiesFromRepository(repository, {
      organizationId,
      provider: draft.harness.provider,
      cliVersion: draft.harness.cliVersion,
    });
  } catch (error) {
    if (error instanceof HarnessCapabilityCatalogError) {
      throw new HarnessProfileStoreError(error.statusCode, error.message);
    }
    throw error;
  }
  if (capabilities.catalogHash !== draft.model.catalogHash) {
    throw new HarnessProfileStoreError(
      409,
      "Harness capabilities changed. Review the current model settings before publishing.",
    );
  }
  const model = capabilities.models.find((candidate) => candidate.id === draft.model.id);
  if (!model || stableJson(model) !== stableJson(draft.model.capability)) {
    throw new HarnessProfileStoreError(
      409,
      "The selected model capability snapshot is no longer current.",
    );
  }
}

export async function publishHarnessProfileDraftOnDb(
  db: Db,
  input: PublishHarnessProfileDraftInput,
) {
  return publishHarnessProfileDraft(
    input,
    createHarnessProfileRepository(db),
    createHarnessCapabilityCatalogRepository(db),
  );
}

type PublishHarnessProfileDraftInput = {
  profileId: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
};

export function publishHarnessProfileDraft(
  input: PublishHarnessProfileDraftInput,
  repository: HarnessProfileRepository = createConnectedHarnessProfileRepository(),
  capabilityRepository: CapabilityCatalogRepository = createConnectedHarnessCapabilityCatalogRepository(),
) {
  return publishHarnessProfileDraftWithRepository(repository, capabilityRepository, input);
}

async function publishHarnessProfileDraftWithRepository(
  repository: HarnessProfileRepository,
  capabilityRepository: CapabilityCatalogRepository,
  input: { profileId: string; expectedRevision: number; actor: HarnessProfileActor },
) {
  positiveRevision(input.expectedRevision);
  const profile = requireWritableProfile(await repository.getProfile({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  }), input);
  const draft = normalizedDraft(profile.draftManifest);
  await validateCapabilities(capabilityRepository, input.actor.organizationId, draft);
  const artifacts = await verifyDraftSkillArtifacts(repository, {
    organizationId: input.actor.organizationId,
    draft,
  });

  if (profile.publishedVersion !== null) {
    const current = await repository.getVersionRaw({
      organizationId: input.actor.organizationId,
      profileId: profile.id,
      version: profile.publishedVersion,
    });
    if (current && isDeepStrictEqual(draftFromManifest(current.manifest), draft)) {
      return {
        profile: mapHarnessProfileRow(profile),
        version: mapHarnessProfileVersionRow(current),
        changed: false,
      };
    }
  }

  const version = (await repository.getLatestVersion(profile.id)) + 1;
  const manifest = compileHarnessProfileManifest({
    profileId: profile.id,
    version,
    slug: profile.slug,
    system: false,
    draft,
  });
  let selected: Awaited<ReturnType<typeof repository.publishPrepared>>;
  try {
    selected = await repository.publishPrepared({
      organizationId: input.actor.organizationId,
      profileId: profile.id,
      expectedRevision: input.expectedRevision,
      expectedPublishedVersion: profile.publishedVersion,
      restoredFromVersion: profile.draftRestoredFromVersion,
      actorId: input.actor.id,
      version,
      manifest,
      manifestHash: hashHarnessProfileManifest(manifest),
      skills: draft.skills.map((skill, position) => ({
        artifactId: artifacts.find((artifact) => artifact.artifactHash === skill.artifactHash)!.id,
        name: skill.name,
        position,
      })),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HarnessProfileStoreError(409, "Profile changed while it was being published");
    }
    throw error;
  }
  if (!selected) {
    requireWritableProfile(await repository.getProfile({
      organizationId: input.actor.organizationId,
      profileId: profile.id,
    }), input);
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  const [updated, inserted] = await Promise.all([
    repository.getProfile({
      organizationId: input.actor.organizationId,
      profileId: selected.profileId,
    }),
    repository.getVersionRaw({
      organizationId: input.actor.organizationId,
      profileId: selected.profileId,
      version: selected.version,
    }),
  ]);
  if (!updated || !inserted) {
    throw new HarnessProfileStoreError(
      500,
      "Published Harness Profile version was not readable",
    );
  }
  return {
    profile: mapHarnessProfileRow(updated),
    version: mapHarnessProfileVersionRow(inserted),
    changed: true,
  };
}
