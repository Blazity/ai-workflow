import type { PromptVersion } from "@shared/contracts";
import { env } from "../../../env.js";
import { logger } from "../logger.js";
import { PROMPT_FALLBACKS, PROMPT_NAMES, type PromptName } from "../prompts.js";

const PHASE_LABEL: Record<PromptName, string> = {
  "research-plan": "Research & Plan",
  "implement": "Implement",
  "review": "Review",
};

export interface ResolvedPrompt {
  name: PromptName;
  phase: string;
  body: string;
  source: "arthur" | "fallback";
  model: string;
  versions: PromptVersion[];
}

export interface ResolvePromptsResult {
  arthurEnabled: boolean;
  prompts: ResolvedPrompt[];
}

/**
 * Resolve each workflow phase prompt to its production body + (optionally) real
 * Arthur version history. Shared by the durable `loadPrompts()` step and the
 * `GET /api/v1/prompts` route so the two never drift.
 *
 * Version history is a dashboard-only concern, so `withVersions` lets the
 * durable step skip the per-prompt `listPromptVersions` fan-out it would
 * otherwise discard. When false, `versions` resolves to `[]` and only the
 * production body is fetched.
 *
 * When Arthur is unconfigured (`GENAI_ENGINE_*`, incl. `GENAI_ENGINE_PROMPT_TASK_ID`,
 * unset) every prompt resolves to its in-code `PROMPT_FALLBACKS` string with
 * `source: "fallback"` and an empty version history.
 */
export async function resolvePrompts(opts: { withVersions: boolean }): Promise<ResolvePromptsResult> {
  const { withVersions } = opts;
  const model = env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
  const arthurEnabled =
    !!env.GENAI_ENGINE_API_KEY &&
    !!env.GENAI_ENGINE_TRACE_ENDPOINT &&
    !!env.GENAI_ENGINE_PROMPT_TASK_ID;

  const base = (
    name: PromptName,
    body: string,
    source: "arthur" | "fallback",
    versions: PromptVersion[] = [],
  ): ResolvedPrompt => ({ name, phase: PHASE_LABEL[name], body, source, model, versions });

  if (!arthurEnabled) {
    logger.info({ source: "fallback", reason: "arthur_prompts_disabled" }, "prompts_resolved");
    return {
      arthurEnabled,
      prompts: PROMPT_NAMES.map((n) => base(n, PROMPT_FALLBACKS[n], "fallback")),
    };
  }

  const { ArthurClient } = await import("../../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(
    env.GENAI_ENGINE_TRACE_ENDPOINT!,
    env.GENAI_ENGINE_API_KEY!,
  );
  const taskId = env.GENAI_ENGINE_PROMPT_TASK_ID!;
  const TAG = "production";

  async function one(name: PromptName): Promise<ResolvedPrompt> {
    try {
      // TODO(arthur-verify): version-list pagination depth — first page only.
      let body: string | null;
      let versions: PromptVersion[] = [];
      if (withVersions) {
        const [rawBody, rawVersions] = await Promise.all([
          client.getPromptByTag(taskId, name, TAG),
          client.listPromptVersions(taskId, name).catch(() => []),
        ]);
        body = rawBody;
        versions = rawVersions.map((v) => ({
          version: v.version,
          createdAt: v.created_at,
          tags: v.tags,
          modelProvider: v.model_provider,
          modelName: v.model_name,
          numMessages: v.num_messages,
          numTools: v.num_tools,
        }));
        // Attach the eager production body to its matching version entry; other
        // version bodies are fetched on demand via the by-version route.
        const prodVersion = versions.find((v) => v.tags.includes(TAG));
        if (prodVersion && body !== null) prodVersion.body = body;
      } else {
        body = await client.getPromptByTag(taskId, name, TAG);
      }

      if (body === null) {
        logger.info({ name, source: "fallback", reason: "arthur_prompt_missing" }, "prompts_resolved");
        return base(name, PROMPT_FALLBACKS[name], "fallback", versions);
      }
      logger.info({ name, source: "arthur", versions: versions.length }, "prompts_resolved");
      return base(name, body, "arthur", versions);
    } catch (err) {
      logger.warn({ name, source: "fallback", err: (err as Error).message }, "prompts_resolved");
      return base(name, PROMPT_FALLBACKS[name], "fallback");
    }
  }

  const prompts = await Promise.all(PROMPT_NAMES.map(one));
  return { arthurEnabled, prompts };
}
