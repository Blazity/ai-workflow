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
import { getDb } from "../../db/client.js";
import {
  getPrompt,
  getPromptVersion,
  listPrompts,
  listPromptVersionRows,
  serializePromptMeta,
  serializePromptVersion,
  type PromptLibraryListRow,
} from "../../prompt-library/store.js";
import {
  findPromptUsage,
  findPromptUsageInPrompts,
} from "./prompt-library-service.js";

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
  const rows = await listPrompts(getDb(), filter);
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
  const db = getDb();
  const row = await getPrompt(db, promptId);
  if (!row) return null;

  const versions = (await listPromptVersionRows(db, promptId)).map(
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
  const row = await getPromptVersion(getDb(), promptId, version);
  return row ? serializePromptVersion(row) : null;
}

/** Where a prompt is referenced: by workflow definitions, and by other prompts. */
export async function readPromptUsage(
  promptId: number,
): Promise<PromptLibraryUsageResponse> {
  const db = getDb();
  const [rows, prompts] = await Promise.all([
    findPromptUsage(db, promptId),
    findPromptUsageInPrompts(db, promptId),
  ]);
  return { rows, prompts };
}
