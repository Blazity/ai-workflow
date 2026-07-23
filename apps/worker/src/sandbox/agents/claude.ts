import type {
  AgentAdapter, AgentOutput, AgentProtocolResult, CollectedPhaseArtifacts,
  ConfigureOpts, PhaseArtifactPaths, PhaseKind, PhaseScriptOpts, PhaseUsage,
  ResearchResult, ReviewOutput, RunnableSandbox,
} from "./types.js";
import {
  AGENT_SCHEMA, agentOutputSchema, foldResearchOutput, RESEARCH_SCHEMA,
  researchOutputSchema, REVIEW_SCHEMA, reviewOutputSchema,
} from "./types.js";
import {
  AGENT_CLI_SPECS,
  artifactFailure,
  attachSchemaDiagnostic,
  eventMetadata,
  installAndVerifyCli,
  protocolFailure,
  requireProviderSetup,
  runtimePreparationError,
  validateStructuredValue,
} from "./protocol.js";
import {
  AGENT_ENV_CLAUDE_PATH,
  AGENT_ENV_PATH,
  AGENT_ENV_SHIM,
  installSkillsToAgentsDir,
} from "./shared.js";
import { ARTHUR_TRACER_PY_BASE64 } from "../arthur-tracer.js";
import { buildCommitGuardCheckScript } from "./commit-guard.js";
import { WORKSPACE_MANIFEST_PATH } from "../repo-workspace.js";

