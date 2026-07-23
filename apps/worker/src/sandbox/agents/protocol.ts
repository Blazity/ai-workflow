import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type {
  AgentCliSpec,
  AgentProtocolDiagnostic,
  AgentProtocolFailureCategory,
  AgentProtocolFailureKind,
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  RunnableSandbox,
} from "./types.js";

const DIAGNOSTIC_TAIL_BYTES = 2 * 1024;
const MAX_SCHEMA_ISSUES = 20;

export const AGENT_CLI_SPECS = {
  claude: {
    kind: "claude",
    packageName: "@anthropic-ai/claude-code",
    version: "2.1.216",
    executable: "claude",
    parseVersion: (output: string) =>
      output.trim().match(/^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/)?.[1] ?? null,
    protocol: "claude-json-2.1.216",
  },
  codex: {
    kind: "codex",
    packageName: "@openai/codex",
    version: "0.144.6",
    executable: "codex",
    parseVersion: (output: string) =>
      output.trim().match(/^(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)$/i)?.[1] ?? null,
    protocol: "codex-jsonl-0.144.6",
  },
} as const satisfies Record<AgentCliSpec["kind"], AgentCliSpec>;

import { AgentRuntimeError } from "./runtime-error.js";

export { AgentRuntimeError };
export { isAgentRuntimeError } from "./runtime-error.js";

export async function installAndVerifyCli(
  sandbox: RunnableSandbox,
  spec: AgentCliSpec,
): Promise<void> {
  const install = await sandbox.runCommand("npm", [
    "install",
    "-g",
    `${spec.packageName}@${spec.version}`,
  ]);
  if (install.exitCode !== 0) {
    throw await commandRuntimeError(spec, "install", "install_failed", install);
  }

  const versionCommand = await sandbox.runCommand(spec.executable, ["--version"]);
  if (versionCommand.exitCode !== 0) {
    throw await commandRuntimeError(
      spec,
      "install",
      "version_unreadable",
      versionCommand,
    );
  }
  const versionText = (await versionCommand.stdout()).trim();
  const actualVersion = spec.parseVersion(versionText);
  if (!actualVersion) {
    throw new AgentRuntimeError({
      category: "provider",
      message: "The agent runtime could not be prepared.",
      diagnostic: baseDiagnostic(spec, "install", "version_unreadable", {
        detail: "The CLI version command returned no semantic version.",
      }),
    });
  }
  if (actualVersion !== spec.version) {
    throw new AgentRuntimeError({
      category: "provider",
      message: "The agent runtime could not be prepared.",
      diagnostic: baseDiagnostic(spec, "install", "version_mismatch", {
        detail: `Expected ${spec.version}; received ${actualVersion}.`,
      }),
    });
  }

  const { logger } = await import("../../lib/logger.js");
  logger.info(
    {
      provider: spec.kind,
      packageName: spec.packageName,
      expectedVersion: spec.version,
      actualVersion,
      protocol: spec.protocol,
    },
    "agent_cli_verified",
  );
}

export async function requireProviderSetup(
  result: Awaited<ReturnType<RunnableSandbox["runCommand"]>>,
  spec: AgentCliSpec,
  label: string,
): Promise<void> {
  if (result.exitCode === 0) return;
  throw await commandRuntimeError(spec, "setup", "setup_failed", result, label);
}

export function legacyArtifacts(
  raw: string,
  structuredOutput: string | null,
): CollectedPhaseArtifacts {
  return { stdout: raw, stderr: "", structuredOutput, exitCode: 0 };
}

export function artifactFailure(
  spec: AgentCliSpec,
  phase: string,
  artifacts: CollectedPhaseArtifacts,
  event?: AgentProtocolDiagnostic["event"],
): AgentProtocolResult<never> | null {
  if (artifacts.exitCode === null) {
    return protocolFailure({
      spec,
      phase,
      artifacts,
      failureKind: "missing_exit_code",
      category: "provider",
      message: "The current agent phase could not be completed.",
      event,
      detail: "The phase completed without a readable process exit code.",
    });
  }
  if (artifacts.exitCode !== 0) {
    return protocolFailure({
      spec,
      phase,
      artifacts,
      failureKind: "cli_exit",
      category: "provider",
      message: "The current agent phase could not be completed.",
      event,
      detail: `The CLI exited with code ${artifacts.exitCode}.`,
    });
  }
  return null;
}

