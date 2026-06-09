export interface LoadedPrompts {
  research: string;
  implement: string;
  review: string;
}

export async function loadPrompts(): Promise<LoadedPrompts> {
  "use step";
  // Delegate to the shared resolver so the durable step and the
  // GET /api/v1/prompts route share one source of truth. The resolver carries
  // the same logger.info/logger.warn (fallback / arthur / per-prompt error)
  // calls the step used to make. Version history is dashboard-only, so skip the
  // listPromptVersions fan-out here — the step only consumes prompt bodies.
  const { resolvePrompts } = await import("../lib/overview/collect-prompts.js");
  const { prompts } = await resolvePrompts({ withVersions: false });
  const byName = Object.fromEntries(prompts.map((p) => [p.name, p.body]));
  return {
    research: byName["research-plan"],
    implement: byName["implement"],
    review: byName["review"],
  };
}
loadPrompts.maxRetries = 0;
