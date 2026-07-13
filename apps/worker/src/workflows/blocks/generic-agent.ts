import { z } from "zod";
import type { JsonValue } from "@shared/contracts";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { PhaseArtifactPaths, PhaseUsage } from "../../sandbox/agents/types.js";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { sanitizeBlockId, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    provider: z.enum(["claude", "codex"]).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    prompt: z.string().min(1),
    outputSchema: z.string().optional(),
  })
  .strict();

const MAX_MINUTES = 25;

const genericOutputSchema = z.object({
  status: z.enum(["ok", "needs_input", "failed"]),
  body: z.string(),
  questions: z.array(z.string()).nullish(),
  error: z.string().nullish(),
});

function extractStructuredObject(raw: string, structured: string | null): unknown {
  if (structured) {
    try {
      return JSON.parse(structured);
    } catch {
      return undefined;
    }
  }
  const candidates = [raw, ...raw.split("\n").filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "result") {
        const envelope = parsed as { structured_output?: unknown; result?: unknown };
        if (envelope.structured_output != null) return envelope.structured_output;
        if (typeof envelope.result === "string") {
          try {
            return JSON.parse(envelope.result);
          } catch {
            return undefined;
          }
        }
        continue;
      }
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
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
  inputFilePath: string,
  inputContent: string,
  scriptPath: string,
  scriptContent: string,
): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  await sandbox.writeFiles([
    { path: inputFilePath, content: Buffer.from(inputContent) },
    { path: scriptPath, content: Buffer.from(scriptContent) },
  ]);
  await sandbox.runCommand("chmod", ["+x", scriptPath]);
  await sandbox.runCommand({
    cmd: "bash",
    args: [scriptPath],
    cwd: "/vercel/sandbox",
    detached: true,
  });
}
blockGenericAgentStartPhaseStep.maxRetries = 0;

async function blockGenericAgentParseStep(
  agentKind: AgentKind,
  raw: string,
  structured: string | null,
): Promise<{ object: unknown; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  return {
    object: extractStructuredObject(raw, structured),
    usage: adapter.extractUsage(raw, structured),
  };
}

async function pollPhaseUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxMinutes: number,
): Promise<boolean> {
  const { sleep } = await import("workflow");
  const { checkPhaseDone } = await import("../../sandbox/poll-agent.js");
  const maxPolls = Math.ceil((maxMinutes * 60) / 30);
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep("30s");
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) return true;
    if (status === "stopped") return false;
  }
  return false;
}

/**
 * generic_agent: run a free-form agent phase on the attached workspace. The
 * prompt param is written verbatim as the phase input file. Without an
 * outputSchema param the phase uses GENERIC_SCHEMA and its status maps to
 * next / needs_human_input / failed; with a custom schema the parsed object is
 * wrapped as { status: "ok", data }. The outputSchema string is validated with
 * JSON.parse before anything reaches the agent CLI.
 */
export const execute: BlockExecuteFn = async (block, _steps, ctx): Promise<BlockExecutionResult> => {
  const customSchema =
    typeof block.params.outputSchema === "string" && block.params.outputSchema.trim().length > 0
      ? block.params.outputSchema
      : undefined;
  if (customSchema !== undefined) {
    try {
      JSON.parse(customSchema);
    } catch {
      return { kind: "failed", output: { status: "failed" }, reason: "invalid outputSchema" };
    }
  }

  if (!ctx.sandboxId) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "no workspace: connect prepare_workspace before generic_agent",
    };
  }
  const sandboxId = ctx.sandboxId;
  const prompt = typeof block.params.prompt === "string" ? block.params.prompt : "";
  if (prompt.length === 0) {
    return { kind: "failed", output: { status: "failed" }, reason: "generic_agent requires a prompt" };
  }

  const { kind, model } = resolveBlockAgent(block.params, ctx.runDefaultKind, ctx.defaults);
  // Artifact phase must be shell/file-safe (drives /tmp paths); telemetry label
  // must stay unique per block. Two block ids that sanitize to the same token
  // would collide and lose usage attribution, so keep the raw id for telemetry.
  const phase = `agent-${sanitizeBlockId(block.id)}`;
  const usageLabel = `Agent ${block.id}`;

  try {
    const { GENERIC_SCHEMA } = await import("../../sandbox/agents/types.js");
    const jsonSchema = customSchema ?? GENERIC_SCHEMA;

    const { paths, script } = await blockGenericAgentPlanPhaseStep(kind, phase, model, jsonSchema);
    await blockGenericAgentStartPhaseStep(sandboxId, paths.input, prompt, paths.wrapper, script);
    ctx.markLaunched(usageLabel);

    const done = await pollPhaseUntilDone(sandboxId, paths.sentinel, MAX_MINUTES);
    if (!done) {
      return { kind: "failed", output: { status: "failed" }, reason: "agent phase timed out" };
    }

    const { collectPhase } = await import("../../sandbox/poll-agent.js");
    const { raw, structured } = await collectPhase(sandboxId, paths);
    const { object, usage } = await blockGenericAgentParseStep(kind, raw, structured);
    ctx.recordUsage(usageLabel, usage, model);

    if (customSchema !== undefined) {
      if (object === undefined || object === null) {
        return {
          kind: "failed",
          output: { status: "failed" },
          reason: "agent output did not match the requested schema",
        };
      }
      return { kind: "next", output: { status: "ok", data: object as JsonValue } };
    }

    const parsed = genericOutputSchema.safeParse(object);
    if (!parsed.success) {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: "agent output was not structured JSON",
      };
    }
    if (parsed.data.status === "needs_input") {
      const listed = (parsed.data.questions ?? []).filter((q) => q.trim().length > 0);
      const questions = listed.length > 0 ? listed : [parsed.data.body];
      return {
        kind: "needs_human_input",
        output: { status: "needs_human_input", questions },
        questions,
      };
    }
    if (parsed.data.status === "failed") {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: parsed.data.error ?? parsed.data.body.slice(0, 500),
      };
    }
    return {
      kind: "next",
      output: {
        status: "ok",
        ...(parsed.data.body ? { body: parsed.data.body.slice(0, 4000) } : {}),
      },
    };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
