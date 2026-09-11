import { isDeepStrictEqual } from "node:util";
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
import type { Db } from "../../db/types.js";
import type { DashboardRole } from "@shared/contracts";
import { canEditPromptLibrary } from "@shared/contracts";
import {
  archivePrompt as archivePromptRaw,
  appendConnectedPromptVersion,
  appendPromptVersion,
  archiveConnectedPrompt as archiveConnectedPromptRaw,
  createConnectedPromptWithInitialVersion,
  createPromptWithInitialVersion,
  deleteConnectedOrphanPromptByName,
  deleteOrphanPromptByName,
  getCurrentPromptVersion,
  getConnectedCurrentPromptVersion,
  getConnectedPrompt,
  getConnectedPromptVersion,
  listConnectedPromptHeadRows,
  listConnectedActivePromptSlugsByPrefix,
  listConnectedPromptUsageDefinitionHeads,
  getPrompt,
  getPromptVersion,
  listPromptHeadRows,
  listActivePromptSlugsByPrefix,
  listPromptUsageDefinitionHeads,
  updatePromptMeta as updatePromptMetaRaw,
  updateConnectedPromptMeta as updateConnectedPromptMetaRaw,
  type PromptLibraryActor,
  type PromptLibraryListRow,
  type PromptLibraryRow,
  type PromptLibraryVersionRow,
} from "../../db/repositories/prompts.js";
import { PromptLibraryCasMissError, PromptLibraryStoreError } from "./prompt-library-failures.js";
import {
  validatePromptBody,
  validatePromptDescription,
  validatePromptName,
  validatePromptSlots,
  validatePromptTags,
} from "./prompt-library-validation.js";

const QUERY_MAX_LENGTH = 100;

