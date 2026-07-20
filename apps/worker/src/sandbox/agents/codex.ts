import type {
  AgentAdapter, AgentOutput, ConfigureOpts, PhaseArtifactPaths, PhaseKind,
  PhaseScriptOpts, PhaseUsage, ResearchResult, ReviewOutput, RunnableSandbox,
} from "./types.js";
import { agentOutputSchema, foldResearchOutput, researchOutputSchema, reviewOutputSchema } from "./types.js";
import {
  AGENT_ENV_CODEX_PATH,
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
  ["Stop", "stop"],
];

export class CodexAgentAdapter implements AgentAdapter {
  readonly kind = "codex" as const;

  async install(sandbox: RunnableSandbox): Promise<void> {
    await sandbox.runCommand("npm", ["install", "-g", "@openai/codex"]);
  }

  async configure(sandbox: RunnableSandbox, opts: ConfigureOpts): Promise<void> {
    if (!opts.codexApiKey && !opts.codexChatGptOauthToken) {
      throw new Error("CodexAgentAdapter.configure requires codexApiKey or codexChatGptOauthToken");
    }

    // 1) auth env file. Codex CLI auto-reads OPENAI_API_KEY when no auth.json
    // exists; we additionally run `codex login --with-api-key` below to
    // populate ~/.codex/auth.json so subsequent invocations work without env.
    const envLines: string[] = [];
    if (opts.codexApiKey) envLines.push(`export OPENAI_API_KEY=${shellQuote(opts.codexApiKey)}`);
    // Arthur tracer runs as a hook subprocess; expose its env so it picks up
    // config without depending on the discovery file paths.
    if (opts.arthur) {
      envLines.push(`export GENAI_ENGINE_API_KEY=${shellQuote(opts.arthur.apiKey)}`);
      envLines.push(`export GENAI_ENGINE_TASK_ID=${shellQuote(opts.arthur.taskId)}`);
      envLines.push(`export GENAI_ENGINE_TRACE_ENDPOINT=${shellQuote(opts.arthur.endpoint)}`);
    }
    await sandbox.writeFiles([
      { path: AGENT_ENV_CODEX_PATH, content: Buffer.from(envLines.join("\n") + "\n") },
      { path: AGENT_ENV_PATH, content: Buffer.from(AGENT_ENV_SHIM) },
    ]);
    await sandbox.runCommand("chmod", ["600", AGENT_ENV_CODEX_PATH]);

    // 2) ~/.codex/config.toml — model + sandbox profile + hooks feature flag
    // (codex_hooks is gated; without it ~/.codex/hooks.json is ignored).
    // sandbox_mode is danger-full-access because the OUTER Vercel Sandbox
    // microVM already enforces isolation, and Codex's workspace-write mode
    // shells out to bwrap which requires user-namespace creation that Vercel
    // Sandbox blocks ("bwrap: No permissions to create a new namespace").
    const configToml = [
      `model = ${shellQuote(opts.model)}`,
      `approval_policy = "never"`,
      `sandbox_mode = "danger-full-access"`,
      ``,
      `[features]`,
      `codex_hooks = true`,
    ].join("\n") + "\n";
    await sandbox.writeFiles([{ path: "/tmp/config.toml", content: Buffer.from(configToml) }]);
    await sandbox.runCommand("bash", ["-c", "mkdir -p $HOME/.codex && mv /tmp/config.toml $HOME/.codex/config.toml"]);

    // 3) Persist API-key auth to ~/.codex/auth.json (OAuth token path uses the
    // ChatGPT-cached auth.json shape directly; for now only API-key login is
    // automated — OAuth tokens are exported via env above).
    if (opts.codexApiKey) {
      await sandbox.runCommand("bash", [
        "-c",
        `[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh; printenv OPENAI_API_KEY | codex login --with-api-key`,
      ]);
    }

    // 4) skills (~/.agents/skills via `--agent codex`)
    await installSkillsToAgentsDir(sandbox);

    // 5) commit-guard script (idempotent)
    await this.writeCommitGuardScript(sandbox);

    // 6) Hide Codex's per-cwd session dir from git status. Without this the
    // agent sees `.codex/` as untracked, "fixes" it by adding the path to
    // `.gitignore`, commits only that, and the implementation never runs —
    // observed on AWT-641 ($14 of impl-phase tokens, PR diff = .gitignore).
    // .git/info/exclude is local to this clone and never pushed.
    await sandbox.runCommand("bash", [
      "-c",
      `mkdir -p /vercel/sandbox/.git/info && grep -qxF '.codex/' /vercel/sandbox/.git/info/exclude 2>/dev/null || echo '.codex/' >> /vercel/sandbox/.git/info/exclude`,
    ]);

    // 7) Arthur tracer. Re-uses the Claude Code tracer; Codex traces will be
    // labeled as "claude-code" in Arthur until a dedicated Codex tracer ships.
    if (opts.arthur) await this.installArthurTracer(sandbox, opts.arthur);
  }

