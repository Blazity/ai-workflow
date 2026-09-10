import {
  containsMalformedPromptReference,
  parsePromptReferenceTokens,
  promptReferenceTargetLabel,
  type ParsedPromptReference,
  type PromptSlotDefinition,
  type PromptReferenceSelector,
  type ResolvedPromptReference,
} from "@shared/contracts";

export interface LoadedPromptReference {
  promptId: number;
  promptName: string;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  body: string;
  slots?: readonly PromptSlotDefinition[];
}

/** Token target: the slug for current tokens, the numeric library id for
 *  legacy pre-slug tokens. Exactly one is set. */
export type PromptReferenceTarget = Pick<ParsedPromptReference, "slug" | "legacyPromptId">;

export type PromptReferenceLoader = (
  target: PromptReferenceTarget,
  requestedVersion: PromptReferenceSelector,
) => Promise<LoadedPromptReference>;

export interface PromptReferenceResolution {
  text: string;
  manifest: ResolvedPromptReference[];
  slots: PromptSlotDefinition[];
}

export interface PromptReferenceResolutionOptions {
  maxDepth?: number;
  maxOutputLength?: number;
  requirePinned?: boolean;
}

export function coalescePromptSlotDefinitions(
  definitions: readonly PromptSlotDefinition[],
): PromptSlotDefinition[] {
  const slots = new Map<string, PromptSlotDefinition>();
  for (const slot of definitions) {
    const existing = slots.get(slot.name);
    if (existing && !sameJsonValue(existing, slot)) {
      throw new Error(
        `Prompt slot conflict for "${slot.name}" between nested reusable prompts`,
      );
    }
    slots.set(slot.name, structuredClone(slot));
  }
  return [...slots.values()];
}

async function hashPromptBody(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolvePromptReferences(
  text: string,
  load: PromptReferenceLoader,
  options: PromptReferenceResolutionOptions = {},
): Promise<PromptReferenceResolution> {
  const maxDepth = options.maxDepth ?? 10;
  const maxOutputLength = options.maxOutputLength ?? 200_000;
  const loaded = new Map<string, LoadedPromptReference>();
  const manifest = new Map<string, ResolvedPromptReference>();
  const slots = new Map<string, PromptSlotDefinition>();

  const expand = async (input: string, stack: string[]): Promise<string> => {
    if (containsMalformedPromptReference(input)) {
      throw new Error("Malformed prompt reference; expected {{prompt:<slug>}} or {{prompt:<slug>@<version>}}");
    }
    const tokens = parsePromptReferenceTokens(input);
    if (tokens.length === 0) {
      if (input.length > maxOutputLength) throw new Error(`Expanded prompt exceeds maximum length ${maxOutputLength}`);
      return input;
    }

    let output = "";
    let cursor = 0;
    for (const token of tokens) {
      output += input.slice(cursor, token.start);
      if (stack.length >= maxDepth) {
        throw new Error(`Prompt reference maximum depth ${maxDepth} exceeded`);
      }
      if (options.requirePinned && token.version === "latest") {
        throw new Error(
          `V2 prompt reference "${token.raw}" must pin an exact version`,
        );
      }

      const selectorKey = `${promptReferenceTargetLabel(token)}@${token.version}`;
      let reference = loaded.get(selectorKey);
      if (!reference) {
        reference = await load(
          token.slug !== undefined ? { slug: token.slug } : { legacyPromptId: token.legacyPromptId },
          token.version,
        );
        loaded.set(selectorKey, reference);
      }
      const resolvedKey = `${reference.promptId}@${reference.resolvedVersion}`;
      if (stack.includes(resolvedKey)) {
        throw new Error(`Prompt reference cycle: ${[...stack, resolvedKey].join(" -> ")}`);
      }
      if (!manifest.has(selectorKey)) {
        manifest.set(selectorKey, {
          promptId: reference.promptId,
          promptName: reference.promptName,
          requestedVersion: reference.requestedVersion,
          resolvedVersion: reference.resolvedVersion,
          bodyHash: await hashPromptBody(reference.body),
        });
      }
      for (const slot of coalescePromptSlotDefinitions([
        ...slots.values(),
        ...(reference.slots ?? []),
      ])) {
        slots.set(slot.name, slot);
      }

      output += await expand(reference.body, [...stack, resolvedKey]);
      if (output.length > maxOutputLength) {
        throw new Error(`Expanded prompt exceeds maximum length ${maxOutputLength}`);
      }
      cursor = token.end;
    }
    output += input.slice(cursor);
    if (output.length > maxOutputLength) throw new Error(`Expanded prompt exceeds maximum length ${maxOutputLength}`);
    return output;
  };

  return {
    text: await expand(text, []),
    manifest: [...manifest.values()],
    slots: [...slots.values()],
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined)
    .sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}
