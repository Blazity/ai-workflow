import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
  type HarnessProfileActor,
  HarnessProfileStoreError,
} from "../db/repositories/harness-profiles.js";
import {
  listConnectedHarnessProfileUsage,
  listHarnessProfileUsage,
} from "../db/harness-profile-usage-store.js";
import type { Db } from "../db/types.js";

type HarnessProfileRepository = ReturnType<typeof createHarnessProfileRepository>;

type RemoveHarnessProfileInput = {
  profileId: string;
  expectedRevision: number;
  actor: HarnessProfileActor;
};

export async function removeConnectedHarnessProfile(
  input: RemoveHarnessProfileInput,
): Promise<void> {
  const usage = await listConnectedHarnessProfileUsage(input.profileId);
  return removeHarnessProfileWithRepository(
    createConnectedHarnessProfileRepository(),
    input,
    usage,
  );
}

export async function removeHarnessProfileFromDb(
  db: Db,
  input: RemoveHarnessProfileInput,
): Promise<void> {
  const usage = await listHarnessProfileUsage(db, input.profileId);
  return removeHarnessProfileWithRepository(
    createHarnessProfileRepository(db),
    input,
    usage,
  );
}

async function removeHarnessProfileWithRepository(
  repository: HarnessProfileRepository,
  input: RemoveHarnessProfileInput,
  usage: Awaited<ReturnType<typeof listConnectedHarnessProfileUsage>>,
): Promise<void> {
  const profile = await repository.getProfile({
    organizationId: input.actor.organizationId,
    profileId: input.profileId,
  });
  if (!profile) throw new HarnessProfileStoreError(404, "Profile not found");
  if (
    profile.organizationId !== input.actor.organizationId ||
    profile.system ||
    profile.readOnly
  ) {
    throw new HarnessProfileStoreError(403, "Profile is read-only");
  }
  if (profile.draftRevision !== input.expectedRevision) {
    throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
  }
  if (
    profile.publishedVersion !== null ||
    await repository.hasProfileVersions(profile.id) ||
    usage.length > 0
  ) {
    throw new HarnessProfileStoreError(
      409,
      "Published or workflow-pinned profiles must be archived",
    );
  }
  const deleted = await repository.deleteUnpublishedProfile({
    profileId: profile.id,
    organizationId: input.actor.organizationId,
    expectedRevision: input.expectedRevision,
  });
  if (!deleted) {
    throw new HarnessProfileStoreError(
      409,
      "Profile changed while it was being deleted",
    );
  }
}