function normalizeQuery(q: string | undefined): string | null {
  if (!q) return null;
  const trimmed = q.trim().slice(0, QUERY_MAX_LENGTH);
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function matchesQuery(row: PromptLibraryListRow, query: string): boolean {
  return [row.name, row.description ?? "", ...row.tags, row.body]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

export async function listPrompts(
  db: Db,
  filter?: { q?: string; tag?: string; includeArchived?: boolean },
): Promise<PromptLibraryListRow[]> {
  const rows = await listPromptHeadRows(db, filter);
  const query = normalizeQuery(filter?.q);
  return query ? rows.filter((row) => matchesQuery(row, query)) : rows;
}

export async function listConnectedPrompts(
  filter?: { q?: string; tag?: string; includeArchived?: boolean },
): Promise<PromptLibraryListRow[]> {
  const rows = await listConnectedPromptHeadRows(filter);
  const query = normalizeQuery(filter?.q);
  return query ? rows.filter((row) => matchesQuery(row, query)) : rows;
}

/** Built-in agent defaults are looked up BY NAME at run time (implicit
 *  materialization); archiving or renaming one would fail every workflow run
 *  that relies on the default prompt. */
const BUILTIN_DEFAULT_PROMPT_NAMES = new Set<string>(
  Object.values(DEFAULT_PROMPT_NAME_BY_AGENT),
);

export function requirePromptLibraryEditRole(role: DashboardRole): void {
  if (!canEditPromptLibrary(role)) {
    throw new PromptLibraryStoreError(403, "Forbidden");
  }
}

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

export async function createPrompt(
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
  requirePromptLibraryEditRole(input.actor.role as DashboardRole);
  const name = validatePromptName(input.name);
  return createPromptWithPolicy({
    listSlugs: (base) => listActivePromptSlugsByPrefix(db, base),
    deleteOrphan: (orphanName) => deleteOrphanPromptByName(db, orphanName),
    create: (createInput) => createPromptWithInitialVersion(db, createInput),
  }, {
    ...input,
    name,
    body: validatePromptBody(input.body),
    slots: validatePromptSlots(input.slots ?? []),
    description: validatePromptDescription(input.description ?? null),
    tags: validatePromptTags(input.tags ?? []),
    slugBase: slugifyPromptName(name),
  });
}

export async function updatePromptMeta(
  db: Db,
  input: {
    promptId: number;
    name?: string;
    description?: string | null;
    tags?: string[];
    actor: PromptLibraryActor;
  },
): Promise<PromptLibraryRow> {
  requirePromptLibraryEditRole(input.actor.role as DashboardRole);
  const name = input.name === undefined ? undefined : validatePromptName(input.name);
  const description = input.description === undefined
    ? undefined
    : validatePromptDescription(input.description);
  const tags = input.tags === undefined ? undefined : validatePromptTags(input.tags);
  return updatePromptMetaWithPolicy({ get: (id) => getPrompt(db, id), update: (update) => updatePromptMetaRaw(db, update) }, { ...input, name, description, tags });
}

export async function archivePrompt(
  db: Db,
  input: { promptId: number; actor: PromptLibraryActor },
): Promise<PromptLibraryRow> {
  requirePromptLibraryEditRole(input.actor.role as DashboardRole);
  return archivePromptWithPolicy({ get: (id) => getPrompt(db, id), archive: (archive) => archivePromptRaw(db, archive) }, input);
}

export async function createConnectedPrompt(input: Parameters<typeof createPrompt>[1]) {
  requirePromptLibraryEditRole(input.actor.role as DashboardRole);
  const name = validatePromptName(input.name);
  return createPromptWithPolicy({
    listSlugs: listConnectedActivePromptSlugsByPrefix,
    deleteOrphan: deleteConnectedOrphanPromptByName,
    create: createConnectedPromptWithInitialVersion,
  }, {
    ...input, name, body: validatePromptBody(input.body),
    slots: validatePromptSlots(input.slots ?? []),
    description: validatePromptDescription(input.description ?? null),
    tags: validatePromptTags(input.tags ?? []), slugBase: slugifyPromptName(name),
  });
}

type PromptCreateInput = Omit<Parameters<typeof createPromptWithInitialVersion>[1], "slug"> & {
  slugBase: string;
};

type PromptCreatePersistence = {
  listSlugs(base: string): Promise<string[]>;
  deleteOrphan(name: string): Promise<boolean>;
  create(input: Parameters<typeof createPromptWithInitialVersion>[1]): ReturnType<typeof createPromptWithInitialVersion>;
};

async function createPromptWithPolicy(
  persistence: PromptCreatePersistence,
  input: PromptCreateInput,
): ReturnType<typeof createPromptWithInitialVersion> {
  const slug = nextAvailableSlug(input.slugBase, await persistence.listSlugs(input.slugBase));
  try {
    return await persistence.create({ ...input, slug });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const healed = await persistence.deleteOrphan(input.name);
    const retrySlug = nextAvailableSlug(
      input.slugBase,
      await persistence.listSlugs(input.slugBase),
    );
    if (!healed && retrySlug === slug) {
      throw new PromptLibraryStoreError(409, "Name already in use");
    }
    try {
      return await persistence.create({ ...input, slug: retrySlug });
    } catch (retryError) {
      if (isUniqueViolation(retryError)) {
        throw new PromptLibraryStoreError(409, "Name already in use");
      }
      throw retryError;
    }
  }
}

function nextAvailableSlug(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: string }).code === "23505") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/duplicate key value|unique constraint/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Retries the version insert race and maps exhausted unique conflicts to 409. */
export async function retryOnUniqueViolation<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < attempts && isUniqueViolation(error)) continue;
      if (isUniqueViolation(error)) {
        throw new PromptLibraryStoreError(409, "Concurrent update, please retry");
      }
      throw error;
    }
  }
}

