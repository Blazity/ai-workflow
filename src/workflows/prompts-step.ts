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
  type PromptName = keyof typeof PROMPT_FALLBACKS;

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

  async function one(name: PromptName): Promise<string> {
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

export interface ReviewPromptSource {
  source: "arthur" | "local" | "builtin";
  name?: string;
  tag?: string;
  path?: string;
}

export interface LoadedReviewPrompt {
  body: string;
  source_kind: ReviewPromptSource["source"];
  source_id: string;
  hash: string;
  fallback_used: boolean;
}

export async function loadReviewPrompt(spec: ReviewPromptSource): Promise<LoadedReviewPrompt> {
  "use step";
  const { env } = await import("../../env.js");
  const { getBuiltinReviewPrompt } = await import("../lib/prompts.js");
  const { logger } = await import("../lib/logger.js");
  const { createHash } = await import("node:crypto");

  function shortHash(body: string): string {
    return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
  }

  if (spec.source === "builtin") {
    if (!spec.name) throw new Error("builtin prompt requires `name`");
    const body = getBuiltinReviewPrompt(spec.name);
    if (!body) throw new Error(`unknown builtin prompt: ${spec.name}`);
    return {
      body,
      source_kind: "builtin",
      source_id: `builtin:${spec.name}`,
      hash: shortHash(body),
      fallback_used: false,
    };
  }

  if (spec.source === "local") {
    if (!spec.path) throw new Error("local prompt requires `path`");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const MAX_PROMPT_BYTES = 256 * 1024; // 256 KB
    const repoRoot = path.resolve(process.cwd());
    const abs = path.resolve(repoRoot, spec.path);
    // Path traversal guard: resolved path must stay under the repo root.
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`local prompt path escapes deployment repo root: ${spec.path}`);
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`prompt file not found at ${abs}`);
    }
    if (!stat.isFile()) {
      throw new Error(`prompt file not found at ${abs}`);
    }
    if (stat.size > MAX_PROMPT_BYTES) {
      throw new Error(
        `prompt file at ${abs} is ${stat.size} bytes; exceeds ${MAX_PROMPT_BYTES} byte cap`,
      );
    }
    const body = await fs.readFile(abs, "utf8");
    return {
      body,
      source_kind: "local",
      source_id: `local:${abs}`,
      hash: shortHash(body),
      fallback_used: false,
    };
  }

  if (spec.source === "arthur") {
    if (!spec.name) throw new Error("arthur prompt requires `name`");
    const tag = spec.tag ?? "production";
    const arthurEnabled =
      !!env.GENAI_ENGINE_API_KEY &&
      !!env.GENAI_ENGINE_TRACE_ENDPOINT &&
      !!env.GENAI_ENGINE_PROMPT_TASK_ID;

    if (!arthurEnabled) {
      const fb = getBuiltinReviewPrompt("pr-review");
      if (!fb) throw new Error(`arthur not configured and no builtin fallback for ${spec.name}`);
      logger.warn({ name: spec.name, reason: "arthur_not_configured" }, "review_prompt_fallback");
      return {
        body: fb,
        source_kind: "builtin",
        source_id: `builtin:pr-review`,
        hash: shortHash(fb),
        fallback_used: true,
      };
    }

    const { ArthurClient } = await import("../sandbox/arthur-client.js");
    const client = ArthurClient.fromTraceEndpoint(
      env.GENAI_ENGINE_TRACE_ENDPOINT!,
      env.GENAI_ENGINE_API_KEY!,
    );
    try {
      const body = await client.getPromptByTag(env.GENAI_ENGINE_PROMPT_TASK_ID!, spec.name, tag);
      if (body) {
        return {
          body,
          source_kind: "arthur",
          source_id: `arthur:${spec.name}@${tag}`,
          hash: shortHash(body),
          fallback_used: false,
        };
      }
    } catch (err) {
      logger.warn({ name: spec.name, tag, err: (err as Error).message }, "review_prompt_arthur_failed");
    }
    const fb = getBuiltinReviewPrompt("pr-review");
    if (!fb) throw new Error(`arthur prompt ${spec.name} not found and no builtin fallback`);
    return {
      body: fb,
      source_kind: "builtin",
      source_id: `builtin:pr-review`,
      hash: shortHash(fb),
      fallback_used: true,
    };
  }

  throw new Error(`unknown prompt source: ${(spec as { source?: string }).source}`);
}
loadReviewPrompt.maxRetries = 0;
