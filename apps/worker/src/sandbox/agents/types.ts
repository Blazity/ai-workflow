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

/** Structural cap so one review cannot flood a pull request with findings. */
const MAX_REVIEW_FINDINGS = 10;

const reviewIssueSchema = z.object({
  file: z.string(),
  description: z.string(),
  severity: z.enum(["Blocker", "High", "Medium", "Nit"]),
  startLine: z.number().int().nullish(),
  endLine: z.number().int().nullish(),
  repo: z.string().nullish(),
});

// Truncate before validating the cap so a provider that ignores `maxItems`
// loses the overflow instead of failing the whole review. The assertion keeps
// the declared input type equal to the output type, which the shared protocol
// validator requires of every phase schema.
const reviewIssuesSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.slice(0, MAX_REVIEW_FINDINGS) : value),
  z.array(reviewIssueSchema).max(MAX_REVIEW_FINDINGS),
) as unknown as z.ZodType<z.infer<typeof reviewIssueSchema>[]>;

export const reviewOutputSchema = z.object({
  result: z.enum(["approved", "failed"]),
  feedback: z.string(),
  issues: reviewIssuesSchema,
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
      maxItems: MAX_REVIEW_FINDINGS,
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          severity: {
            type: "string",
            enum: ["Blocker", "High", "Medium", "Nit"],
          },
          startLine: { type: ["integer", "null"] },
          endLine: { type: ["integer", "null"] },
          repo: { type: ["string", "null"] },
        },
        required: [
          "file",
          "description",
          "severity",
          "startLine",
          "endLine",
        ],
        additionalProperties: false,
      },
    },
    error: { type: ["string", "null"] },
  },
  required: ["result", "feedback", "issues", "error"],
  additionalProperties: false,
});

export type ResearchStatus =
  | "completed"
  | "repositories_needed"
  | "clarification_needed"
  | "failed";
export interface ResearchRepository {
  provider: "github" | "gitlab";
  repoPath: string;
  rationale: string;
}
export interface ResearchResult {
  status: ResearchStatus;
  body: string;
  questions?: string[];
  suggestedAnswers?: string[];
  repositories?: ResearchRepository[];
  writeRepositories?: ResearchRepository[];
  repositoryEvidence?: string[];
  /** Evidence that the ticket is already resolved (commit SHAs, PR references, quoted
   * ticket comments), distinct from repositoryEvidence which justifies write-repo selection. */
  noChangeNeeded?: boolean;
  resolutionEvidence?: string[];
}

const researchRepositorySchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  repoPath: z.string().min(1),
  rationale: z.string().min(1),
}).strict();
export const researchOutputSchema = z.object({
  status: z.enum([
    "completed",
    "repositories_needed",
    "clarification_needed",
    "failed",
  ]),
  plan: z.string().nullish(),
  questions: z.array(z.string()).nullish(),
  suggestedAnswers: z.array(z.string()).nullish(),
  repositories: z.array(researchRepositorySchema).max(3).nullish(),
  writeRepositories: z.array(researchRepositorySchema).max(8).nullish(),
  repositoryEvidence: z.array(z.string()).max(50).nullish(),
  noChangeNeeded: z.boolean().nullish(),
  resolutionEvidence: z.array(z.string()).max(50).nullish(),
  error: z.string().nullish(),
}).strict();
export type ResearchOutput = z.infer<typeof researchOutputSchema>;

export const RESEARCH_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [
        "completed",
        "repositories_needed",
        "clarification_needed",
        "failed",
      ],
    },
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
    repositories: {
      anyOf: [
        {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["github", "gitlab"] },
              repoPath: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["provider", "repoPath", "rationale"],
            additionalProperties: false,
          },
        },
        { type: "null" },
      ],
    },
    writeRepositories: {
      anyOf: [
        {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["github", "gitlab"] },
              repoPath: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["provider", "repoPath", "rationale"],
            additionalProperties: false,
          },
        },
        { type: "null" },
      ],
    },
    repositoryEvidence: {
      anyOf: [
        { type: "array", maxItems: 50, items: { type: "string" } },
        { type: "null" },
      ],
    },
    noChangeNeeded: { type: ["boolean", "null"] },
    resolutionEvidence: {
      anyOf: [
        { type: "array", maxItems: 50, items: { type: "string" } },
        { type: "null" },
      ],
      description:
        "Evidence that the ticket is already resolved (commit SHAs, PR references, quoted ticket comments), distinct from repositoryEvidence. Optional.",
    },
    error: { type: ["string", "null"] },
  },
  required: [
    "status",
    "plan",
    "questions",
    "suggestedAnswers",
    "repositories",
    "writeRepositories",
    "repositoryEvidence",
    "noChangeNeeded",
    "resolutionEvidence",
    "error",
  ],
  additionalProperties: false,
});

