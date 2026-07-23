import type { AgentKind } from "../../sandbox/agents/index.js";
import type { AgentProtocolResult } from "../../sandbox/agents/types.js";
import { isRunControlError } from "../run-control-error.js";
import type { EngineCtx } from "./types.js";
import { ensureArthurTask } from "./prepare-workspace.js";
import type {
  ResolvedHarnessRuntime,
  ResolvedRuntimeCredentials,
} from "../../sandbox/harness-runtime.js";

async function blockProvisionAgentSandboxStep(
  subjectKey: string,
  ownerToken: string,
  agentKind: AgentKind,
  model: string,
  arthurTaskId: string | null,
  runtime?: ResolvedHarnessRuntime,
): Promise<
  | { ok: true; sandboxId: string }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { env } = await import("../../../env.js");
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  const adapter = createAgentAdapter(agentKind, runtime?.cliSpec);
  if (agentKind === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
    const { runtimePreparationError } = await import("../../sandbox/agents/protocol.js");
    const error = runtimePreparationError(
      adapter.cliSpec,
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
      adapter.cliSpec,
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
    if (runtime) {
      // No profile bytes are trusted across invocations. The exact CLI, home,
      // skills, and credentials are prepared together immediately before use.
      return { ok: true, sandboxId: sandbox.sandboxId };
    }
    const runtimeCredentials: ResolvedRuntimeCredentials = {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      codexApiKey: env.CODEX_API_KEY,
      codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    };
    await adapter.install(sandbox);
    await adapter.configure(sandbox, {
      ...runtimeCredentials,
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
 * Rebuild and configure exactly one immutable profile immediately before an
 * agent process starts. The reset removes sibling profile homes and any
 * credentials left by an interrupted prior invocation.
 */
export async function prepareHarnessAgentInvocationStep(
  sandboxId: string,
  agentKind: AgentKind,
  model: string,
  arthurTaskId: string | null,
  runtime?: ResolvedHarnessRuntime,
): Promise<AgentProtocolResult<void>> {
  "use step";
  if (!runtime) return { ok: true, value: undefined };

  const { env } = await import("../../../env.js");
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const {
    materializePinnedHarnessFiles,
    resetHarnessRuntimeHomes,
    resolveRuntimeCredentials,
  } = await import("../../sandbox/harness-runtime.js");
  const { getDb } = await import("../../db/client.js");
  const { dashboardOrganizationId } = await import(
    "../../workflow-definition/harness-profile-runtime.js"
  );
  const { resolveHarnessProfileVersion } = await import(
    "../../harness-profiles/store.js"
  );
  const { isAgentRuntimeError } = await import(
    "../../sandbox/agents/protocol.js"
  );

  const adapter = createAgentAdapter(agentKind, runtime.cliSpec);
  try {
    const sandbox = await Sandbox.get({
      sandboxId,
      ...getSandboxCredentials(),
    });
    await resetHarnessRuntimeHomes(sandbox);
    const organizationId = await dashboardOrganizationId(
      getDb(),
      env.DASHBOARD_ORG_SLUG,
    );
    const resolved = await resolveHarnessProfileVersion(getDb(), {
      organizationId,
      profileId: runtime.manifest.profileId,
      version: runtime.manifest.version,
    });
    if (!resolved || resolved.manifestHash !== runtime.manifestHash) {
      throw new Error(
        "The pinned Harness Profile changed or became unavailable before invocation.",
      );
    }
    await materializePinnedHarnessFiles(
      sandbox,
      runtime,
      resolved.skillArtifacts,
    );
    await adapter.install(sandbox, runtime.paths);
    const credentials = resolveRuntimeCredentials(runtime.manifest, {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      codexApiKey: env.CODEX_API_KEY,
      codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    });
    const arthur =
      env.GENAI_ENGINE_API_KEY &&
      env.GENAI_ENGINE_TRACE_ENDPOINT &&
      arthurTaskId
        ? {
            apiKey: env.GENAI_ENGINE_API_KEY,
            taskId: arthurTaskId,
            endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
          }
        : undefined;
    await adapter.configure(sandbox, {
      ...credentials,
      model,
      arthur,
      runtime: runtime.paths,
      legacyDynamicSkills: false,
    });
    return { ok: true, value: undefined };
  } catch (error) {
    if (!isAgentRuntimeError(error)) throw error;
    return {
      ok: false,
      category: error.category,
      message: error.safeMessage,
      diagnostic: error.diagnostic,
    };
  }
}
prepareHarnessAgentInvocationStep.maxRetries = 0;

/**
 * Ensure an agent CLI has a repository-free scratch sandbox. These sandboxes
 * are intentionally separate from ctx.sandboxId, which always means an
 * attached code workspace.
 */
export async function ensureAgentSandbox(
  ctx: EngineCtx,
  agentKind: AgentKind,
  model: string,
  options: {
    reuse?: boolean;
    runtime?: ResolvedHarnessRuntime;
  } = {},
): Promise<string> {
  const runtime = options.runtime;
  const reuse =
    options.reuse ??
    (runtime ? runtime.manifest.workspace.preserveAcrossBlocks : true);
  const cacheKey = runtime?.manifestHash ?? `legacy:${agentKind}`;
  if (reuse) {
    const existing = ctx.agentSandboxIds[cacheKey];
    if (existing) return existing;
  }

  const arthurTaskId = await ensureArthurTask(ctx);
  const provisioned = await blockProvisionAgentSandboxStep(
    ctx.entry.subjectKey,
    ctx.entry.ownerToken,
    agentKind,
    model,
    arthurTaskId,
    runtime,
  );
  if (!provisioned.ok) {
    const { AgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    throw new AgentRuntimeError(provisioned.failure);
  }
  const { sandboxId } = provisioned;
  if (reuse) ctx.agentSandboxIds[cacheKey] = sandboxId;
  // The in-workflow set covers normal teardown; the durable owner-child row
  // registered immediately after create covers cancel/reconcile crash cleanup.
  ctx.sandboxIds.add(sandboxId);
  return sandboxId;
}
