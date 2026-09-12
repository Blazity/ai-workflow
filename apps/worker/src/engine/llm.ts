import {
  jsonSchemaForProvider,
  normalizeJsonSchemaProviderOutput,
  parseJsonSchema202012,
} from "../workflow-definition/json-schema.js";
import {
  generateProviderText,
  type GenerateProviderTextInput,
  type GenerateProviderTextResult,
} from "../infra/llm.js";
import {
  resolveLlmProvider,
  type LlmProvider,
} from "../infra/llm-provider.js";
import { loadEnvironmentPort } from "./internal/ports.js";

export interface GenerateStructuredInput {
  model: string;
  /**
   * Which AI SDK provider to route to. When omitted it is inferred from the
   * model id (claude prefix to claude, gpt or o-series to codex) and falls back
   * to claude.
   */
  provider?: LlmProvider;
  system?: string;
  prompt: string;
  /** Optional caller budget; the module safety timeout remains the upper bound. */
  timeoutMs?: number;
  /**
   * JSON-schema string describing the desired object. When present the model is
   * asked to return a matching object; when absent, plain text is generated.
   */
  schema?: string;
}

export interface GenerateStructuredResult extends GenerateProviderTextResult {}

/**
 * Engine-side schema wrapper around the provider transport. It keeps workflow
 * JSON-schema parsing and provider normalization out of infrastructure.
 */
export async function generateStructured(
  input: GenerateStructuredInput,
): Promise<GenerateStructuredResult> {
  const { model, provider, system, prompt, schema, timeoutMs } = input;
  const effectiveProvider = resolveLlmProvider(model, provider);
  let parsedSchema: ReturnType<typeof parseJsonSchema202012> | undefined;
  let providerSchema: unknown;

  if (schema) {
    parsedSchema = parseJsonSchema202012(schema, { legacyCompatibility: true });
    if (!parsedSchema.ok) {
      throw new Error(parsedSchema.issues[0]?.message ?? "outputSchema is invalid.");
    }
    providerSchema = jsonSchemaForProvider(parsedSchema.schema, effectiveProvider);
  }

  const { env } = await loadEnvironmentPort();
  const providerInput: GenerateProviderTextInput = {
    model,
    provider: effectiveProvider,
    prompt,
    credentials: {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      codexApiKey: env.CODEX_API_KEY,
    },
  };
  if (system !== undefined) providerInput.system = system;
  if (timeoutMs !== undefined) providerInput.timeoutMs = timeoutMs;
  if (providerSchema !== undefined) providerInput.schema = providerSchema;
  const result = await generateProviderText(providerInput);

  if (!schema || parsedSchema === undefined || !parsedSchema.ok) return result;
  return {
    object: normalizeJsonSchemaProviderOutput(
      parsedSchema.schema,
      effectiveProvider,
      result.object,
    ),
    text: result.text,
    usage: result.usage,
  };
}
