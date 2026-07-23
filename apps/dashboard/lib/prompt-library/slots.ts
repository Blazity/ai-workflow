import {
  parsePromptReferenceTokens,
  promptReferenceMatchesRow,
  type PromptLibraryVersion,
  type PromptLibraryListRowDto,
  type PromptSlotBinding,
  type PromptSlotDefinition,
} from "@shared/contracts";
import { findCanonicalPromptTokens } from "./canonical-tokens";

export type PromptLibrarySlotRow = PromptLibraryListRowDto & {
  slots?: PromptSlotDefinition[];
};

export interface ResolvedPromptSlots {
  definitions: PromptSlotDefinition[];
  conflicts: string[];
  unresolvedReferences: string[];
}

export type PromptLibraryVersionSnapshots = Readonly<
  Record<string, PromptLibraryVersion>
>;

export interface PromptVersionLoadRequest {
  reference: string;
  promptId: number;
  version: number;
  key: string;
}

export function promptLibraryVersionKey(
  promptId: number,
  version: number,
): string {
  return `${promptId}@${version}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Builds the slot requirements from immutable prompt versions. Head versions
 * come from the list response; older pinned versions are supplied by the
 * version-detail cache populated by the workflow inspector.
 */
export function resolvePromptSlotsFromLibrary(
  markdown: string,
  rows: readonly PromptLibrarySlotRow[],
  versionSnapshots: PromptLibraryVersionSnapshots = {},
): ResolvedPromptSlots {
  const definitions = new Map<string, PromptSlotDefinition>();
  const conflicts = new Set<string>();
  const unresolved = new Set<string>();
  const visited = new Set<string>();

  const visit = (source: string) => {
    const references = findCanonicalPromptTokens(source)
      .filter((token) => token.kind === "prompt")
      .flatMap((token) => parsePromptReferenceTokens(token.raw));
    for (const reference of references) {
      const row = rows.find((candidate) =>
        promptReferenceMatchesRow(reference, candidate),
      );
      if (!row) {
        unresolved.add(reference.raw);
        continue;
      }
      const version =
        reference.version === "latest"
          ? row.currentVersion
          : reference.version;
      const snapshot =
        version === row.currentVersion
          ? { body: row.body, slots: row.slots ?? [] }
          : versionSnapshots[promptLibraryVersionKey(row.id, version)];
      if (!snapshot) {
        unresolved.add(reference.raw);
        continue;
      }
      const key = `${row.slug}@${version}`;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const definition of snapshot.slots ?? []) {
        const existing = definitions.get(definition.name);
        if (!existing) {
          definitions.set(definition.name, structuredClone(definition));
        } else if (stable(existing) !== stable(definition)) {
          conflicts.add(definition.name);
        }
      }
      visit(snapshot.body);
    }
  };

  visit(markdown);
  return {
    definitions: [...definitions.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    conflicts: [...conflicts].sort(),
    unresolvedReferences: [...unresolved],
  };
}

/**
 * Resolves the exact immutable versions that the UI still needs to load.
 * Missing prompts and `latest` references cannot be fetched by version and
 * remain workflow-validation concerns.
 */
export function promptVersionLoadRequests(
  unresolvedReferences: readonly string[],
  rows: readonly PromptLibrarySlotRow[],
  versionSnapshots: PromptLibraryVersionSnapshots,
  failedKeys: ReadonlySet<string> = new Set(),
): PromptVersionLoadRequest[] {
  const requests = new Map<string, PromptVersionLoadRequest>();
  for (const raw of unresolvedReferences) {
    const reference = parsePromptReferenceTokens(raw)[0];
    if (!reference || typeof reference.version !== "number") continue;
    const row = rows.find((candidate) =>
      promptReferenceMatchesRow(reference, candidate),
    );
    if (!row || reference.version === row.currentVersion) continue;
    const key = promptLibraryVersionKey(row.id, reference.version);
    if (versionSnapshots[key] || failedKeys.has(key)) continue;
    requests.set(key, {
      reference: raw,
      promptId: row.id,
      version: reference.version,
      key,
    });
  }
  return [...requests.values()];
}

/**
 * A saved binding must stay editable while an older prompt version is loading.
 * Unknown definitions are temporary UI placeholders only; worker validation
 * remains authoritative and replaces them once exact metadata arrives.
 */
export function includePendingPromptSlotBindings(
  definitions: readonly PromptSlotDefinition[],
  bindings: Readonly<Record<string, PromptSlotBinding>>,
  hasUnresolvedReferences: boolean,
): PromptSlotDefinition[] {
  if (!hasUnresolvedReferences) return [...definitions];
  const existing = new Set(definitions.map((definition) => definition.name));
  return [
    ...definitions,
    ...Object.keys(bindings)
      .filter((name) => !existing.has(name))
      .sort()
      .map((name) => ({
        name,
        description: "Loading slot metadata from the pinned prompt version.",
        schema: {},
        required: false,
      })),
  ];
}

export function samePromptSlots(
  left: readonly PromptSlotDefinition[],
  right: readonly PromptSlotDefinition[],
): boolean {
  return stable(left) === stable(right);
}

export function renamePromptSlotTokens(
  markdown: string,
  currentName: string,
  nextName: string,
): string {
  const matches = findCanonicalPromptTokens(markdown).filter(
    (token) => token.kind === "slot" && token.value === currentName,
  );
  if (matches.length === 0) return markdown;
  let cursor = 0;
  let renamed = "";
  for (const match of matches) {
    renamed += markdown.slice(cursor, match.start);
    renamed += `{{slot:${nextName}}}`;
    cursor = match.end;
  }
  return renamed + markdown.slice(cursor);
}
