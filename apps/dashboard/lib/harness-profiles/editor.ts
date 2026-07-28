import type {
  HarnessCapabilitiesResponse,
  HarnessProfileDraftManifest,
  HarnessProfileDraftManifestV1,
  HarnessProfileDraftManifestV2,
  HarnessProfileDto,
  HarnessProfileManifest,
  HarnessProvider,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  buildHarnessProfileDraftV2,
} from "@shared/contracts";

export function draftFromManifest(
  manifest: HarnessProfileManifest,
): HarnessProfileDraftManifest {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = manifest;
  return structuredClone(draft);
}

export function newProfileDraft(
  provider: HarnessProvider,
): HarnessProfileDraftManifestV1 {
  const manifest = Object.values(BUILTIN_HARNESS_PROFILE_MANIFESTS).find(
    (candidate) => candidate.harness.provider === provider,
  );
  if (!manifest) {
    throw new Error(`Missing built-in ${provider} compatibility profile`);
  }
  const draft = draftFromManifest(manifest);
  if (draft.schemaVersion !== 1) {
    throw new Error("Built-in compatibility profiles must use schema v1");
  }
  return {
    ...draft,
    displayName: `Custom ${draft.displayName}`,
    description: "",
  };
}

export function withHarnessProvider(
  draft: HarnessProfileDraftManifest,
  provider: HarnessProvider,
  capabilities?: HarnessCapabilitiesResponse,
): HarnessProfileDraftManifest | null {
  const baseline = newProfileDraft(provider);
  const targetDraft: HarnessProfileDraftManifestV1 = {
    ...draft,
    schemaVersion: 1,
    harness: baseline.harness,
    model: baseline.model,
    compaction: baseline.compaction,
    homeFiles: draft.homeFiles.map((file) => ({
      ...file,
      path: provider === "codex" ? "AGENTS.md" : "CLAUDE.md",
      mode: 0o644,
    })),
    credentialReferences: baseline.credentialReferences,
  };
  if (draft.schemaVersion === 1) return targetDraft;
  if (
    !capabilities ||
    capabilities.stale ||
    capabilities.provider !== provider ||
    capabilities.cliVersion !== baseline.harness.cliVersion
  ) {
    return null;
  }
  return buildHarnessProfileDraftV2(targetDraft, capabilities);
}

export function upgradeProfileDraft(
  draft: HarnessProfileDraftManifestV1,
  capabilities: HarnessCapabilitiesResponse,
): HarnessProfileDraftManifestV2 | null {
  return buildHarnessProfileDraftV2(draft, capabilities);
}

export function isProfileSlug(value: string): boolean {
  return (
    value.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  );
}

export function canEditProfile(
  profile: HarnessProfileDto,
  canManageProfile: boolean,
): boolean {
  return (
    canManageProfile &&
    !profile.system &&
    !profile.readOnly &&
    profile.archivedAt === null
  );
}

export function upsertProfile(
  profiles: HarnessProfileDto[],
  profile: HarnessProfileDto,
): HarnessProfileDto[] {
  return profiles.some((candidate) => candidate.id === profile.id)
    ? profiles.map((candidate) =>
        candidate.id === profile.id ? profile : candidate,
      )
    : [profile, ...profiles];
}