export async function updateConnectedPromptMeta(input: Parameters<typeof updatePromptMeta>[1]) {
  requirePromptLibraryEditRole(input.actor.role as DashboardRole);
  return updatePromptMetaWithPolicy({ get: getConnectedPrompt, update: updateConnectedPromptMetaRaw }, {
    ...input, name: input.name === undefined ? undefined : validatePromptName(input.name),
    description: input.description === undefined ? undefined : validatePromptDescription(input.description),
    tags: input.tags === undefined ? undefined : validatePromptTags(input.tags),
  });
}

export async function archiveConnectedPrompt(input: Parameters<typeof archivePrompt>[1]) {
  requirePromptLibraryEditRole(input.actor.role as DashboardRole);
  return archivePromptWithPolicy({ get: getConnectedPrompt, archive: archiveConnectedPromptRaw }, input);
}

export async function saveConnectedPromptVersionWithPolicy(input: {
  promptId: number; body: string; slots?: PromptSlotDefinition[];
  expectedVersion?: number; actor: PromptLibraryActor;
}): Promise<{ version: PromptLibraryVersionRow; changed: boolean }> {
  const prompt = await getConnectedPrompt(input.promptId);
  if (!prompt) throw new PromptLibraryStoreError(404, "Unknown prompt");
  if (prompt.archivedAt) throw new PromptLibraryStoreError(409, "Prompt is archived");
  const head = await getConnectedCurrentPromptVersion(input.promptId);
  const slots = input.slots ?? head?.slots ?? [];
  if (input.expectedVersion !== undefined && (head?.version ?? 0) !== input.expectedVersion) {
    throw new PromptLibraryCasMissError(input.promptId, input.expectedVersion, head?.version ?? null);
  }
  if (head && head.body === input.body && isDeepStrictEqual(head.slots, slots)) return { version: head, changed: false };
  const append = () => appendConnectedPromptVersion({ ...input, slots, restoredFromVersion: null, expectedVersion: input.expectedVersion });
  let saved: PromptLibraryVersionRow | null;
  try {
    saved = input.expectedVersion === undefined
      ? await retryOnUniqueViolation(append)
      : await append();
  } catch (error) {
    if (input.expectedVersion === undefined || !isUniqueViolation(error)) throw error;
    const current = await getConnectedCurrentPromptVersion(input.promptId);
    throw new PromptLibraryCasMissError(input.promptId, input.expectedVersion, current?.version ?? null);
  }
  if (!saved) {
    const current = await getConnectedCurrentPromptVersion(input.promptId);
    if (input.expectedVersion !== undefined) throw new PromptLibraryCasMissError(input.promptId, input.expectedVersion, current?.version ?? null);
    throw new PromptLibraryStoreError(409, "Prompt is archived");
  }
  return { version: saved, changed: true };
}

export async function savePromptVersionWithPolicy(
  db: Db,
  input: Parameters<typeof saveConnectedPromptVersionWithPolicy>[0],
): Promise<{ version: PromptLibraryVersionRow; changed: boolean }> {
  const prompt = await getPrompt(db, input.promptId);
  if (!prompt) throw new PromptLibraryStoreError(404, "Unknown prompt");
  if (prompt.archivedAt) throw new PromptLibraryStoreError(409, "Prompt is archived");
  const head = await getCurrentPromptVersion(db, input.promptId);
  const slots = input.slots ?? head?.slots ?? [];
  if (input.expectedVersion !== undefined && (head?.version ?? 0) !== input.expectedVersion) {
    throw new PromptLibraryCasMissError(input.promptId, input.expectedVersion, head?.version ?? null);
  }
  if (head && head.body === input.body && isDeepStrictEqual(head.slots, slots)) return { version: head, changed: false };
  const append = () => appendPromptVersion(db, { ...input, slots, restoredFromVersion: null, expectedVersion: input.expectedVersion });
  let saved: PromptLibraryVersionRow | null;
  try {
    saved = input.expectedVersion === undefined ? await retryOnUniqueViolation(append) : await append();
  } catch (error) {
    if (input.expectedVersion === undefined || !isUniqueViolation(error)) throw error;
    const current = await getCurrentPromptVersion(db, input.promptId);
    throw new PromptLibraryCasMissError(input.promptId, input.expectedVersion, current?.version ?? null);
  }
  if (!saved) {
    const current = await getCurrentPromptVersion(db, input.promptId);
    if (input.expectedVersion !== undefined) throw new PromptLibraryCasMissError(input.promptId, input.expectedVersion, current?.version ?? null);
    throw new PromptLibraryStoreError(409, "Prompt is archived");
  }
  return { version: saved, changed: true };
}

