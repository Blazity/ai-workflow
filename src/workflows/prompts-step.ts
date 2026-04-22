export interface LoadedPrompts {
  research: string;
  implement: string;
  review: string;
}

export async function loadPrompts(): Promise<LoadedPrompts> {
  "use step";
  const { env } = await import("../../env.js");
  const { logger } = await import("../lib/logger.js");
  const { PROMPT_FALLBACKS } = await import("../lib/prompts.js");

  const arthurEnabled =
    !!env.GENAI_ENGINE_API_KEY &&
    !!env.GENAI_ENGINE_TRACE_ENDPOINT &&
    !!env.GENAI_ENGINE_PROMPT_TASK_ID;

  if (!arthurEnabled) {
    logger.info({ source: "fallback", reason: "arthur_prompts_disabled" }, "prompts_loaded");
    return {
      research: PROMPT_FALLBACKS["research-plan"],
      implement: PROMPT_FALLBACKS["implement"],
      review: PROMPT_FALLBACKS["review"],
    };
  }

  const { ArthurClient } = await import("../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(
    env.GENAI_ENGINE_TRACE_ENDPOINT!,
    env.GENAI_ENGINE_API_KEY!,
  );
  const taskId = env.GENAI_ENGINE_PROMPT_TASK_ID!;
  const TAG = "production";

  async function one(name: "research-plan" | "implement" | "review"): Promise<string> {
    try {
      const body = await client.getPromptByTag(taskId, name, TAG);
      if (body === null) {
        logger.info({ name, source: "fallback", reason: "arthur_prompt_missing" }, "prompts_loaded");
        return PROMPT_FALLBACKS[name];
      }
      logger.info({ name, source: "arthur" }, "prompts_loaded");
      return body;
    } catch (err) {
      logger.warn({ name, source: "fallback", err: (err as Error).message }, "prompts_loaded");
      return PROMPT_FALLBACKS[name];
    }
  }

  const [research, implement, review] = await Promise.all([
    one("research-plan"),
    one("implement"),
    one("review"),
  ]);
  return { research, implement, review };
}
loadPrompts.maxRetries = 0;
