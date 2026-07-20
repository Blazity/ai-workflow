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

  const expand = async (input: string, stack: string[]): Promise<string> => {
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
      if (stack.length >= maxDepth) {
        throw new Error(`Prompt reference maximum depth ${maxDepth} exceeded`);
      }

      const selectorKey = `${token.promptId}@${token.version}`;
      let reference = loaded.get(selectorKey);
      if (!reference) {
        reference = await load(token.promptId, token.version);
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

  return { text: await expand(text, []), manifest: [...manifest.values()] };
}