export async function restoreConnectedPromptVersionWithPolicy(input: {
  promptId: number; version: number; actor: PromptLibraryActor;
}): Promise<PromptLibraryVersionRow> {
  const prompt = await getConnectedPrompt(input.promptId);
  if (prompt?.archivedAt) throw new PromptLibraryStoreError(409, "Prompt is archived");
  const source = await getConnectedPromptVersion(input.promptId, input.version);
  if (!source) throw new PromptLibraryStoreError(404, "Unknown version");
  const restored = await retryOnUniqueViolation(() => appendConnectedPromptVersion({
    promptId: input.promptId, body: source.body, slots: source.slots,
    restoredFromVersion: source.version, actor: input.actor,
  }));
  if (!restored) throw new PromptLibraryStoreError(409, "Prompt is archived");
  return restored;
}

export async function restorePromptVersionWithPolicy(
  db: Db,
  input: Parameters<typeof restoreConnectedPromptVersionWithPolicy>[0],
): Promise<PromptLibraryVersionRow> {
  const prompt = await getPrompt(db, input.promptId);
  if (prompt?.archivedAt) throw new PromptLibraryStoreError(409, "Prompt is archived");
  const source = await getPromptVersion(db, input.promptId, input.version);
  if (!source) throw new PromptLibraryStoreError(404, "Unknown version");
  const restored = await retryOnUniqueViolation(() => appendPromptVersion(db, {
    promptId: input.promptId, body: source.body, slots: source.slots,
    restoredFromVersion: source.version, actor: input.actor,
  }));
  if (!restored) throw new PromptLibraryStoreError(409, "Prompt is archived");
  return restored;
}

type PromptMetaPersistence = {
  get(id: number): ReturnType<typeof getPrompt>;
  update(input: Parameters<typeof updatePromptMetaRaw>[1]): ReturnType<typeof updatePromptMetaRaw>;
};

async function updatePromptMetaWithPolicy(persistence: PromptMetaPersistence, input: Parameters<typeof updatePromptMeta>[1]): Promise<PromptLibraryRow> {
  const current = await persistence.get(input.promptId);
  if (!current) throw new PromptLibraryStoreError(404, "Unknown prompt");
  if (current.archivedAt) throw new PromptLibraryStoreError(409, "Prompt is archived");
  if (input.name !== undefined && input.name !== current.name && BUILTIN_DEFAULT_PROMPT_NAMES.has(current.name)) {
    throw new PromptLibraryStoreError(409, `"${current.name}" is a built-in default prompt and cannot be renamed`);
  }
  if (input.name === undefined && input.description === undefined && input.tags === undefined) return current;
  let updated: PromptLibraryRow | null;
  try {
    updated = await persistence.update(input);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PromptLibraryStoreError(409, "Name already in use");
    }
    throw error;
  }
  if (!updated) throw new PromptLibraryStoreError(409, "Prompt is archived");
  return updated;
}

