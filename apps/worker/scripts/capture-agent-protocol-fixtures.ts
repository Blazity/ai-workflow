import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Sandbox } from "@vercel/sandbox";
import { createAgentAdapter, type AgentKind } from "../src/sandbox/agents/index.js";
import { AGENT_SCHEMA, type CollectedPhaseArtifacts } from "../src/sandbox/agents/types.js";
import { getSandboxCredentials } from "../src/sandbox/credentials.js";

const args = process.argv.slice(2);
const requestedProvider = option("--provider") ?? "all";
const envFile = option("--env-file");
const shouldWrite = args.includes("--write");
if (envFile) loadEnv({ path: envFile, quiet: true });

const providers: AgentKind[] = requestedProvider === "all"
  ? ["claude", "codex"]
  : requestedProvider === "claude" || requestedProvider === "codex"
    ? [requestedProvider]
    : fail("--provider must be claude, codex, or all");

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "sandbox",
  "agents",
  "fixtures",
);

for (const provider of providers) {
  await captureProvider(provider);
}

async function captureProvider(provider: AgentKind): Promise<void> {
  const adapter = createAgentAdapter(provider);
  const apiKey = provider === "claude"
    ? process.env.ANTHROPIC_API_KEY
    : process.env.CODEX_API_KEY;
  if (!apiKey) {
    fail(
      provider === "claude"
        ? "ANTHROPIC_API_KEY is required for Claude fixture capture"
        : "CODEX_API_KEY is required for Codex fixture capture; OAuth provisioning is outside AIW-106",
    );
  }

  const sandbox = await Sandbox.create({
    ...getSandboxCredentials(),
    runtime: "node24",
    timeout: 15 * 60 * 1000,
  });
  try {
    await adapter.install(sandbox);
    await adapter.configure(sandbox, {
      anthropicApiKey: provider === "claude" ? apiKey : undefined,
      codexApiKey: provider === "codex" ? apiKey : undefined,
      model: provider === "claude"
        ? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6"
        : process.env.CODEX_MODEL ?? "gpt-5.3-codex",
    });

    const structured = await invoke({
      sandbox,
      provider,
      model: provider === "claude"
        ? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6"
        : process.env.CODEX_MODEL ?? "gpt-5.3-codex",
      phase: "fixture-structured",
      prompt:
        "Return the requested structured result with result=implemented, summary=sanitized fixture, and every nullable field set to null. Do not inspect the environment.",
      schema: AGENT_SCHEMA,
    });
    const freeform = await invoke({
      sandbox,
      provider,
      model: provider === "claude"
        ? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6"
        : process.env.CODEX_MODEL ?? "gpt-5.3-codex",
      phase: "fixture-freeform",
      prompt: "Reply with exactly: fixture complete",
    });

    const structuredValidation = adapter.parseAgentOutputProtocol(
      structured,
      "fixture-structured",
    );
    if (!structuredValidation.ok) {
      throw new Error(
        `structured fixture capture failed protocol validation: ${structuredValidation.diagnostic.failureKind}`,
      );
    }
    const freeformValidation = adapter.validateFreeformProtocol(
      freeform,
      "fixture-freeform",
    );
    if (!freeformValidation.ok) {
      throw new Error(
        `freeform fixture capture failed protocol validation: ${freeformValidation.diagnostic.failureKind}`,
      );
    }

    const structuredFixture = fixtureDocument(adapter.cliSpec, structured);
    const freeformFixture = fixtureDocument(adapter.cliSpec, freeform);
    assertSecretFree(structuredFixture);
    assertSecretFree(freeformFixture);

    if (shouldWrite) {
      const target = join(fixtureRoot, provider, adapter.cliSpec.version);
      await mkdir(target, { recursive: true });
      await writeFile(
        join(target, "structured-success.json"),
        `${JSON.stringify(structuredFixture, null, 2)}\n`,
      );
      await writeFile(
        join(target, "freeform-success.json"),
        `${JSON.stringify(freeformFixture, null, 2)}\n`,
      );
    }

    console.log(JSON.stringify({
      provider,
      package: adapter.cliSpec.packageName,
      version: adapter.cliSpec.version,
      protocol: adapter.cliSpec.protocol,
      structured: artifactSummary(structured),
      freeform: artifactSummary(freeform),
      wroteFixtures: shouldWrite,
    }));
  } finally {
    await sandbox.stop();
  }
}

