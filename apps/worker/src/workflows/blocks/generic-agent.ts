import { z } from "zod";
import type { JsonValue } from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type {
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  PhaseArtifactPaths,
  PhaseUsage,
} from "../../sandbox/agents/types.js";
import {
  validateBlockOutputForDefinition,
  workflowBlockDefinitionIssue,
} from "../../workflow-definition/block-registry.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { ensureAgentSandbox } from "./agent-sandbox.js";
import { isRunControlError } from "../run-control-error.js";
import { pollPhaseUntilDone } from "./poll-phase.js";
import {
  agentProtocolExecutionError,
  executionError,
  sanitizeBlockId,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";

export const paramsSchema = z
  .object({
    provider: z.enum(["claude", "codex"]).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    prompt: z.string().optional(),
    outputSchema: z.string().optional(),
    workspaceMode: z.enum(["none", "read_write"]).default("none"),
  })
  .strict();

const MAX_MINUTES = 25;

const genericOutputSchema = z.object({
  status: z.enum(["ok", "needs_input", "failed"]),
  body: z.string(),
  questions: z.array(z.string()).nullish(),
  suggestedAnswers: z.array(z.string()).nullish(),
  error: z.string().nullish(),
});

async function blockGenericAgentCommitGuardStep(
  sandboxId: string,
  agentKind: AgentKind,
  enabled: boolean,
): Promise<AgentProtocolResult<void>> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind);
  try {
    await agent.setCommitGuard(sandbox, enabled);
    return { ok: true, value: undefined };
  } catch (error) {
    const { isAgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    if (!isAgentRuntimeError(error)) throw error;
    return {
      ok: false,
      category: error.category,
      message: error.safeMessage,
      diagnostic: error.diagnostic,
    };
  }
}

async function blockGenericAgentPlanPhaseStep(
  agentKind: AgentKind,
  phase: string,
  model: string,
  jsonSchema: string,
): Promise<{ paths: PhaseArtifactPaths; script: string }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  const paths = adapter.artifactPaths(phase);
  const script = adapter.buildPhaseScript({ phase, model, paths, jsonSchema });
  return { paths, script };
}

async function blockGenericAgentStartPhaseStep(
  sandboxId: string,
  agentKind: AgentKind,
  phase: string,
  inputFilePath: string,
  inputContent: string,
  scriptPath: string,
  scriptContent: string,
): Promise<
  | { ok: true; commandId: string }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { commandProtocolFailure, protocolFailure } = await import(
    "../../sandbox/agents/protocol.js"
  );
  const spec = createAgentAdapter(agentKind).cliSpec;
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");

    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
    await sandbox.writeFiles([
      { path: inputFilePath, content: Buffer.from(inputContent) },
      { path: scriptPath, content: Buffer.from(scriptContent) },
    ]);
    const chmod = await sandbox.runCommand("chmod", ["+x", scriptPath]);
    if (chmod.exitCode !== 0) {
      return {
        ok: false,
        failure: await commandProtocolFailure({
          spec,
          phase,
          result: chmod,
          failureKind: "setup_failed",
          message: "The current agent phase could not be completed.",
          detail: "The agent phase wrapper could not be made executable.",
        }),
      };
    }
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: [scriptPath],
      cwd: "/vercel/sandbox",
      detached: true,
    });
    if (command.exitCode !== null && command.exitCode !== 0) {
      return {
        ok: false,
        failure: await commandProtocolFailure({
          spec,
          phase,
          result: command,
          failureKind: "cli_exit",
          message: "The current agent phase could not be completed.",
          detail: "The agent phase process could not be launched.",
        }),
      };
    }
    return { ok: true, commandId: command.cmdId };
  } catch (error) {
    const { isRunControlError } = await import("../run-control-error.js");
    if (isRunControlError(error)) throw error;
    const failure = protocolFailure({
      spec,
      phase,
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: null },
      failureKind: "provider_error",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: "The agent phase process could not be launched.",
    });
    if (failure.ok) throw new Error("unreachable");
    return { ok: false, failure };
  }
}
blockGenericAgentStartPhaseStep.maxRetries = 0;

