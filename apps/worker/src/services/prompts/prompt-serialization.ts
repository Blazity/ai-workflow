import type { PromptLibraryEntryMeta, PromptLibraryVersion } from "@shared/contracts";
import type {
  PromptLibraryRow,
  PromptLibraryVersionRow,
} from "../../db/repositories/prompts.js";

export function serializePromptMeta(
  row: PromptLibraryRow,
  currentVersion: number,
): PromptLibraryEntryMeta {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    currentVersion,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdByLabel: row.createdByLabel,
  };
}

export function serializePromptVersion(
  row: PromptLibraryVersionRow,
): PromptLibraryVersion {
  return {
    promptId: row.promptId,
    version: row.version,
    body: row.body,
    slots: structuredClone(row.slots),
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
}