  async setCommitGuard(sandbox: RunnableSandbox, enabled: boolean): Promise<void> {
    await this.writeCommitGuardScript(sandbox);   // idempotent
    await this.mergeHooks(sandbox, { commitGuard: enabled ? "enable" : "disable" });
  }

  buildPhaseScript(opts: PhaseScriptOpts): string {
    const { paths, jsonSchema, model, phase } = opts;
    const safePhase = sanitizePhase(phase);

    // --dangerously-bypass-approvals-and-sandbox over --full-auto: --full-auto
    // upgrades to workspace-write which uses bwrap. bwrap fails inside Vercel
    // Sandbox because the microVM blocks user-namespace creation. The outer
    // microVM already provides the isolation Codex's inner sandbox would.
    const flags: string[] = [
      `--model ${shellQuote(model)}`,
      `--dangerously-bypass-approvals-and-sandbox`,
      `--skip-git-repo-check`,
      `--json`,
      `-o ${paths.structuredOutput}`,
    ];

    let schemaBlock = "";
    if (jsonSchema) {
      // Quoted heredoc terminator ('SCHEMA_EOF') keeps the body literal — no
      // shell expansion or escaping is needed for the JSON contents.
      schemaBlock = [
        `cat > /tmp/${safePhase}-schema.json << 'SCHEMA_EOF'`,
        jsonSchema,
        "SCHEMA_EOF",
      ].join("\n");
      flags.push(`--output-schema /tmp/${safePhase}-schema.json`);
    }

    return `#!/bin/bash

# --- Cleanup stale files ---
rm -f ${paths.sentinel} ${paths.stdout} ${paths.stderr} ${paths.structuredOutput}

# --- Source auth env vars ---
[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh

${schemaBlock}

# --- Phase: ${safePhase} ---
# Record wall-clock duration as a fallback for usage reporting — Codex's
# NDJSON events do not carry a timestamp field that extractUsage can parse.
START_MS=$(date +%s%3N)
cat ${paths.input} | codex exec \\
  ${flags.join(" \\\n  ")} \\
  - \\
  > ${paths.stdout} 2> ${paths.stderr}; echo $? > /tmp/${safePhase}-exit-code || true
END_MS=$(date +%s%3N)
echo "{\\"type\\":\\"phase.duration\\",\\"duration_ms\\":$((END_MS - START_MS))}" >> ${paths.stdout}

# --- Cleanup ---
cd /vercel/sandbox
rm -rf .codex/
git checkout -- .codex/ 2>/dev/null || true

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
      sentinel: `/tmp/${p}-done`,
      structuredOutput: `/tmp/${p}-result.json`,
    };
  }

  parseAgentOutput(raw: string, structured: string | null): AgentOutput {
    if (structured) {
      try {
        const parsed = agentOutputSchema.safeParse(JSON.parse(structured));
        if (parsed.success) return parsed.data;
      } catch { /* fall through */ }
    }
    const text = unwrapLastAgentMessage(raw);
    if (text) {
      try {
        const parsed = agentOutputSchema.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
      } catch { /* fall through */ }
    }
    if (!raw.trim() && !structured) {
      return { result: "failed", error: "Codex produced no output" };
    }
    return {
      result: "failed",
      error: `Codex output unparseable. First 500: ${(structured ?? raw).slice(0, 500)}`,
    };
  }

  parseReviewOutput(raw: string, structured: string | null): ReviewOutput {
    if (structured) {
      try {
        const parsed = reviewOutputSchema.safeParse(JSON.parse(structured));
        if (parsed.success) return parsed.data;
      } catch { /* fall through */ }
    }
    const text = unwrapLastAgentMessage(raw);
    if (text) {
      try {
        const parsed = reviewOutputSchema.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
      } catch { /* fall through */ }
    }
    return {
      result: "failed", feedback: "", issues: [],
      error: `Codex review output unparseable. First 500: ${(structured ?? raw).slice(0, 500)}`,
    };
  }

  parseResearchStatus(raw: string, structured: string | null): ResearchResult {
    // Structured file: written by Codex when --output-schema is set.
    if (structured) {
      try {
        const parsed = researchOutputSchema.safeParse(JSON.parse(structured));
        if (parsed.success) return foldResearchOutput(parsed.data);
      } catch { /* not JSON — fall through to text */ }
    }
    // Agent message may itself be a JSON object even without a schema.
    const message = unwrapLastAgentMessage(raw);
    if (message) {
      try {
        const parsed = researchOutputSchema.safeParse(JSON.parse(message));
        if (parsed.success) return foldResearchOutput(parsed.data);
      } catch { /* not JSON */ }
    }
    // Fallback: text-based STATUS parsing. Tolerates markdown prefixes.
    const text = (structured ?? message ?? raw).trim();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = (lines[i] ?? "").trim().match(/^(?:#+\s*|\*+\s*)?STATUS:\s*\*?([a-z_]+)/i);
      if (!m) continue;
      const status = m[1].toLowerCase();
      if (status === "completed" || status === "clarification_needed" || status === "failed") {
        return { status, body: lines.slice(i + 1).join("\n").trim() };
      }
    }
    return { status: "failed", body: text };
  }

  extractUsage(raw: string, _structured: string | null): PhaseUsage | null {
    if (!raw.trim()) return null;
    let input = 0, cached = 0, output = 0, turns = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    let wallClockMs: number | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const ts = parseEventTs(event);
        if (ts != null) {
          if (firstTs == null) firstTs = ts;
          lastTs = ts;
        }
        if (event?.type === "turn.completed" && event.usage) {
          const totalInput = numOr0(event.usage.input_tokens);
          const cachedInput = numOr0(event.usage.cached_input_tokens);
          // Codex reports cached input as a subset of input_tokens.
          input  += Math.max(0, totalInput - cachedInput);
          cached += cachedInput;
          output += numOr0(event.usage.output_tokens);
          turns  += 1;
        }
        // Synthetic event written by the wrapper script — see buildPhaseScript.
        if (event?.type === "phase.duration" && typeof event.duration_ms === "number") {
          wallClockMs = event.duration_ms;
        }
      } catch { /* ignore non-JSON lines */ }
    }
    if (turns === 0) return null;
    const eventDurationMs = firstTs != null && lastTs != null && lastTs > firstTs ? lastTs - firstTs : 0;
    return {
      cost_usd: null,
      tokens: { input, cached_input: cached, output },
      duration_ms: eventDurationMs > 0 ? eventDurationMs : (wallClockMs ?? 0),
      duration_api_ms: 0,
      num_turns: turns,
    };
  }

  // --- private helpers ---

  private async writeCommitGuardScript(sandbox: RunnableSandbox): Promise<void> {
    // Codex's Stop hook protocol (verified against developers.openai.com/codex/hooks):
    //   - input on stdin includes `stop_hook_active: true` on re-entry
    //   - to FORCE Codex to keep working: print {"decision":"block","reason":"..."}
    //     to stdout, exit 0. (The "continue:false / stopReason" shape stops the
    //     hook itself, NOT Codex — wrong for this use case.)
    await sandbox.runCommand("bash", [
      "-c",
      [
        "mkdir -p ~/.codex/hooks",
        "cat > ~/.codex/hooks/commit-guard.sh << 'SCRIPT'",
        "#!/bin/bash",
        "input=$(cat)",
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        buildCommitGuardCheckScript({
          manifestPath: WORKSPACE_MANIFEST_PATH,
          ignoredDirs: [".codex"],
        }),
        `if [ -n "$changes" ]; then`,
        `  printf '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}\\n'`,
        "  exit 0",
        "fi",
        "exit 0",
        "SCRIPT",
        "chmod +x ~/.codex/hooks/commit-guard.sh",
      ].join("\n"),
    ]);
  }

  private async mergeHooks(
    sandbox: RunnableSandbox,
    opts: { commitGuard?: "enable" | "disable"; arthur?: "install" },
  ): Promise<void> {
    // Codex hooks.json shape (matches Claude's settings.json):
    //   { "hooks": { "Event": [ { "matcher": "...", "hooks": [{type,command}] } ] } }
    const arthurEvents = JSON.stringify(ARTHUR_HOOK_EVENTS);
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      const opts = ${JSON.stringify(opts)};
      const arthurEvents = ${arthurEvents};
      const home = process.env.HOME;
      const cfgPath = path.join(home, '.codex', 'hooks.json');
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      let s = {};
      try { s = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
      s.hooks = s.hooks || {};

      const upsert = (event, matcher, command) => {
        const groups = s.hooks[event] || [];
        const has = groups.some(g => Array.isArray(g?.hooks) && g.hooks.some(h => h?.command === command));
        if (!has) groups.push({ matcher, hooks: [{ type: 'command', command }] });
        s.hooks[event] = groups;
      };
      const remove = (event, predicate) => {
        const groups = s.hooks[event] || [];
        s.hooks[event] = groups
          .map(g => ({ ...g, hooks: (g?.hooks || []).filter(h => !predicate(h?.command || '')) }))
          .filter(g => (g.hooks || []).length > 0);
      };

      if (opts.commitGuard === 'enable') upsert('Stop', '', 'bash $HOME/.codex/hooks/commit-guard.sh');
      else if (opts.commitGuard === 'disable') remove('Stop', c => c.includes('commit-guard.sh'));

      if (opts.arthur === 'install') {
        for (const [event, arg] of arthurEvents) {
          upsert(event, '', 'python3 "$HOME/.codex/hooks/claude_code_tracer.py" ' + arg);
        }
      }
      fs.writeFileSync(cfgPath, JSON.stringify(s, null, 2));
    `;
    await sandbox.runCommand("node", ["--input-type=module", "-e", script]);
  }

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
    if (pip.exitCode !== 0) { logger.warn({}, "arthur_pip_install_failed"); return; }

