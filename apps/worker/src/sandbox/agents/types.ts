import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { z } from "zod";

// Open union: "research" | "impl" | "review" remain the built-in phases, but
// new block executors label phases freely (e.g. "fix", "agent-<blockId>").
// Phase strings that reach shell paths are sanitized in the adapters.
export type PhaseKind = string;

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

/** Minimal interface for sandbox objects that support runCommand and writeFiles. */
export interface RunnableSandbox {
  runCommand: SandboxInstance["runCommand"];
  writeFiles: SandboxInstance["writeFiles"];
}

// --- Schemas (moved from src/sandbox/agent-runner.ts) ---

export const agentOutputSchema = z.object({
  result: z.enum(["implemented", "clarification_needed", "failed"]),
  summary: z.string().nullish(),
  questions: z.array(z.string()).nullish(),
  suggestedAnswers: z.array(z.string()).nullish(),
  error: z.string().nullish(),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

// OpenAI Structured Outputs strict mode (used by Codex --output-schema) requires
// `additionalProperties: false` on every object and every property listed in
// `required`. Optional fields are expressed as `["<type>", "null"]` unions.
export const AGENT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: { type: "string", enum: ["implemented", "clarification_needed", "failed"] },
    summary: { type: ["string", "null"] },
    questions: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
    },
    suggestedAnswers: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
      description:
        "Short ready-to-pick answer options for the questions. Optional.",
    },
    error: { type: ["string", "null"] },
  },
  required: ["result", "summary", "questions", "suggestedAnswers", "error"],
  additionalProperties: false,
});

// Output contract for the generic agent block: a free-form phase that reports a
// status, a body, and optional follow-up questions or an error. Mirrors the
// strict-mode conventions of AGENT_SCHEMA (all keys required; optionals nullable).
export const GENERIC_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "needs_input", "failed"] },
    body: { type: "string" },
    questions: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
    },
    suggestedAnswers: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
      description:
        "Short ready-to-pick answer options for the questions. Optional.",
    },
    error: { type: ["string", "null"] },
  },
  required: ["status", "body", "questions", "suggestedAnswers", "error"],
  additionalProperties: false,
});

export const reviewOutputSchema = z.object({
  result: z.enum(["approved", "failed"]),
  feedback: z.string(),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["critical", "suggestion"]),
  })),
  error: z.string().nullish(),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: { type: "string", enum: ["approved", "failed"] },
    feedback: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["critical", "suggestion"] },
        },
        required: ["file", "description", "severity"],
        additionalProperties: false,
      },
    },
    error: { type: ["string", "null"] },
  },
  required: ["result", "feedback", "issues", "error"],
  additionalProperties: false,
});

export type ResearchStatus = "completed" | "clarification_needed" | "failed";
export interface ResearchResult {
  status: ResearchStatus;
  body: string;
  questions?: string[];
  suggestedAnswers?: string[];
}

export const researchOutputSchema = z.object({
  status: z.enum(["completed", "clarification_needed", "failed"]),
  plan: z.string().nullish(),
  questions: z.array(z.string()).nullish(),
  suggestedAnswers: z.array(z.string()).nullish(),
  error: z.string().nullish(),
});
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

export const RESEARCH_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "clarification_needed", "failed"] },
    plan: { type: ["string", "null"] },
    questions: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
    },
    suggestedAnswers: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "null" },
      ],
      description:
        "Short ready-to-pick answer options for the questions. Optional.",
    },
    error: { type: ["string", "null"] },
  },
  required: ["status", "plan", "questions", "suggestedAnswers", "error"],
  additionalProperties: false,
});

/** Collapse the structured research output to the {status, body} contract used downstream. */
export function foldResearchOutput(o: ResearchOutput): ResearchResult {
  if (o.status === "completed") return { status: "completed", body: (o.plan ?? "").trim() };
  if (o.status === "clarification_needed") {
    const qs = (o.questions ?? []).filter((q) => q.trim().length > 0);
    const suggested = (o.suggestedAnswers ?? []).filter((s) => s.trim().length > 0);
    return {
      status: "clarification_needed",
      body: qs.map((q, i) => `${i + 1}. ${q}`).join("\n"),
      questions: qs,
      ...(suggested.length > 0 ? { suggestedAnswers: suggested } : {}),
    };
  }
  return { status: "failed", body: (o.error ?? "").trim() };
}

// --- Usage (replaces shape in src/sandbox/usage.ts) ---

export interface PhaseUsage {
  /** Populated by Claude (CLI computes dollars itself). null for Codex (computed downstream from tokens). */
  cost_usd: number | null;
  /** Populated by Codex from turn.completed. null for Claude. */
  tokens: { input: number; cached_input: number; output: number } | null;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
}

// --- Adapter contract ---

export interface ArthurConfig {
  apiKey: string;
  taskId: string;
  endpoint: string;
}

export interface ConfigureOpts {
  anthropicApiKey?: string;
  codexApiKey?: string;
  codexChatGptOauthToken?: string;
  model: string;
  arthur?: ArthurConfig;
}

export interface PhaseArtifactPaths {
  wrapper: string;
  input: string;
  stdout: string;
  stderr: string;
  sentinel: string;
  /** Schema-validated JSON file (Codex --output-schema). null for Claude. */
  structuredOutput: string | null;
}

export interface PhaseScriptOpts {
  phase: PhaseKind;
  model: string;
  paths: PhaseArtifactPaths;
  /** When set, the phase requests schema-validated structured output. */
  jsonSchema?: string;
}

export interface AgentAdapter {
  kind: "claude" | "codex";
  install(sandbox: RunnableSandbox): Promise<void>;
  configure(sandbox: RunnableSandbox, opts: ConfigureOpts): Promise<void>;
  setCommitGuard(sandbox: RunnableSandbox, enabled: boolean): Promise<void>;
  buildPhaseScript(opts: PhaseScriptOpts): string;
  artifactPaths(phase: PhaseKind): PhaseArtifactPaths;
  parseAgentOutput(raw: string, structured: string | null): AgentOutput;
  parseReviewOutput(raw: string, structured: string | null): ReviewOutput;
  parseResearchStatus(raw: string, structured: string | null): ResearchResult;
  extractUsage(raw: string, structured: string | null): PhaseUsage | null;
}
