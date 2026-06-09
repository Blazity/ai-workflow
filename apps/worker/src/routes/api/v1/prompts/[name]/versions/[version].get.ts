import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import type { PromptVersionBodyResponse } from "@shared/contracts";
import { env } from "../../../../../../../env.js";
import { PROMPT_NAMES, type PromptName } from "../../../../../../lib/prompts.js";
import { logger } from "../../../../../../lib/logger.js";

// TODO(arthur-verify): lazy-vs-eager body — historical bodies are fetched on
// demand here; the production body ships eagerly on the list route.
export default defineEventHandler(async (event): Promise<PromptVersionBodyResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  const generatedAt = new Date().toISOString();

  const name = getRouterParam(event, "name") ?? "";
  const version = getRouterParam(event, "version") ?? "";
  const arthurEnabled =
    !!env.GENAI_ENGINE_API_KEY &&
    !!env.GENAI_ENGINE_TRACE_ENDPOINT &&
    !!env.GENAI_ENGINE_PROMPT_TASK_ID;

  if (!arthurEnabled || !PROMPT_NAMES.includes(name as PromptName) || !version) {
    return { generatedAt, available: false, body: null };
  }

  try {
    const { ArthurClient } = await import("../../../../../../sandbox/arthur-client.js");
    const client = ArthurClient.fromTraceEndpoint(
      env.GENAI_ENGINE_TRACE_ENDPOINT!,
      env.GENAI_ENGINE_API_KEY!,
    );
    const body = await client.getPromptVersionBody(
      env.GENAI_ENGINE_PROMPT_TASK_ID!,
      name,
      version,
    );
    return { generatedAt, available: body !== null, body };
  } catch (err) {
    logger.warn({ name, version, err: (err as Error).message }, "prompt_version_body_failed");
    return { generatedAt, available: false, body: null };
  }
});
