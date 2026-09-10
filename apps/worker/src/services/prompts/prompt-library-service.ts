import { z } from "zod";
import type {
  PromptLibraryPromptUsageRow,
  PromptLibraryUsageRow,
  PromptSlotDefinition,
  WorkflowBlockType,
} from "@shared/contracts";
import {
  DEFAULT_PROMPT_NAME_BY_AGENT,
  parsePromptReferenceTokens,
  slugifyPromptName,
} from "@shared/prompts";
import type { Db } from "../../db/client.js";
import {
  archivePromptWithProtectedNames,
  createPromptWithSlugBase,
  getCurrentPromptVersion,
  getPrompt,
  getPromptVersion,
  listPrompts,
  listPromptUsageDefinitionHeads,
  updatePromptMetaWithProtectedNames,
  type PromptLibraryActor,
  type PromptLibraryRow,
  type PromptLibraryVersionRow,
} from "../../prompt-library/store.js";

/** Built-in agent defaults are looked up BY NAME at run time (implicit
 *  materialization); archiving or renaming one would fail every workflow run
 *  that relies on the default prompt. */
const BUILTIN_DEFAULT_PROMPT_NAMES = new Set<string>(
  Object.values(DEFAULT_PROMPT_NAME_BY_AGENT),
);

/** Minimal structural read of a stored definition for the usage scan. The scan
 *  reports what a definition points at, so an unparsable node is skipped
 *  rather than failing the whole report. */
const usageScanNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  params: z.record(z.string(), z.unknown()).catch({}),
  promptRefs: z
    .record(z.string(), z.object({ promptId: z.number(), version: z.number() }))
    .optional()
    .catch(undefined),
});
const usageScanDefinitionSchema = z.object({
  nodes: z.array(z.unknown()).catch([]),
});

export function createPrompt(
  db: Db,
  input: {
    name: string;
    body: string;
    slots?: PromptSlotDefinition[];
    description?: string | null;
    tags?: string[];
    actor: PromptLibraryActor;
  },
): Promise<{ prompt: PromptLibraryRow; current: PromptLibraryVersionRow }> {
  return createPromptWithSlugBase(db, {
    ...input,
    slugBase: slugifyPromptName(input.name.trim()),
  });
}

export function updatePromptMeta(
  db: Db,
  input: {
    promptId: number;
    name?: string;
    description?: string | null;
    tags?: string[];
    actor: PromptLibraryActor;
  },
): Promise<PromptLibraryRow> {
  return updatePromptMetaWithProtectedNames(db, {
    ...input,
    protectedNames: BUILTIN_DEFAULT_PROMPT_NAMES,
  });
}

export function archivePrompt(
  db: Db,
  input: { promptId: number; actor: PromptLibraryActor },
): Promise<PromptLibraryRow> {
  return archivePromptWithProtectedNames(db, {
    ...input,
    protectedNames: BUILTIN_DEFAULT_PROMPT_NAMES,
  });
}

/** Reports workflow-definition usage while keeping token parsing above DB. */
export async function findPromptUsage(
  db: Db,
  promptId: number,
): Promise<PromptLibraryUsageRow[]> {
  const promptRow = await getPrompt(db, promptId);
  if (!promptRow) return [];
  const head = await getCurrentPromptVersion(db, promptId);
  const currentHeadVersion = head?.version ?? 0;
  const definitions = await listPromptUsageDefinitionHeads(db);

  const versionBodyCache = new Map<number, string | null>();
  const bodyOfVersion = async (version: number): Promise<string | null> => {
    if (!versionBodyCache.has(version)) {
      const row = await getPromptVersion(db, promptId, version);
      versionBodyCache.set(version, row?.body ?? null);
    }
    return versionBodyCache.get(version)!;
  };

  const result: PromptLibraryUsageRow[] = [];
  for (const definition of definitions) {
    const parsedDefinition = usageScanDefinitionSchema.safeParse(
      definition.definition,
    );
    if (!parsedDefinition.success) continue;
    for (const rawNode of parsedDefinition.data.nodes) {
      const parsedNode = usageScanNodeSchema.safeParse(rawNode);
      if (!parsedNode.success) continue;
      const node = parsedNode.data;
      const coveredParams = new Set<string>();
      for (const [paramKey, ref] of Object.entries(node.promptRefs ?? {})) {
        if (ref.promptId !== promptId) continue;
        const paramValue = node.params[paramKey];
        const text = typeof paramValue === "string" ? paramValue : null;
        const versionBody = await bodyOfVersion(ref.version);
        const state = versionBody === null || text !== versionBody
          ? "modified"
          : ref.version < currentHeadVersion
            ? "behind"
            : "current";
        coveredParams.add(paramKey);
        result.push({
          definitionId: definition.id,
          definitionName: definition.name,
          nodeId: node.id,
          nodeName: node.name ?? null,
          blockType: node.type as WorkflowBlockType,
          paramKey,
          version: ref.version,
          state,
        });
      }

      for (const [paramKey, value] of Object.entries(node.params)) {
        if (coveredParams.has(paramKey)) continue;
        const texts = typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [];
        const token = texts
          .flatMap((text) => parsePromptReferenceTokens(text))
          .find((candidate) =>
            candidate.slug !== undefined
              ? candidate.slug === promptRow.slug
              : candidate.legacyPromptId === promptId
          );
        if (!token) continue;
        const version = token.version === "latest"
          ? currentHeadVersion
          : token.version;
        result.push({
          definitionId: definition.id,
          definitionName: definition.name,
          nodeId: node.id,
          nodeName: node.name ?? null,
          blockType: node.type as WorkflowBlockType,
          paramKey,
          version,
          state: version < currentHeadVersion ? "behind" : "current",
        });
      }
    }
  }
  return result;
}

/** Reports active prompt bodies that reference another prompt. */
export async function findPromptUsageInPrompts(
  db: Db,
  promptId: number,
): Promise<PromptLibraryPromptUsageRow[]> {
  const promptRow = await getPrompt(db, promptId);
  if (!promptRow) return [];
  const head = await getCurrentPromptVersion(db, promptId);
  const currentHeadVersion = head?.version ?? 0;
  const result: PromptLibraryPromptUsageRow[] = [];
  for (const row of await listPrompts(db)) {
    if (row.id === promptId) continue;
    const token = parsePromptReferenceTokens(row.body).find((candidate) =>
      candidate.slug !== undefined
        ? candidate.slug === promptRow.slug
        : candidate.legacyPromptId === promptId
    );
    if (!token) continue;
    const version = token.version === "latest"
      ? currentHeadVersion
      : token.version;
    result.push({
      promptId: row.id,
      slug: row.slug,
      name: row.name,
      version,
      state: version < currentHeadVersion ? "behind" : "current",
    });
  }
  return result;
}