    const tracerBytes = Buffer.from(ARTHUR_TRACER_PY_BASE64, "base64");
    await sandbox.writeFiles([{ path: "/tmp/arthur-tracer.py", content: tracerBytes }]);
    const mvTracer = await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.codex/hooks && mv /tmp/arthur-tracer.py $HOME/.codex/hooks/claude_code_tracer.py && chmod +x $HOME/.codex/hooks/claude_code_tracer.py",
    ]);
    if (mvTracer.exitCode !== 0) { logger.warn({}, "arthur_tracer_install_failed"); return; }

    // The bundled tracer's discover_config() reads GENAI_ENGINE_* env vars
    // first (wired via /tmp/agent-env.sh), then ~/.claude/arthur_config.json.
    // Mirror the file at both ~/.claude and ~/.codex so file-discovery works
    // regardless of how the hook subprocess is launched.
    const configJson = JSON.stringify(
      { api_key: arthur.apiKey, task_id: arthur.taskId, endpoint: arthur.endpoint }, null, 2,
    );
    await sandbox.writeFiles([{ path: "/tmp/arthur_config.json", content: Buffer.from(configJson) }]);
    await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.claude $HOME/.codex && cp /tmp/arthur_config.json $HOME/.claude/arthur_config.json && mv /tmp/arthur_config.json $HOME/.codex/arthur_config.json && chmod 600 $HOME/.claude/arthur_config.json $HOME/.codex/arthur_config.json",
    ]);

    await this.mergeHooks(sandbox, { arthur: "install" });
    logger.info({ agent: this.kind }, "agent_install_arthur_complete");
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

function numOr0(x: unknown): number { return typeof x === "number" ? x : 0; }

/** Walk Codex NDJSON in reverse for the last agent-message `item.completed` event. */
function unwrapLastAgentMessage(raw: string): string | null {
  if (!raw.trim()) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type !== "item.completed" || !event.item) continue;
      // Filter by item.type to avoid picking up tool-call results that also
      // carry `text`. Codex emits `agent_message` for the assistant's reply.
      if (event.item.type && event.item.type !== "agent_message") continue;
      if (typeof event.item.text === "string") return event.item.text;
      if (typeof event.item.content === "string") return event.item.content;
    } catch { /* not JSON */ }
  }
  return null;
}

/** Best-effort timestamp extraction from a Codex NDJSON event. Returns ms since epoch or null. */
function parseEventTs(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  for (const key of ["timestamp", "ts", "time"]) {
    const v = e[key];
    if (typeof v === "string") {
      const n = Date.parse(v);
      if (!Number.isNaN(n)) return n;
    } else if (typeof v === "number") {
      return v > 1e12 ? v : v * 1000;
    }
  }
  return null;
}
