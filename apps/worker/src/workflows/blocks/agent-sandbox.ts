import type { AgentKind } from "../../sandbox/agents/index.js";
import type { EngineCtx } from "./types.js";
import { ensureArthurTask } from "./prepare-workspace.js";

async function blockProvisionAgentSandboxStep(
  agentKind: AgentKind,
  model: string,
  arthurTaskId: string | null,
): Promise<{ sandboxId: string }> {
  "use step";
  const { env } = await import("../../../env.js");
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  if (agentKind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
    throw new Error(
      "agent codex needs CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN in the deployed environment",
    );
  }
  if (agentKind === "claude" && !env.ANTHROPIC_API_KEY) {
    throw new Error("agent claude needs ANTHROPIC_API_KEY in the deployed environment");
  }

  const arthur =
    env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && arthurTaskId
      ? {
          apiKey: env.GENAI_ENGINE_API_KEY,
          taskId: arthurTaskId,
          endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
        }
      : undefined;
  const sandbox = await Sandbox.create({
    ...getSandboxCredentials(),
    runtime: "node24",
    timeout: env.JOB_TIMEOUT_MS,
  });

  try {
    const adapter = createAgentAdapter(agentKind);
    await adapter.install(sandbox);
    await adapter.configure(sandbox, {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      codexApiKey: env.CODEX_API_KEY,
      codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
      model,
      arthur,
    });
    return { sandboxId: sandbox.sandboxId };
  } catch (error) {
    await sandbox.stop().catch(() => {});
    throw error;
  }
}
blockProvisionAgentSandboxStep.maxRetries = 0;

async function blockRegisterAgentSandboxStep(
  ticketIdentifier: string,
  sandboxId: string,
): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.registerSandbox(ticketIdentifier, sandboxId);
}

/**
 * Ensure an agent CLI has a repository-free scratch sandbox. These sandboxes
 * are intentionally separate from ctx.sandboxId, which always means an
 * attached code workspace.
 */
export async function ensureAgentSandbox(
  ctx: EngineCtx,
  agentKind: AgentKind,
  model: string,
): Promise<string> {
  const existing = ctx.agentSandboxIds[agentKind];
  if (existing) return existing;

  const arthurTaskId = await ensureArthurTask(ctx);
  const { sandboxId } = await blockProvisionAgentSandboxStep(
    agentKind,
    model,
    arthurTaskId,
  );
  ctx.agentSandboxIds[agentKind] = sandboxId;
  // ctx.sandboxIds is the authoritative terminal-cleanup set. The run
  // registry has one sandbox slot, so scratch may occupy it only until a code
  // workspace exists; it must never replace that primary cancellation target.
  ctx.sandboxIds.add(sandboxId);
  if (!ctx.sandboxId) {
    await blockRegisterAgentSandboxStep(ctx.ticket.identifier, sandboxId);
  }
  return sandboxId;
}