async function invoke(input: {
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>;
  provider: AgentKind;
  model: string;
  phase: string;
  prompt: string;
  schema?: string;
}): Promise<CollectedPhaseArtifacts> {
  const adapter = createAgentAdapter(input.provider);
  const paths = adapter.artifactPaths(input.phase);
  const script = adapter.buildPhaseScript({
    phase: input.phase,
    model: input.model,
    paths,
    ...(input.schema ? { jsonSchema: input.schema } : {}),
  });
  await input.sandbox.writeFiles([
    { path: paths.input, content: Buffer.from(input.prompt) },
    { path: paths.wrapper, content: Buffer.from(script) },
  ]);
  const chmod = await input.sandbox.runCommand("chmod", ["+x", paths.wrapper]);
  if (chmod.exitCode !== 0) throw new Error("fixture wrapper chmod failed");
  await input.sandbox.runCommand({
    cmd: "bash",
    args: [paths.wrapper],
    cwd: "/vercel/sandbox",
  });
  const read = async (path: string): Promise<string> => {
    const result = await input.sandbox.runCommand("cat", [path]);
    return result.exitCode === 0 ? (await result.stdout()).trim() : "";
  };
  const stdout = await read(paths.stdout);
  const stderr = await read(paths.stderr);
  const structuredOutput = paths.structuredOutput
    ? (await read(paths.structuredOutput)) || null
    : null;
  const exitCodeText = await read(paths.exitCode);
  return {
    stdout,
    stderr,
    structuredOutput,
    exitCode: /^-?\d+$/.test(exitCodeText) ? Number(exitCodeText) : null,
  };
}

function fixtureDocument(
  spec: ReturnType<typeof createAgentAdapter>["cliSpec"],
  artifacts: CollectedPhaseArtifacts,
) {
  return {
    package: spec.packageName,
    version: spec.version,
    protocol: spec.protocol,
    provenance: "captured in a disposable Vercel Sandbox and normalized",
    artifacts: normalizeArtifacts(artifacts),
  };
}

function normalizeArtifacts(artifacts: CollectedPhaseArtifacts): CollectedPhaseArtifacts {
  return {
    stdout: normalizeProtocolText(artifacts.stdout),
    stderr: redact(artifacts.stderr),
    structuredOutput: artifacts.structuredOutput === null
      ? null
      : normalizeStructuredOutput(artifacts.structuredOutput),
    exitCode: artifacts.exitCode,
  };
}

function normalizeProtocolText(value: string): string {
  return value.split("\n").map((line) => {
    try {
      return JSON.stringify(normalizeValue(JSON.parse(line)));
    } catch {
      return redact(line);
    }
  }).join("\n");
}

function normalizeStructuredOutput(value: string): string {
  try {
    return JSON.stringify(normalizeValue(JSON.parse(value)));
  } catch {
    return "[sanitized freeform response]";
  }
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!value || typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["id", "thread_id", "session_id", "uuid", "timestamp", "cwd"].includes(key)) {
      normalized[key] = "normalized";
    } else if (key === "result" && typeof entry === "string") {
      normalized[key] = [
        "implemented",
        "clarification_needed",
        "failed",
        "approved",
        "fixture complete",
      ].includes(entry.trim())
        ? entry.trim()
        : "[sanitized response]";
    } else if (key === "text" && typeof entry === "string") {
      normalized[key] = entry.trim() === "fixture complete"
        ? "fixture complete"
        : "[sanitized response]";
    } else {
      normalized[key] = normalizeValue(entry);
    }
  }
  return normalized;
}

function redact(value: string): string {
  let result = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && secret.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
}

function assertSecretFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  const configuredSecrets = Object.entries(process.env)
    .filter(([key, secret]) =>
      secret && secret.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
    )
    .map(([, secret]) => secret as string);
  const leakedConfiguredSecret = configuredSecrets.some((secret) => serialized.includes(secret));
  const leakedTokenPattern = /\b(?:sk-ant-|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_|github_pat_|glpat-|Bearer\s+(?!\[REDACTED\]))/i
    .test(serialized);
  if (leakedConfiguredSecret || leakedTokenPattern) {
    throw new Error("fixture secret scan failed; refusing to write protocol fixtures");
  }
}

function artifactSummary(artifacts: CollectedPhaseArtifacts) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    exitCode: artifacts.exitCode,
    stdoutBytes: Buffer.byteLength(artifacts.stdout),
    stderrBytes: Buffer.byteLength(artifacts.stderr),
    structuredOutputBytes: Buffer.byteLength(artifacts.structuredOutput ?? ""),
    stdoutSha256: hash(artifacts.stdout),
    stderrSha256: hash(artifacts.stderr),
    structuredOutputSha256: artifacts.structuredOutput === null
      ? null
      : hash(artifacts.structuredOutput),
  };
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message: string): never {
  throw new Error(message);
}