type PromptArchivePersistence = { get(id: number): ReturnType<typeof getPrompt>; archive(input: Parameters<typeof archivePromptRaw>[1]): ReturnType<typeof archivePromptRaw> };
async function archivePromptWithPolicy(persistence: PromptArchivePersistence, input: Parameters<typeof archivePrompt>[1]): Promise<PromptLibraryRow> {
  const current = await persistence.get(input.promptId);
  if (!current) throw new PromptLibraryStoreError(404, "Unknown prompt");
  if (current.archivedAt) return current;
  if (BUILTIN_DEFAULT_PROMPT_NAMES.has(current.name)) throw new PromptLibraryStoreError(409, `"${current.name}" is a built-in default prompt and cannot be archived`);
  return (await persistence.archive(input)) ?? current;
}

/** Reports workflow-definition usage while keeping token parsing above DB. */
export async function findPromptUsage(
  db: Db,
  promptId: number,
): Promise<PromptLibraryUsageRow[]> {
  return findPromptUsageWithReads(promptId, {
    getPrompt: (id) => getPrompt(db, id),
    getCurrentPromptVersion: (id) => getCurrentPromptVersion(db, id),
    getPromptVersion: (id, version) => getPromptVersion(db, id, version),
    listPrompts: () => listPrompts(db),
    listUsageDefinitionHeads: () => listPromptUsageDefinitionHeads(db),
  });
}

type PromptUsageReads = {
  getPrompt(promptId: number): ReturnType<typeof getPrompt>;
  getCurrentPromptVersion(promptId: number): ReturnType<typeof getCurrentPromptVersion>;
  getPromptVersion(promptId: number, version: number): ReturnType<typeof getPromptVersion>;
  listPrompts(): ReturnType<typeof listPrompts>;
  listUsageDefinitionHeads(): ReturnType<typeof listPromptUsageDefinitionHeads>;
};

async function findPromptUsageWithReads(
  promptId: number,
  reads: PromptUsageReads,
): Promise<PromptLibraryUsageRow[]> {
  const promptRow = await reads.getPrompt(promptId);
  if (!promptRow) return [];
  const head = await reads.getCurrentPromptVersion(promptId);
  const currentHeadVersion = head?.version ?? 0;
  const definitions = await reads.listUsageDefinitionHeads();

  const versionBodyCache = new Map<number, string | null>();
  const bodyOfVersion = async (version: number): Promise<string | null> => {
    if (!versionBodyCache.has(version)) {
      const row = await reads.getPromptVersion(promptId, version);
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
  return findPromptUsageInPromptsWithReads(promptId, {
    getPrompt: (id) => getPrompt(db, id),
    getCurrentPromptVersion: (id) => getCurrentPromptVersion(db, id),
    getPromptVersion: (id, version) => getPromptVersion(db, id, version),
    listPrompts: () => listPrompts(db),
    listUsageDefinitionHeads: () => listPromptUsageDefinitionHeads(db),
  });
}

async function findPromptUsageInPromptsWithReads(
  promptId: number,
  reads: PromptUsageReads,
): Promise<PromptLibraryPromptUsageRow[]> {
  const promptRow = await reads.getPrompt(promptId);
  if (!promptRow) return [];
  const head = await reads.getCurrentPromptVersion(promptId);
  const currentHeadVersion = head?.version ?? 0;
  const result: PromptLibraryPromptUsageRow[] = [];
  for (const row of await reads.listPrompts()) {
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

/** Process-bound library reads. The parsing and interpretation above remain
 * service policy; only the process database binding is omitted from callers. */
export function findConnectedPromptUsage(promptId: number) {
  return findPromptUsageWithReads(promptId, connectedPromptUsageReads);
}

export function findConnectedPromptUsageInPrompts(promptId: number) {
  return findPromptUsageInPromptsWithReads(promptId, connectedPromptUsageReads);
}

const connectedPromptUsageReads: PromptUsageReads = {
  getPrompt: getConnectedPrompt,
  getCurrentPromptVersion: getConnectedCurrentPromptVersion,
  getPromptVersion: getConnectedPromptVersion,
  listPrompts: () => listConnectedPrompts({}),
  listUsageDefinitionHeads: listConnectedPromptUsageDefinitionHeads,
};
