import type {
  HarnessProfileDraftManifestV1,
  HarnessProfileDto,
  HarnessProfileManifestV1,
  HarnessProvider,
} from "@shared/contracts";
import { BUILTIN_HARNESS_PROFILE_MANIFESTS } from "@shared/contracts";

export function draftFromManifest(
  manifest: HarnessProfileManifestV1,
): HarnessProfileDraftManifestV1 {
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
  return {
    ...draft,
    displayName: `Custom ${draft.displayName}`,
    description: "",
  };
}

export function withHarnessProvider(
  draft: HarnessProfileDraftManifestV1,
  provider: HarnessProvider,
): HarnessProfileDraftManifestV1 {
  const baseline = newProfileDraft(provider);
  return {
    ...draft,
    harness: baseline.harness,
    model: baseline.model,
    homeFiles: draft.homeFiles.map((file) => ({
      ...file,
      path: provider === "codex" ? "AGENTS.md" : "CLAUDE.md",
      mode: 0o644,
    })),
    credentialReferences: baseline.credentialReferences,
  };
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