const ARTHUR_HOOK_EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["UserPromptSubmit", "user_prompt_submit"],
  ["PreToolUse", "pre_tool"],
  ["PostToolUse", "post_tool"],
  ["PostToolUseFailure", "post_tool_failure"],
  ["Stop", "stop"],
];

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  readonly cliSpec = AGENT_CLI_SPECS.claude;

  async install(sandbox: RunnableSandbox): Promise<void> {
    await installAndVerifyCli(sandbox, this.cliSpec);
    // Skip interactive onboarding
    const onboarding = await sandbox.runCommand("bash", [
      "-c",
      `mkdir -p ~/.claude && echo '{"hasCompletedOnboarding":true}' > ~/.claude.json`,
    ]);
    await requireProviderSetup(onboarding, this.cliSpec, "Claude onboarding setup");
  }

  async configure(sandbox: RunnableSandbox, opts: ConfigureOpts): Promise<void> {
    if (!opts.anthropicApiKey) {
      throw runtimePreparationError(
        this.cliSpec,
        "Claude authentication credentials were not configured.",
      );
    }
    // Claude Code CLI accepts standard API keys (`sk-ant-api...`) via
    // ANTHROPIC_API_KEY and OAuth tokens (`sk-ant-oat...`, issued by
    // `claude setup-token`) via CLAUDE_CODE_OAUTH_TOKEN. Operators paste
    // either flavor into ANTHROPIC_API_KEY; route to the right sandbox var
    // by prefix so OAuth tokens don't get rejected as invalid API keys.
    const isOauthToken = opts.anthropicApiKey.startsWith("sk-ant-oat");
    const envLines: string[] = [
      isOauthToken
        ? `export CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(opts.anthropicApiKey)}`
        : `export ANTHROPIC_API_KEY=${shellQuote(opts.anthropicApiKey)}`,
    ];
    await sandbox.writeFiles([
      { path: AGENT_ENV_CLAUDE_PATH, content: Buffer.from(envLines.join("\n") + "\n") },
      { path: AGENT_ENV_PATH, content: Buffer.from(AGENT_ENV_SHIM) },
    ]);
    const secureEnv = await sandbox.runCommand("chmod", ["600", AGENT_ENV_CLAUDE_PATH]);
    await requireProviderSetup(secureEnv, this.cliSpec, "Claude credential setup");

    // Skills: installer writes to ~/.claude/skills and ~/.agents/skills directly.
    await installSkillsToAgentsDir(sandbox, this.cliSpec);

    // Arthur tracer (no-op without config)
    if (opts.arthur) {
      await this.installArthurTracer(sandbox, opts.arthur);
    }
  }

  async setCommitGuard(sandbox: RunnableSandbox, enabled: boolean): Promise<void> {
    // 1) Drop the guard script (idempotent)
    const guardScript = await sandbox.runCommand("bash", [
      "-c",
      [
        "mkdir -p ~/.claude",
        "cat > ~/.claude/commit-guard.sh << 'SCRIPT'",
        "#!/bin/bash",
        "input=$(cat)",
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        buildCommitGuardCheckScript({
          manifestPath: WORKSPACE_MANIFEST_PATH,
          ignoredDirs: [".claude"],
        }),
        `if [ -n "$changes" ]; then`,
        `  echo '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}' >&2`,
        "  exit 2",
        "fi",
        "SCRIPT",
        "chmod +x ~/.claude/commit-guard.sh",
      ].join("\n"),
    ]);
    await requireProviderSetup(guardScript, this.cliSpec, "Claude commit guard setup");

    // 2) Toggle the Stop hook entry via merge-aware settings.json writer
    await this.mergeSettings(sandbox, { commitGuard: enabled ? "enable" : "disable" });
  }

  buildPhaseScript(opts: PhaseScriptOpts): string {
    const { paths, jsonSchema, model, phase } = opts;
    const safePhase = sanitizePhase(phase);
    let claudeFlags = `--print --model ${shellQuote(model)} --dangerously-skip-permissions --output-format json`;
    if (jsonSchema) {
      const escapedSchema = jsonSchema.replace(/'/g, "'\\''");
      claudeFlags += ` --json-schema '${escapedSchema}'`;
    }
    return `#!/bin/bash

# --- Cleanup stale files from prior runs ---
rm -f ${paths.sentinel} ${paths.stdout} ${paths.stderr} ${paths.exitCode}

# --- Source auth env vars ---
[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh

# --- Phase: ${safePhase} ---
cat ${paths.input} | claude \\
  ${claudeFlags} \\
  > ${paths.stdout} 2>${paths.stderr}
PHASE_EXIT_CODE=$?
echo "$PHASE_EXIT_CODE" > ${paths.exitCode}

# --- Cleanup ---
cd /vercel/sandbox
rm -rf .claude/
git checkout -- .claude/ 2>/dev/null || true

# --- Signal completion ---
touch ${paths.sentinel}
`;
  }

  artifactPaths(phase: PhaseKind): PhaseArtifactPaths {
    const p = sanitizePhase(phase);
    return {
      wrapper: `/tmp/${p}-wrapper.sh`,
      input: `/tmp/${p}-requirements.md`,
      stdout: `/tmp/${p}-stdout.txt`,
      stderr: `/tmp/${p}-stderr.txt`,
      exitCode: `/tmp/${p}-exit-code`,
      sentinel: `/tmp/${p}-done`,
      structuredOutput: null,
    };
  }

  parseAgentOutputProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<AgentOutput> {
    const extracted = attachSchemaDiagnostic(
      extractClaudePayload(this.cliSpec, artifacts, phase),
      "agent-output",
      AGENT_SCHEMA,
    );
    if (!extracted.ok) return extracted;
    return validateStructuredValue({
      spec: this.cliSpec,
      phase,
      artifacts,
      value: extracted.value,
      schema: agentOutputSchema,
      schemaIdentity: "agent-output",
      schemaSource: AGENT_SCHEMA,
      event: extracted.event,
    });
  }

  parseReviewOutputProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<ReviewOutput> {
    const extracted = attachSchemaDiagnostic(
      extractClaudePayload(this.cliSpec, artifacts, phase),
      "review-output",
      REVIEW_SCHEMA,
    );
    if (!extracted.ok) return extracted;
    return validateStructuredValue({
      spec: this.cliSpec,
      phase,
      artifacts,
      value: extracted.value,
      schema: reviewOutputSchema,
      schemaIdentity: "review-output",
      schemaSource: REVIEW_SCHEMA,
      event: extracted.event,
    });
  }

  parseResearchProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<ResearchResult> {
    const extracted = attachSchemaDiagnostic(
      extractClaudePayload(this.cliSpec, artifacts, phase),
      "research-output",
      RESEARCH_SCHEMA,
    );
    if (!extracted.ok) return extracted;
    const validated = validateStructuredValue({
      spec: this.cliSpec,
      phase,
      artifacts,
      value: extracted.value,
      schema: researchOutputSchema,
      schemaIdentity: "research-output",
      schemaSource: RESEARCH_SCHEMA,
      event: extracted.event,
    });
    return validated.ok
      ? { ok: true, value: foldResearchOutput(validated.value) }
      : validated;
  }

  parseStructuredObjectProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
    schemaIdentity: string,
    schema: string,
  ): AgentProtocolResult<unknown> {
    return attachSchemaDiagnostic(
      extractClaudePayload(this.cliSpec, artifacts, phase),
      schemaIdentity,
      schema,
    );
  }

  validateFreeformProtocol(
    artifacts: CollectedPhaseArtifacts,
    phase: string,
  ): AgentProtocolResult<void> {
    const envelope = findResultEnvelope(artifacts.stdout);
    const event = eventMetadata(envelope);
    const processFailure = artifactFailure(this.cliSpec, phase, artifacts, event);
    if (processFailure) return processFailure;
    if (!envelope) {
      const records = parseClaudeRecords(artifacts.stdout);
      return protocolFailure({
        spec: this.cliSpec,
        phase,
        artifacts,
        failureKind: artifacts.stdout.trim()
          ? records.length > 0 ? "protocol_mismatch" : "invalid_json"
          : "missing_result",
        category: "parsing",
        message: "The current agent phase returned an invalid structured response.",
        detail: "Claude did not emit a terminal result envelope.",
        includeStdoutTail: true,
      });
    }
    if (envelope.is_error === true || envelope.subtype === "error") {
      return protocolFailure({
        spec: this.cliSpec,
        phase,
        artifacts,
        failureKind: "provider_error",
        category: "provider",
        message: "The current agent phase could not be completed.",
        event,
        detail: "Claude emitted an error result envelope.",
      });
    }
    if (envelope.subtype !== "success") {
      return protocolFailure({
        spec: this.cliSpec,
        phase,
        artifacts,
        failureKind: "protocol_mismatch",
        category: "parsing",
        message: "The current agent phase returned an invalid structured response.",
        event,
        detail: "Claude emitted an unrecognized terminal result subtype.",
      });
    }
    return { ok: true, value: undefined };
  }

  parseAgentOutput(raw: string, _structured: string | null): AgentOutput {
    if (!raw.trim()) return { result: "failed", error: "Agent produced no output" };

    try {
      const direct = agentOutputSchema.safeParse(JSON.parse(raw));
      if (direct.success) return direct.data;
    } catch { /* not direct JSON */ }

    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "result") {
          if (event.structured_output != null) {
            const parsed = agentOutputSchema.safeParse(event.structured_output);
            if (parsed.success) return parsed.data;
          }
          if (typeof event.result === "string") {
            try {
              const parsed = agentOutputSchema.safeParse(JSON.parse(event.result));
              if (parsed.success) return parsed.data;
            } catch { /* not JSON */ }
          }
          // Claude runs with --json-schema; a success envelope with no
          // schema-validated payload is anomalous, not implicitly "implemented".
          return {
            result: "failed",
            error: typeof event.result === "string"
              ? event.result.trim().slice(0, 500)
              : "Agent returned non-structured result",
          };
        }
        const direct = agentOutputSchema.safeParse(event);
        if (direct.success) return direct.data;
      } catch { /* try next line */ }
    }

    return { result: "failed", error: `Agent output was not structured JSON. Output starts with: ${raw.slice(0, 500)}` };
  }

  parseReviewOutput(raw: string, _structured: string | null): ReviewOutput {
    if (!raw.trim()) {
      return { result: "failed", feedback: "", issues: [], error: "Review agent produced no output" };
    }
    try {
      const direct = reviewOutputSchema.safeParse(JSON.parse(raw));
      if (direct.success) return direct.data;
    } catch { /* not direct JSON */ }

    const lines = raw.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "result" && event.structured_output != null) {
          const parsed = reviewOutputSchema.safeParse(event.structured_output);
          if (parsed.success) return parsed.data;
        }
        const direct = reviewOutputSchema.safeParse(event);
        if (direct.success) return direct.data;
      } catch { /* try next */ }
    }

    return {
      result: "failed", feedback: "", issues: [],
      error: `Review output was not structured JSON. Output starts with: ${raw.slice(0, 500)}`,
    };
  }

  parseResearchStatus(raw: string, _structured: string | null): ResearchResult {
    // Claude runs with --json-schema for every phase; we never accept
    // free-form text here. If the schema-validated payload is missing,
    // surface that as a failure instead of fishing for a STATUS line.
    const json = tryParseResearchJson(raw);
    if (json) return foldResearchOutput(json);
    const envelopeError = summarizeResultEnvelopeError(raw);
    if (envelopeError) return { status: "failed", body: envelopeError };
    return {
      status: "failed",
      body: `Research output was not schema-validated JSON. Output starts with: ${raw.slice(0, 500)}`,
    };
  }

  extractUsage(raw: string, _structured: string | null): PhaseUsage | null {
    if (!raw.trim()) return null;
    const envelope = findResultEnvelope(raw);
    if (!envelope) return null;
    const cost =
      typeof envelope.cost_usd === "number" ? envelope.cost_usd
      : typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd
      : null;
    // The Claude CLI result envelope carries an Anthropic Messages-API `usage`
    // object; map it onto PhaseUsage.tokens so per-run token counts get persisted
    // (cache-creation counts as input, cache reads as cached_input).
    const u = (envelope.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const tokens =
      typeof u.input_tokens === "number" || typeof u.output_tokens === "number"
        ? {
            input: num(u.input_tokens) + num(u.cache_creation_input_tokens),
            cached_input: num(u.cache_read_input_tokens),
            output: num(u.output_tokens),
          }
        : null;
    return {
      cost_usd: cost,
      tokens,
      duration_ms: typeof envelope.duration_ms === "number" ? envelope.duration_ms : 0,
      duration_api_ms: typeof envelope.duration_api_ms === "number" ? envelope.duration_api_ms : 0,
      num_turns: typeof envelope.num_turns === "number" ? envelope.num_turns : 0,
    };
  }

  // --- private ---

  private async installArthurTracer(
    sandbox: RunnableSandbox,
    arthur: NonNullable<ConfigureOpts["arthur"]>,
  ): Promise<void> {
    const { logger } = await import("../../lib/logger.js");
    logger.info({ endpoint: arthur.endpoint, taskId: arthur.taskId, agent: this.kind }, "agent_install_arthur_started");

    const pip = await sandbox.runCommand("bash", [
      "-c",
      "python3 -m ensurepip --user && python3 -m pip install --user --quiet 'opentelemetry-sdk>=1.20.0' 'opentelemetry-exporter-otlp-proto-http>=1.20.0'",
    ]);
    if (pip.exitCode !== 0) {
      logger.warn({}, "arthur_pip_install_failed");
      return;
    }

    const tracerBytes = Buffer.from(ARTHUR_TRACER_PY_BASE64, "base64");
    await sandbox.writeFiles([{ path: "/tmp/arthur-tracer.py", content: tracerBytes }]);
    const mvTracer = await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.claude/hooks && mv /tmp/arthur-tracer.py $HOME/.claude/hooks/claude_code_tracer.py && chmod +x $HOME/.claude/hooks/claude_code_tracer.py",
    ]);
    if (mvTracer.exitCode !== 0) {
      logger.warn({}, "arthur_tracer_install_failed");
      return;
    }

    const configJson = JSON.stringify(
      { api_key: arthur.apiKey, task_id: arthur.taskId, endpoint: arthur.endpoint },
      null, 2,
    );
    await sandbox.writeFiles([{ path: "/tmp/arthur_config.json", content: Buffer.from(configJson) }]);
    await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.claude && mv /tmp/arthur_config.json $HOME/.claude/arthur_config.json && chmod 600 $HOME/.claude/arthur_config.json",
    ]);

    await this.mergeSettings(sandbox, { arthur: "install" });
    logger.info({ agent: this.kind }, "agent_install_arthur_complete");
  }

  /** Merge-aware writer for ~/.claude/settings.json. */
  private async mergeSettings(
    sandbox: RunnableSandbox,
    opts: { commitGuard?: "enable" | "disable"; arthur?: "install" },
  ): Promise<void> {
    const arthurEvents = JSON.stringify(ARTHUR_HOOK_EVENTS);
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      const opts = ${JSON.stringify(opts)};
      const arthurEvents = ${arthurEvents};
      const home = process.env.HOME;
      const settingsPath = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      let s = {};
      try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
      s.hooks = s.hooks || {};

      const upsertHook = (event, matcher, command) => {
        const existing = s.hooks[event] || [];
        const has = existing.some(e => (e && Array.isArray(e.hooks) ? e.hooks : []).some(h => h && h.command === command));
        if (!has) existing.push({ matcher, hooks: [{ type: 'command', command }] });
        s.hooks[event] = existing;
      };
      const removeHook = (event, predicate) => {
        const existing = s.hooks[event] || [];
        s.hooks[event] = existing
          .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => !predicate(h.command || '')) }))
          .filter(e => (e.hooks || []).length > 0);
      };

      if (opts.commitGuard === 'enable') upsertHook('Stop', '', 'bash ~/.claude/commit-guard.sh');
      else if (opts.commitGuard === 'disable') removeHook('Stop', c => c.includes('commit-guard.sh'));

      if (opts.arthur === 'install') {
        for (const [event, arg] of arthurEvents) {
          upsertHook(event, '', 'python3 "$HOME/.claude/hooks/claude_code_tracer.py" ' + arg);
        }
      }
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
    `;
    const merge = await sandbox.runCommand("node", ["--input-type=module", "-e", script]);
    await requireProviderSetup(merge, this.cliSpec, "Claude settings setup");
  }
}

// --- module-private helpers ---

function shellQuote(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
}

/** Collapse an arbitrary phase label to a shell/file-safe token ([a-z0-9-]). */
function sanitizePhase(phase: string): string {
  return phase.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function extractClaudePayload(
  spec: typeof AGENT_CLI_SPECS.claude,
  artifacts: CollectedPhaseArtifacts,
  phase: string,
): AgentProtocolResult<unknown> {
  const envelope = findResultEnvelope(artifacts.stdout);
  const event = eventMetadata(envelope);
  const processFailure = artifactFailure(spec, phase, artifacts, event);
  if (processFailure) return processFailure;

  if (envelope) {
    if (envelope.is_error === true || envelope.subtype === "error") {
      return protocolFailure({
        spec,
        phase,
        artifacts,
        failureKind: "provider_error",
        category: "provider",
        message: "The current agent phase could not be completed.",
        event,
        detail: "Claude emitted an error result envelope.",
      });
    }
    if (envelope.subtype !== "success") {
      return protocolFailure({
        spec,
        phase,
        artifacts,
        failureKind: "protocol_mismatch",
        category: "parsing",
        message: "The current agent phase returned an invalid structured response.",
        event,
        detail: "Claude emitted an unrecognized terminal result subtype.",
      });
    }
    if (envelope.structured_output != null) {
      return { ok: true, value: envelope.structured_output, event };
    }
    if (typeof envelope.result === "string") {
      try {
        return { ok: true, value: JSON.parse(envelope.result), event };
      } catch {
        return protocolFailure({
          spec,
          phase,
          artifacts,
          failureKind: "protocol_mismatch",
          category: "parsing",
          message: "The current agent phase returned an invalid structured response.",
          event,
          detail: "Claude emitted a result envelope without structured JSON.",
        });
      }
    }
    return protocolFailure({
      spec,
      phase,
      artifacts,
      failureKind: "missing_result",
      category: "parsing",
      message: "The current agent phase returned an invalid structured response.",
      event,
      detail: "Claude emitted a terminal envelope without a result payload.",
    });
  }

  const records = parseClaudeRecords(artifacts.stdout);
  const lastEvent = eventMetadata(records.at(-1));
  return protocolFailure({
    spec,
    phase,
    artifacts,
    failureKind: records.length > 0 ? "protocol_mismatch" : "invalid_json",
    category: "parsing",
    message: "The current agent phase returned an invalid structured response.",
    event: lastEvent,
    detail: records.length > 0
      ? "Claude emitted JSON events without a terminal result."
      : "Claude output was not valid JSON.",
    includeStdoutTail: records.length === 0,
  });
}

function parseClaudeRecords(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function findResultEnvelope(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && (obj as any).type === "result") return obj as Record<string, unknown>;
  } catch { /* not single JSON */ }
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === "object" && (obj as any).type === "result") return obj as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

function tryParseResearchJson(raw: string): ReturnType<typeof researchOutputSchema.safeParse>["data"] | null {
  if (!raw.trim()) return null;

  const tryParse = (value: unknown) => {
    const parsed = researchOutputSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  // Direct JSON (no Claude Code envelope)
  try {
    const direct = tryParse(JSON.parse(raw));
    if (direct) return direct;
  } catch { /* not direct JSON */ }

  // Claude Code wraps the model output in a `type:"result"` envelope.
  // With --json-schema, the validated payload lands in `structured_output`;
  // otherwise the model's reply text is in `result` (may itself be JSON).
  const env = findResultEnvelope(raw);
  if (!env) return null;

  if (env.structured_output != null) {
    const got = tryParse(env.structured_output);
    if (got) return got;
  }
  if (typeof env.result === "string") {
    try {
      const got = tryParse(JSON.parse(env.result));
      if (got) return got;
    } catch { /* not JSON */ }
  }
  return null;
}

function summarizeResultEnvelopeError(raw: string): string | null {
  const env = findResultEnvelope(raw);
  if (!env) return null;

  const result = typeof env.result === "string" ? env.result.trim() : "";
  const errors = Array.isArray(env.errors)
    ? env.errors.filter((err): err is string => typeof err === "string" && err.trim().length > 0)
    : [];
  if (env.is_error === true || errors.length > 0) {
    const details = [result, ...errors].filter(Boolean).join("; ");
    return details || "Claude CLI returned an error result";
  }
  return null;
}
