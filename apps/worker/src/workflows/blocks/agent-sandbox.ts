import type { AgentKind } from "../../sandbox/agents/index.js";
import type { AgentProtocolResult } from "../../sandbox/agents/types.js";
import { isRunControlError } from "../run-control-error.js";
import type { EngineCtx } from "./types.js";
import { ensureArthurTask } from "./prepare-workspace.js";

async function blockProvisionAgentSandboxStep(
  subjectKey: string,
  ownerToken: string,
  agentKind: AgentKind,
  model: string,
  arthurTaskId: string | null,
): Promise<
  | { ok: true; sandboxId: string }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { env } = await import("../../../env.js");
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  if (agentKind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
    const { runtimePreparationError } = await import("../../sandbox/agents/protocol.js");
    const error = runtimePreparationError(
      createAgentAdapter(agentKind).cliSpec,
      "Codex authentication credentials are missing from the deployed environment.",
    );
    return {
      ok: false,
      failure: {
        ok: false,
        category: error.category,
        message: error.safeMessage,
        diagnostic: error.diagnostic,
      },
    };
  }
  if (agentKind === "claude" && !env.ANTHROPIC_API_KEY) {
    const { runtimePreparationError } = await import("../../sandbox/agents/protocol.js");
    const error = runtimePreparationError(
      createAgentAdapter(agentKind).cliSpec,
      "Claude authentication credentials are missing from the deployed environment.",
    );
    return {
      ok: false,
      failure: {
        ok: false,
        category: error.category,
        message: error.safeMessage,
        diagnostic: error.diagnostic,
      },
    };
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
    const { createStepAdapters } = await import("../../lib/step-adapters.js");
    await createStepAdapters().runRegistry.registerSandbox(
      subjectKey,
      ownerToken,
      sandbox.sandboxId,
    );
    const adapter = createAgentAdapter(agentKind);
    await adapter.install(sandbox);
    await adapter.configure(sandbox, {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      codexApiKey: env.CODEX_API_KEY,
      codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
      model,
      arthur,
    });
    return { ok: true, sandboxId: sandbox.sandboxId };
  } catch (error) {
    const { isAgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    const agentRuntimeError = isAgentRuntimeError(error);
    const { stopSandboxAndConfirm } = await import(
      "../../sandbox/stop-ticket-sandboxes.js"
    );
    try {
      await stopSandboxAndConfirm(sandbox);
    } catch (cleanupError) {
      if (!isRunControlError(error) && !agentRuntimeError) throw cleanupError;
    }
    if (agentRuntimeError) {
      return {
        ok: false,
        failure: {
          ok: false,
          category: error.category,
          message: error.safeMessage,
          diagnostic: error.diagnostic,
        },
      };
    }
    throw error;
  }
}
blockProvisionAgentSandboxStep.maxRetries = 0;

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
  const provisioned = await blockProvisionAgentSandboxStep(
    ctx.entry.subjectKey,
    ctx.entry.ownerToken,
    agentKind,
    model,
    arthurTaskId,
  );
  if (!provisioned.ok) {
    const { AgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    throw new AgentRuntimeError(provisioned.failure);
  }
  const { sandboxId } = provisioned;
  ctx.agentSandboxIds[agentKind] = sandboxId;
  // The in-workflow set covers normal teardown; the durable owner-child row
  // registered immediately after create covers cancel/reconcile crash cleanup.
  ctx.sandboxIds.add(sandboxId);
  return sandboxId;
}
