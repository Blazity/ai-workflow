import {
  containsMalformedPromptReference,
  parsePromptReferenceTokens,
  type PromptReferenceSelector,
  type ResolvedPromptReference,
} from "@shared/contracts";

export interface LoadedPromptReference {
  promptId: number;
  promptName: string;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  body: string;
}

export type PromptReferenceLoader = (
  promptId: number,
  requestedVersion: PromptReferenceSelector,
) => Promise<LoadedPromptReference>;

export interface PromptReferenceResolution {
  text: string;
  manifest: ResolvedPromptReference[];
}

export interface PromptReferenceResolutionOptions {
  maxDepth?: number;
  maxOutputLength?: number;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

  const expand = async (input: string, stack: number[]): Promise<string> => {
    if (containsMalformedPromptReference(input)) {
      throw new Error("Malformed prompt reference; expected {{prompt:<id>}} or {{prompt:<id>@<version>}}");
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
      if (stack.includes(token.promptId)) {
        throw new Error(`Prompt reference cycle: ${[...stack, token.promptId].join(" -> ")}`);
      }
      if (stack.length >= maxDepth) {
        throw new Error(`Prompt reference maximum depth ${maxDepth} exceeded`);
      }

      const selectorKey = `${token.promptId}@${token.version}`;
      let reference = loaded.get(selectorKey);
      if (!reference) {
        reference = await load(token.promptId, token.version);
        loaded.set(selectorKey, reference);
      }
      if (!manifest.has(selectorKey)) {
        manifest.set(selectorKey, {
          promptId: reference.promptId,
          promptName: reference.promptName,
          requestedVersion: reference.requestedVersion,
          resolvedVersion: reference.resolvedVersion,
          bodyHash: fnv1a(reference.body),
        });
      }

      output += await expand(reference.body, [...stack, token.promptId]);
      if (output.length > maxOutputLength) {
        throw new Error(`Expanded prompt exceeds maximum length ${maxOutputLength}`);
      }
      cursor = token.end;
    }
    output += input.slice(cursor);
    if (output.length > maxOutputLength) throw new Error(`Expanded prompt exceeds maximum length ${maxOutputLength}`);
    return output;
  };

  return { text: await expand(text, []), manifest: [...manifest.values()] };
}
