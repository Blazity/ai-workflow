export type LlmProvider = "claude" | "codex";

/** Best-effort provider guess from a model id when none was passed explicitly. */
export function inferProvider(model: string): LlmProvider | undefined {
  const id = model.toLowerCase();
  if (id.startsWith("claude") || id.startsWith("anthropic")) return "claude";
  if (id.startsWith("gpt") || /^o[0-9]/.test(id) || id.includes("codex")) return "codex";
  return undefined;
}

/** The exact provider resolution used by the in-process LLM runtime. */
export function resolveLlmProvider(model: string, provider?: LlmProvider): LlmProvider {
  return provider ?? inferProvider(model) ?? "claude";
}
