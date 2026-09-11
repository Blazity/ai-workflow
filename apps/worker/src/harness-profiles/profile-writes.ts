import type { HarnessProfileDraftManifest } from "@shared/contracts";
import { isUniqueViolation } from "../infra/unique-violation.js";
import {
  createConnectedHarnessProfileRepository,
  createHarnessProfileRepository,
  mapHarnessProfileRow,
  type HarnessProfileActor,
  HarnessProfileStoreError,
} from "../db/repositories/harness-profiles.js";
import type { Db } from "../db/types.js";

type Repository = ReturnType<typeof createHarnessProfileRepository>;
type WriteInput = { profileId: string; expectedRevision: number; actor: HarnessProfileActor };

async function writeMiss(repository: Repository, input: WriteInput): Promise<never> {
  const profile = await repository.getProfile({ organizationId: input.actor.organizationId, profileId: input.profileId });
  if (!profile) throw new HarnessProfileStoreError(404, "Profile not found");
  if (profile.readOnly) throw new HarnessProfileStoreError(403, "System profiles are read-only");
  if (profile.archivedAt !== null) throw new HarnessProfileStoreError(409, "Profile is archived");
  throw new HarnessProfileStoreError(409, "Profile draft revision conflict");
}

async function createWith(repository: Repository, input: { slug: string; draft: HarnessProfileDraftManifest; actor: HarnessProfileActor }) {
  try { return mapHarnessProfileRow(await repository.insertProfile(input)); }
  catch (error) {
    if (isUniqueViolation(error)) throw new HarnessProfileStoreError(409, "Slug already in use");
    throw error;
  }
}
async function updateWith(repository: Repository, input: WriteInput & { draft: HarnessProfileDraftManifest }) {
  const updated = await repository.replaceDraft(input);
  return updated ? mapHarnessProfileRow(updated) : writeMiss(repository, input);
}
async function archiveWith(repository: Repository, input: WriteInput) {
  const updated = await repository.archiveProfile(input);
  return updated ? mapHarnessProfileRow(updated) : writeMiss(repository, input);
}
async function restoreWith(repository: Repository, input: WriteInput) {
  try {
    const updated = await repository.restoreArchivedProfile(input);
    return updated ? mapHarnessProfileRow(updated) : writeMiss(repository, input);
  } catch (error) {
    if (isUniqueViolation(error)) throw new HarnessProfileStoreError(409, "Another active profile already uses this slug");
    throw error;
  }
}
export const createConnectedHarnessProfile = (input: Parameters<typeof createWith>[1]) => createWith(createConnectedHarnessProfileRepository(), input);
export const updateConnectedHarnessProfileDraft = (input: Parameters<typeof updateWith>[1]) => updateWith(createConnectedHarnessProfileRepository(), input);
export const archiveConnectedHarnessProfile = (input: WriteInput) => archiveWith(createConnectedHarnessProfileRepository(), input);
export const restoreConnectedHarnessProfile = (input: WriteInput) => restoreWith(createConnectedHarnessProfileRepository(), input);
export const createHarnessProfileOnDb = (db: Db, input: Parameters<typeof createWith>[1]) => createWith(createHarnessProfileRepository(db), input);
export const updateHarnessProfileDraftOnDb = (db: Db, input: Parameters<typeof updateWith>[1]) => updateWith(createHarnessProfileRepository(db), input);
export const archiveHarnessProfileOnDb = (db: Db, input: WriteInput) => archiveWith(createHarnessProfileRepository(db), input);
export const restoreArchivedHarnessProfileOnDb = (db: Db, input: WriteInput) => restoreWith(createHarnessProfileRepository(db), input);
