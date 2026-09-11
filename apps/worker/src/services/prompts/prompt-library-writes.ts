/**
 * What the dashboard may change in the prompt library.
 *
 * Each operation binds its own connection, resolves the acting user's display
 * label (the store records who wrote a version, and a run later shows it), and
 * decides the order in which a write happens. The orphan guard is part of that
 * order: a prompt with no version rows has no head to return, so it is reported
 * as missing before the parent row is touched rather than after.
 */
import type {
  PromptLibraryDetailResponse,
  PromptLibrarySaveResponse,
  PromptSlotDefinition,
} from "@shared/contracts";
import { getConnectedDashboardUserLabel } from "../../db/repositories/auth.js";
import {
  getConnectedPrompt,
  listConnectedPromptVersionRows,
  type PromptLibraryActor,
} from "../../db/repositories/prompts.js";
import type { DashboardRole } from "@shared/contracts";
import { archiveConnectedPrompt, createConnectedPrompt, restoreConnectedPromptVersionWithPolicy, saveConnectedPromptVersionWithPolicy, updateConnectedPromptMeta } from "./prompt-library-service.js";
import { requirePromptLibraryEditRole } from "./prompt-library-service.js";
import { validatePromptBody, validatePromptSlots } from "./prompt-library-validation.js";
import { serializePromptMeta, serializePromptVersion } from "./prompt-serialization.js";

/** The dashboard user behind a write, as the request identified them. */
export interface PromptLibraryWriter {
  role: DashboardRole;
  userId: string;
}

function resolveActor(
  writer: PromptLibraryWriter,
): Promise<PromptLibraryActor> {
  return getConnectedDashboardUserLabel(writer.userId).then((label) => ({
    role: writer.role,
    id: writer.userId,
    label,
  }));
}

/** Create a prompt and return it with the single version it now has. */
export async function createPromptEntry(input: {
  name: string;
  body: string;
  slots?: PromptSlotDefinition[];
  description?: string | null;
  tags?: string[];
  writer: PromptLibraryWriter;
}): Promise<PromptLibraryDetailResponse> {
  const { prompt, current } = await createConnectedPrompt({
    name: input.name,
    body: input.body,
    slots: input.slots,
    description: input.description,
    tags: input.tags,
    actor: await resolveActor(input.writer),
  });
  const version = serializePromptVersion(current);
  return {
    meta: serializePromptMeta(prompt, current.version),
    current: version,
    versions: [version],
  };
}

/** Edit the meta of a prompt, or null when it has no head version to return. */
export async function updatePromptEntryMeta(input: {
  promptId: number;
  name?: string;
  description?: string | null;
  tags?: string[];
  writer: PromptLibraryWriter;
}): Promise<PromptLibraryDetailResponse | null> {
  const versions = (await listConnectedPromptVersionRows(input.promptId)).map(
    serializePromptVersion,
  );
  const current = versions[0];
  if (!current) return null;

  const updated = await updateConnectedPromptMeta({
    promptId: input.promptId,
    name: input.name,
    description: input.description,
    tags: input.tags,
    actor: await resolveActor(input.writer),
  });
  return {
    meta: serializePromptMeta(updated, current.version),
    current,
    versions,
  };
}

/**
 * Archive a prompt, or null when it has no head version to return. Archiving
 * touches only the parent meta, so the versions read for the guard are the
 * response as-is.
 */
export async function archivePromptEntry(input: {
  promptId: number;
  writer: PromptLibraryWriter;
}): Promise<PromptLibraryDetailResponse | null> {
  const versions = (await listConnectedPromptVersionRows(input.promptId)).map(
    serializePromptVersion,
  );
  const current = versions[0];
  if (!current) return null;

  const archived = await archiveConnectedPrompt({
    promptId: input.promptId,
    actor: await resolveActor(input.writer),
  });
  return {
    meta: serializePromptMeta(archived, current.version),
    current,
    versions,
  };
}

/** Write a new head version, reporting whether the body actually changed. */
export async function savePromptEntryVersion(input: {
  promptId: number;
  body: string;
  slots?: PromptSlotDefinition[];
  writer: PromptLibraryWriter;
}): Promise<PromptLibrarySaveResponse> {
  requirePromptLibraryEditRole(input.writer.role);
  const { version, changed } = await saveConnectedPromptVersionWithPolicy({
    promptId: input.promptId,
    body: validatePromptBody(input.body),
    slots: input.slots === undefined ? undefined : validatePromptSlots(input.slots),
    actor: await resolveActor(input.writer),
  });
  const row = await getConnectedPrompt(input.promptId);
  return {
    meta: serializePromptMeta(row!, version.version),
    version: serializePromptVersion(version),
    changed,
  };
}

/** Make an older version the head again. */
export async function restorePromptEntryVersion(input: {
  promptId: number;
  version: number;
  writer: PromptLibraryWriter;
}): Promise<PromptLibrarySaveResponse> {
  requirePromptLibraryEditRole(input.writer.role);
  const restored = await restoreConnectedPromptVersionWithPolicy({
    promptId: input.promptId,
    version: input.version,
    actor: await resolveActor(input.writer),
  });
  const row = await getConnectedPrompt(input.promptId);
  return {
    meta: serializePromptMeta(row!, restored.version),
    version: serializePromptVersion(restored),
    changed: true,
  };
}