async function blockGenericAgentParseStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: string,
  customSchema: string | undefined,
): Promise<{ result: AgentProtocolResult<unknown>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { GENERIC_SCHEMA } = await import("../../sandbox/agents/types.js");
  const { validateStructuredValue } = await import("../../sandbox/agents/protocol.js");
  const adapter = createAgentAdapter(agentKind);
  const extracted = adapter.parseStructuredObjectProtocol(
    artifacts,
    phase,
    customSchema === undefined ? "generic-agent" : "generic-agent-custom",
    customSchema ?? GENERIC_SCHEMA,
  );
  const result = customSchema === undefined && extracted.ok
    ? validateStructuredValue({
        spec: adapter.cliSpec,
        phase,
        artifacts,
        value: extracted.value,
        schema: genericOutputSchema,
        schemaIdentity: "generic-agent",
        schemaSource: GENERIC_SCHEMA,
      })
    : extracted;
  return {
    result,
    usage: adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function blockGenericAgentSchemaFailureStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: string,
  schema: string,
  issues: string[],
): Promise<Extract<AgentProtocolResult<unknown>, { ok: false }>> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { protocolFailure } = await import("../../sandbox/agents/protocol.js");
  const failure = protocolFailure({
    spec: createAgentAdapter(agentKind).cliSpec,
    phase,
    artifacts,
    failureKind: "schema_mismatch",
    category: "schema",
    message: "The current agent phase returned an invalid structured response.",
    schema: {
      identity: "generic-agent-custom",
      source: schema,
      issues: issues.map((message) => ({ path: [], code: "custom", message })),
    },
    detail: "The structured response did not satisfy the requested schema.",
  });
  if (failure.ok) throw new Error("unreachable");
  return failure;
}