export function validateStructuredValue<T>(input: {
  spec: AgentCliSpec;
  phase: string;
  artifacts: CollectedPhaseArtifacts;
  value: unknown;
  schema: ZodType<T>;
  schemaIdentity: string;
  schemaSource: string;
  event?: AgentProtocolDiagnostic["event"];
}): AgentProtocolResult<T> {
  const parsed = input.schema.safeParse(input.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return protocolFailure({
    spec: input.spec,
    phase: input.phase,
    artifacts: input.artifacts,
    failureKind: "schema_mismatch",
    category: "schema",
    message: "The current agent phase returned an invalid structured response.",
    event: input.event,
    schema: {
      identity: input.schemaIdentity,
      source: input.schemaSource,
      issues: parsed.error.issues,
    },
    detail: "The structured response did not satisfy the requested schema.",
  });
}

export function attachSchemaDiagnostic<T>(
  result: AgentProtocolResult<T>,
  identity: string,
  schemaSource: string,
): AgentProtocolResult<T> {
  if (result.ok || result.diagnostic.schema) return result;
  return {
    ...result,
    diagnostic: {
      ...result.diagnostic,
      schema: { identity, sha256: hashText(schemaSource), issues: [] },
    },
  };
}

export function runtimePreparationError(
  spec: AgentCliSpec,
  detail: string,
): AgentRuntimeError {
  return new AgentRuntimeError({
    category: "provider",
    message: "The agent runtime could not be prepared.",
    diagnostic: baseDiagnostic(spec, "setup", "setup_failed", { detail }),
  });
}

export async function commandProtocolFailure(input: {
  spec: AgentCliSpec;
  phase: string;
  result: {
    exitCode: number | null;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  };
  failureKind: "setup_failed" | "cli_exit" | "provider_error";
  message: string;
  detail: string;
}): Promise<Extract<AgentProtocolResult<never>, { ok: false }>> {
  const stdout = await input.result.stdout().catch(() => "");
  const stderr = await input.result.stderr().catch(() => "");
  const failure = protocolFailure({
    spec: input.spec,
    phase: input.phase,
    artifacts: {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      structuredOutput: null,
      exitCode: input.result.exitCode,
    },
    failureKind: input.failureKind,
    category: "provider",
    message: input.message,
    detail: input.detail,
  });
  if (failure.ok) throw new Error("unreachable");
  return failure;
}

export function protocolFailure(input: {
  spec: AgentCliSpec;
  phase: string;
  artifacts: CollectedPhaseArtifacts;
  failureKind: AgentProtocolFailureKind;
  category: AgentProtocolFailureCategory;
  message: string;
  event?: AgentProtocolDiagnostic["event"];
  schema?: {
    identity: string;
    source: string;
    issues: Array<{ path: Array<string | number>; code: string; message: string }>;
  };
  detail?: string;
  includeStdoutTail?: boolean;
}): AgentProtocolResult<never> {
  const { artifacts } = input;
  const diagnostic: AgentProtocolDiagnostic = {
    ...baseDiagnostic(input.spec, input.phase, input.failureKind, {
      exitCode: artifacts.exitCode,
      event: input.event,
      detail: input.detail,
    }),
    artifacts: {
      stdoutBytes: Buffer.byteLength(artifacts.stdout),
      stderrBytes: Buffer.byteLength(artifacts.stderr),
      structuredOutputBytes: Buffer.byteLength(artifacts.structuredOutput ?? ""),
      stdoutSha256: hashText(artifacts.stdout),
      stderrSha256: hashText(artifacts.stderr),
      structuredOutputSha256:
        artifacts.structuredOutput === null ? null : hashText(artifacts.structuredOutput),
    },
  };
  if (input.schema) {
    diagnostic.schema = {
      identity: input.schema.identity,
      sha256: hashText(input.schema.source),
      issues: input.schema.issues.slice(0, MAX_SCHEMA_ISSUES).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: safeRedactedText(issue.message).slice(0, 500),
      })),
    };
  }
  if (input.includeStdoutTail && artifacts.stdout) {
    const tail = safeDiagnosticTail(artifacts.stdout);
    if (tail !== undefined) diagnostic.stdoutTail = tail;
  }
  if (artifacts.stderr) {
    const tail = safeDiagnosticTail(artifacts.stderr);
    if (tail !== undefined) diagnostic.stderrTail = tail;
  }
  return {
    ok: false,
    category: input.category,
    message: input.message,
    diagnostic,
  };
}

export function eventMetadata(value: unknown): AgentProtocolDiagnostic["event"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const item = record.item && typeof record.item === "object"
    ? record.item as Record<string, unknown>
    : undefined;
  const metadata: NonNullable<AgentProtocolDiagnostic["event"]> = {};
  if (typeof record.type === "string") metadata.type = record.type;
  if (typeof record.subtype === "string") metadata.subtype = record.subtype;
  if (typeof record.is_error === "boolean") metadata.isError = record.is_error;
  if (typeof item?.type === "string") metadata.itemType = item.type;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function redactDiagnosticText(value: string): string {
  let redacted = value;
  const sensitiveValues = Object.entries(process.env)
    .filter(([key, secret]) =>
      secret && secret.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
    )
    .map(([, secret]) => secret as string);
  for (const secret of sensitiveValues) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function baseDiagnostic(
  spec: AgentCliSpec,
  phase: string,
  failureKind: AgentProtocolFailureKind,
  extras: Partial<AgentProtocolDiagnostic> = {},
): AgentProtocolDiagnostic {
  return {
    provider: spec.kind,
    packageName: spec.packageName,
    cliVersion: spec.version,
    protocol: spec.protocol,
    phase,
    failureKind,
    exitCode: extras.exitCode ?? null,
    ...extras,
  };
}

async function commandRuntimeError(
  spec: AgentCliSpec,
  phase: string,
  failureKind: "install_failed" | "setup_failed" | "version_unreadable",
  result: Awaited<ReturnType<RunnableSandbox["runCommand"]>>,
  label?: string,
): Promise<AgentRuntimeError> {
  const stdout = await result.stdout().catch(() => "");
  const stderr = await result.stderr().catch(() => "");
  const failure = protocolFailure({
    spec,
    phase,
    artifacts: {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      structuredOutput: null,
      exitCode: result.exitCode,
    },
    failureKind,
    category: "provider",
    message: "The agent runtime could not be prepared.",
    detail: label ? `${label} failed.` : undefined,
  });
  if (failure.ok) throw new Error("unreachable");
  return new AgentRuntimeError(failure);
}

function safeRedactedText(value: string): string {
  try {
    return redactDiagnosticText(value);
  } catch {
    return "[REDACTION FAILED]";
  }
}

function safeDiagnosticTail(value: string): string | undefined {
  try {
    const redacted = redactDiagnosticText(value);
    return Buffer.from(redacted).subarray(-DIAGNOSTIC_TAIL_BYTES).toString();
  } catch {
    return undefined;
  }
}
