/**
 * What the dashboard may read of the prompt library.
 *
 * The store below takes a connection and answers about rows; this binds the
 * connection and decides what a read request means, including the one refusal
 * that is not about permission: a prompt with no version rows has no head to
 * show, so it is reported as missing exactly like an id that never existed.
 */
import type {
  PromptLibraryDetailResponse,
  PromptLibraryListResponse,
  PromptLibraryListRowDto,
  PromptLibraryUsageResponse,
  PromptLibraryVersion,
} from "@shared/contracts";
import {
  getConnectedPrompt,
  getConnectedPromptVersion,
  listConnectedPromptVersionRows,
  type PromptLibraryListRow,
} from "../../db/repositories/prompts.js";
import {
  findConnectedPromptUsage,
  findConnectedPromptUsageInPrompts,
  listConnectedPrompts,
} from "./prompt-library-service.js";
import { serializePromptMeta, serializePromptVersion } from "./prompt-serialization.js";

/** A list row as its DTO (meta plus the head body and slot contract). */
function serializeListRow(row: PromptLibraryListRow): PromptLibraryListRowDto {
  return {
    ...serializePromptMeta(row, row.currentVersion),
    body: row.body,
    slots: structuredClone(row.slots),
  };
}

/** The library listing, with the tag vocabulary the listed prompts carry. */
export async function listPromptLibrary(filter: {
  q?: string;
  tag?: string;
  includeArchived: boolean;
}): Promise<PromptLibraryListResponse> {
  const rows = await listConnectedPrompts(filter);
  const prompts = rows.map(serializeListRow);
  const tags = [...new Set(prompts.flatMap((p) => p.tags))].sort();
  return { prompts, tags };
}

/**
 * One prompt with its full version history, or null when there is nothing to
 * show. Archived prompts are served too: the library UI opens their detail
 * behind the "Archived" toggle and editor provenance chips deep-link into them.
 */
export async function readPromptDetail(
  promptId: number,
): Promise<PromptLibraryDetailResponse | null> {
  const row = await getConnectedPrompt(promptId);
  if (!row) return null;

  const versions = (await listConnectedPromptVersionRows(promptId)).map(
    serializePromptVersion,
  );
  const current = versions[0];
  if (!current) return null;
  return { meta: serializePromptMeta(row, current.version), current, versions };
}

/** One stored version, even of an archived prompt, or null when it is unknown. */
export async function readPromptVersion(
  promptId: number,
  version: number,
): Promise<PromptLibraryVersion | null> {
  const row = await getConnectedPromptVersion(promptId, version);
  return row ? serializePromptVersion(row) : null;
}

/** Where a prompt is referenced: by workflow definitions, and by other prompts. */
export async function readPromptUsage(
  promptId: number,
): Promise<PromptLibraryUsageResponse> {
  const [rows, prompts] = await Promise.all([
    findConnectedPromptUsage(promptId),
    findConnectedPromptUsageInPrompts(promptId),
  ]);
  return { rows, prompts };
}