/** Collapse the structured research output to the {status, body} contract used downstream. */
export function foldResearchOutput(o: ResearchOutput): ResearchResult {
  if (o.status === "completed") {
    return {
      status: "completed",
      body: (o.plan ?? "").trim(),
      ...((o.writeRepositories ?? []).length > 0
        ? { writeRepositories: o.writeRepositories ?? [] }
        : {}),
      ...((o.repositoryEvidence ?? []).length > 0
        ? { repositoryEvidence: o.repositoryEvidence ?? [] }
        : {}),
      ...(o.noChangeNeeded ? { noChangeNeeded: o.noChangeNeeded } : {}),
      ...((o.resolutionEvidence ?? []).length > 0
        ? { resolutionEvidence: o.resolutionEvidence ?? [] }
        : {}),
    };
  }
  if (o.status === "repositories_needed") {
    return {
      status: "repositories_needed",
      body: (o.plan ?? "").trim(),
      repositories: o.repositories ?? [],
    };
  }
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
  /**
   * PR5 v2 profiles use an immutable, manifest-hash-addressed runtime. V1
   * omits this and retains its historical shared-home compatibility behavior.
   */
  runtime?: AgentRuntimePaths;
  modelSettings?: AgentModelRuntimeSettings;
  legacyDynamicSkills?: boolean;
}

export interface AgentModelRuntimeSettings {
  reasoningEffort: string;
  serviceTier: string;
  verbosity?: string;
  compaction:
    | { mode: "model_default" }
    | {
        mode: "custom_threshold";
        thresholdPercent: number;
        thresholdTokens: number;
      }
    | { mode: "disabled" };
}

export interface AgentRuntimePaths {
  manifestHash: string;
  rootDir: string;
  homeDir: string;
  cliDir: string;
  executablePath: string;
  envPath: string;
}

export interface PhaseArtifactPaths {
  wrapper: string;
  input: string;
  stdout: string;
  stderr: string;
  exitCode: string;
  sentinel: string;
  /** Schema-validated JSON file (Codex --output-schema). null for Claude. */
  structuredOutput: string | null;
}

export interface CollectedPhaseArtifacts {
  stdout: string;
  stderr: string;
  structuredOutput: string | null;
  exitCode: number | null;
}

export type AgentProtocolFailureKind =
  | "install_failed"
  | "setup_failed"
  | "version_unreadable"
  | "version_mismatch"
  | "missing_exit_code"
  | "cli_exit"
  | "provider_error"
  | "missing_result"
  | "invalid_json"
  | "schema_mismatch"
  | "protocol_mismatch";

export interface SerializableAgentCliSpec {
  kind: "claude" | "codex";
  packageName: string;
  version: string;
  executable: string;
  protocol: string;
}

export interface AgentCliSpec extends SerializableAgentCliSpec {
  parseVersion(output: string): string | null;
}

export interface AgentProtocolDiagnostic {
  provider: AgentCliSpec["kind"];
  packageName: string;
  cliVersion: string;
  protocol: string;
  phase: string;
  failureKind: AgentProtocolFailureKind;
  exitCode: number | null;
  event?: {
    type?: string;
    subtype?: string;
    isError?: boolean;
    itemType?: string;
  };
  artifacts?: {
    stdoutBytes: number;
    stderrBytes: number;
    structuredOutputBytes: number;
    stdoutSha256: string;
    stderrSha256: string;
    structuredOutputSha256: string | null;
  };
  schema?: {
    identity: string;
    sha256: string;
    issues: Array<{ path: string; code: string; message: string }>;
  };
  stdoutTail?: string;
  stderrTail?: string;
  detail?: string;
}

export type AgentProtocolFailureCategory = "provider" | "parsing" | "schema";

export type AgentProtocolResult<T> =
  | { ok: true; value: T; event?: AgentProtocolDiagnostic["event"] }
  | {
      ok: false;
      category: AgentProtocolFailureCategory;
      message: string;
      diagnostic: AgentProtocolDiagnostic;
    };

export interface PhaseScriptOpts {
  phase: PhaseKind;
  model: string;
  paths: PhaseArtifactPaths;
  /** When set, the phase requests schema-validated structured output. */
  jsonSchema?: string;
  runtime?: AgentRuntimePaths;
  modelSettings?: AgentModelRuntimeSettings;
}

export interface AgentAdapter {
  kind: "claude" | "codex";
  cliSpec: AgentCliSpec;
  install(
    sandbox: RunnableSandbox,
    runtime?: AgentRuntimePaths,
  ): Promise<void>;
  configure(sandbox: RunnableSandbox, opts: ConfigureOpts): Promise<void>;
  setCommitGuard(
    sandbox: RunnableSandbox,
    enabled: boolean,
    runtime?: AgentRuntimePaths,
  ): Promise<void>;
  buildPhaseScript(opts: PhaseScriptOpts): string;
  artifactPaths(phase: PhaseKind): PhaseArtifactPaths;
  parseAgentOutputProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<AgentOutput>;
  parseReviewOutputProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<ReviewOutput>;
  parseResearchProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<ResearchResult>;
  parseStructuredObjectProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
    schemaIdentity: string,
    schema: string,
  ): AgentProtocolResult<unknown>;
  validateFreeformProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<void>;
  parseAgentOutput(raw: string, structured: string | null): AgentOutput;
  parseReviewOutput(raw: string, structured: string | null): ReviewOutput;
  parseResearchStatus(raw: string, structured: string | null): ResearchResult;
  extractUsage(raw: string, structured: string | null): PhaseUsage | null;
}
