import { generateText, Output, jsonSchema } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export interface GenerateStructuredInput {
  model: string;
  system?: string;
  prompt: string;
  /**
   * JSON-schema string describing the desired object. When present the model is
   * asked to return a matching object; when absent, plain text is generated.
   */
  schema?: string;
}

export interface GenerateStructuredResult {
  /** Parsed object matching `schema`. Absent when no schema was requested. */
  object?: unknown;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/**
 * Thin wrapper over the ai SDK's `generateText` that centralizes the
 * structured-vs-text branch and normalizes token usage into a stable shape.
 * Extracted from the post-PR-gate code-hygiene step so new block executors can
 * reuse it without re-deriving the Output.object / jsonSchema plumbing.
 */
export async function generateStructured(
  input: GenerateStructuredInput,
): Promise<GenerateStructuredResult> {
  const { model, system, prompt, schema } = input;
  const base = {
    model: anthropic(model),
    ...(system !== undefined ? { system } : {}),
    prompt,
  };

  if (schema) {
    const result = await generateText({
      ...base,
      output: Output.object({ schema: jsonSchema(JSON.parse(schema)) }),
    });
    return { object: result.output, text: result.text, usage: mapUsage(result.usage) };
  }

  const result = await generateText(base);
  return { text: result.text, usage: mapUsage(result.usage) };
}

function mapUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}): GenerateStructuredResult["usage"] {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0,
  };
}