/**
 * generic_agent: run a free-form agent phase on the attached workspace. The
 * prompt param is written verbatim as the phase input file. Without an
 * outputSchema param the phase uses GENERIC_SCHEMA and its status maps to
 * next / needs_human_input / execution_error; with a custom schema the parsed object is
 * returned at the top level with the reserved runtime status plus a compatibility
 * `data` alias. The outputSchema string is validated before anything reaches
 * the agent CLI.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
  execution,
): Promise<BlockExecutionResult> => {
  const customSchema =
    typeof block.params.outputSchema === "string" && block.params.outputSchema.trim().length > 0
      ? block.params.outputSchema
      : undefined;
  if (customSchema !== undefined) {
    try {
      JSON.parse(customSchema);
    } catch {
      return executionError("invalid outputSchema", { category: "schema" });
    }
    const definitionIssue = workflowBlockDefinitionIssue(block.type, block.params);
    if (definitionIssue) {
      return executionError(`invalid outputSchema: ${definitionIssue}`, {
        category: "schema",
      });
    }
  }

  const { kind, model } = resolveBlockAgent(block.params, ctx.runDefaultKind, ctx.defaults);
  // Missing workspaceMode is a deployed PR #118 definition and deliberately
  // retains its old code-workspace behavior. New blocks receive `none` from
  // the registry/schema defaults.
  const workspaceMode = block.params.workspaceMode === "none" ? "none" : "read_write";
  let sandboxId: string | null;
  try {
    sandboxId =
      workspaceMode === "none"
        ? ctx.agentSandboxIds[kind] ?? (await ensureAgentSandbox(ctx, kind, model))
        : ctx.sandboxId;
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { isAgentRuntimeError } = await import("../../sandbox/agents/runtime-error.js");
    if (isAgentRuntimeError(err)) {
      return agentProtocolExecutionError({
        ok: false,
        category: err.category,
        message: err.safeMessage,
        diagnostic: err.diagnostic,
      });
    }
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "sandbox",
    });
  }
  if (!sandboxId) {
    return executionError(
        workspaceMode === "read_write"
          ? "no workspace: connect prepare_workspace before generic_agent"
          : "could not provision an agent-only sandbox for generic_agent",
      { category: "sandbox" },
    );
  }
  const basePrompt =
    typeof resolvedInputs.prompt === "string"
      ? resolvedInputs.prompt
      : typeof block.params.prompt === "string"
        ? block.params.prompt
        : "";
  const prompt = execution?.clarificationAnswer
    ? `${basePrompt}\n\nHuman clarification answer:\n${execution.clarificationAnswer}`
    : basePrompt;
  if (prompt.length === 0) {
    return executionError("generic_agent requires a prompt", {
      category: "binding",
    });
  }

  // Artifact phase must be shell/file-safe (drives /tmp paths); telemetry label
  // must stay unique per block. Two block ids that sanitize to the same token
  // would collide and lose usage attribution, so keep the raw id for telemetry.
  const phase = `agent-${sanitizeBlockId(block.id)}`;
  const usageLabel = `Agent ${block.id}`;

  try {
    const { GENERIC_SCHEMA } = await import("../../sandbox/agents/types.js");
    const jsonSchema = customSchema ?? GENERIC_SCHEMA;

    // Install this provider's commit guard explicitly. Without it the phase
    // inherits whatever the previous agent block left (planning_agent disables
    // it), so the same graph would commit or not depending on block order. Only
    // committed work is pushed, so an unguarded agent's changes are dropped
    // silently; the guard is a no-op when the agent leaves a clean tree.
    const guard = await blockGenericAgentCommitGuardStep(
      sandboxId,
      kind,
      workspaceMode === "read_write",
    );
    if (!guard.ok) return agentProtocolExecutionError(guard);
    const { paths, script } = await blockGenericAgentPlanPhaseStep(kind, phase, model, jsonSchema);
    const launch = await blockGenericAgentStartPhaseStep(
      sandboxId,
      kind,
      phase,
      paths.input,
      prompt,
      paths.wrapper,
      script,
    );
    if (!launch.ok) return agentProtocolExecutionError(launch.failure);
    const commandId = launch.commandId;
    ctx.markLaunched(usageLabel);

    const done = await pollPhaseUntilDone(
      sandboxId,
      paths.sentinel,
      MAX_MINUTES,
      commandId,
      ctx.observeBudget,
    );
    if (!done) {
      return executionError("agent phase timed out", { category: "timeout" });
    }

    const { collectPhase } = await import("../../sandbox/poll-agent.js");
    const artifacts = await collectPhase(sandboxId, paths);
    const { result, usage } = await blockGenericAgentParseStep(
      kind,
      artifacts,
      phase,
      customSchema,
    );
    ctx.recordUsage(usageLabel, usage, model);
    if (!result.ok) return agentProtocolExecutionError(result);
    const object = result.value;

    if (customSchema !== undefined) {
      if (object === undefined) {
        return executionError("agent output did not match the requested schema", {
          category: "schema",
        });
      }
      if (object === null || typeof object !== "object" || Array.isArray(object)) {
        return executionError("agent output did not match the requested schema", {
          category: "schema",
        });
      }
      const data = object as Record<string, JsonValue>;
      const output = { ...data, status: "completed", data } as const;
      const issues = validateBlockOutputForDefinition(block.type, block.params, output, {
        requireNormalOutput: true,
      });
      if (issues.length > 0) {
        const failure = await blockGenericAgentSchemaFailureStep(
          kind,
          artifacts,
          phase,
          customSchema,
          issues,
        );
        return agentProtocolExecutionError(failure);
      }
      return { kind: "next", output };
    }

    const parsed = genericOutputSchema.parse(object);
    if (parsed.status === "needs_input") {
      const listed = (parsed.questions ?? []).filter((q) => q.trim().length > 0);
      const questions = listed.length > 0 ? listed : [parsed.body];
      const suggestedAnswers = (parsed.suggestedAnswers ?? []).filter(
        (s) => s.trim().length > 0,
      );
      return {
        kind: "needs_human_input",
        output: {
          status: "needs_human_input",
          questions,
          ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
        },
        questions,
        ...(suggestedAnswers.length > 0 ? { suggestedAnswers } : {}),
      };
    }
    if (parsed.status === "failed") {
      return executionError(
        parsed.error ?? parsed.body.slice(0, 500),
        { category: "provider" },
      );
    }
    return {
      kind: "next",
      output: {
        status: "completed",
        body: parsed.body.slice(0, 4000),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
    });
  }
};
