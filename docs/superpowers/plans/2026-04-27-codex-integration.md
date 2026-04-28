# Codex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI's Codex CLI as a second agent runtime alongside Claude Code, env-switched via `AGENT_KIND=claude|codex`, with full feature parity (skills, commit-guard, Arthur tracing, structured output, usage reporting).

**Architecture:** Introduce a thin `AgentAdapter` interface in `src/sandbox/agents/`. Refactor existing Claude logic into `ClaudeAgentAdapter`. Add `CodexAgentAdapter` that wraps `codex exec --json --output-schema`. `SandboxManager` becomes thin and orchestrator-only. Workflow code threads the adapter through phase steps without changing shape.

**Tech Stack:** TypeScript / Node 24 / Vercel Sandbox / Vercel Workflow / Vitest / Zod / `@anthropic-ai/claude-code` / `@openai/codex` (new) / LiteLLM model pricing JSON (new).

**Source spec:** `docs/superpowers/specs/2026-04-27-codex-integration-design.md`.

---

## Phase 1 — Refactor (Claude only, no Codex yet)

Goal: extract the Claude-specific bits behind an `AgentAdapter`. Existing tests + the e2e Claude path keep passing. Ship as one logical commit at the end of Phase 1.

### Task 1: Scaffold `agents/types.ts` — interface + shared types

**Files:**
- Create: `src/sandbox/agents/types.ts`

- [ ] **Step 1: Write the types module**

```ts
// src/sandbox/agents/types.ts
import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { z } from "zod";

export type PhaseKind = "research" | "impl" | "review";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

/** Minimal interface for sandbox objects that support runCommand and writeFiles. */
export interface RunnableSandbox {
  runCommand: SandboxInstance["runCommand"];
  writeFiles: SandboxInstance["writeFiles"];
}

// --- Schemas (moved from src/sandbox/agent-runner.ts) ---

export const agentOutputSchema = z.object({
  result: z.enum(["implemented", "clarification_needed", "failed"]),
  summary: z.string().optional(),
  questions: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

export const AGENT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: { type: "string", enum: ["implemented", "clarification_needed", "failed"] },
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["result"],
});

export const reviewOutputSchema = z.object({
  result: z.enum(["approved", "failed"]),
  feedback: z.string(),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["critical", "suggestion"]),
  })),
  error: z.string().optional(),
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
      },
    },
    error: { type: "string" },
  },
  required: ["result", "feedback", "issues"],
});

export type ResearchStatus = "completed" | "clarification_needed" | "failed";
export interface ResearchResult { status: ResearchStatus; body: string; }

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
  claudeCodeOauthToken?: string;
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
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS (file is types-only, no behavior; new dir does not break anything yet).

- [ ] **Step 3: Commit (deferred — see Phase 1 commit at the end)**

---

### Task 2: Move shared install logic into `agents/shared.ts`

**Files:**
- Create: `src/sandbox/agents/shared.ts`
- Create: `src/sandbox/agents/shared.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/sandbox/agents/shared.test.ts
import { describe, it, expect, vi } from "vitest";
import { GLOBAL_SKILLS, installSkillsToAgentsDir } from "./shared.js";

describe("GLOBAL_SKILLS", () => {
  it("contains the expected skill repos", () => {
    const ids = GLOBAL_SKILLS.map((s) => `${s.repo}#${s.skill}`);
    expect(ids).toContain("https://github.com/obra/superpowers#using-superpowers");
    expect(ids).toContain("https://github.com/obra/superpowers#requesting-code-review");
    expect(ids).toContain("https://github.com/anthropics/skills#frontend-design");
  });
});

describe("installSkillsToAgentsDir", () => {
  it("runs `npx skills add <repo> --skill <skill> --target ~/.agents/skills` for each entry", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const sandbox = { runCommand, writeFiles } as any;

    await installSkillsToAgentsDir(sandbox);

    const calls = runCommand.mock.calls.filter((c) => c[0] === "npx");
    expect(calls).toHaveLength(GLOBAL_SKILLS.length);
    for (const [_, args] of calls) {
      expect(args).toContain("skills");
      expect(args).toContain("add");
      expect(args).toContain("--target");
      expect(args).toContain("$HOME/.agents/skills");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sandbox/agents/shared.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the shared module**

```ts
// src/sandbox/agents/shared.ts
import type { RunnableSandbox } from "./types.js";

/**
 * Skills installed globally in every sandbox under ~/.agents/skills/.
 * Both adapters read from this single path; Claude additionally symlinks
 * ~/.claude/skills → ~/.agents/skills so its auto-discovery finds the same content.
 */
export const GLOBAL_SKILLS = [
  { repo: "https://github.com/obra/superpowers", skill: "using-superpowers" },
  { repo: "https://github.com/obra/superpowers", skill: "requesting-code-review" },
  { repo: "https://github.com/anthropics/skills", skill: "frontend-design" },
] as const;

/**
 * Install every entry in GLOBAL_SKILLS into ~/.agents/skills inside a sandbox.
 *
 * Uses `--target` so both Claude (~/.claude/skills via symlink) and Codex
 * (native ~/.agents/skills) read the same set without duplication.
 */
export async function installSkillsToAgentsDir(sandbox: RunnableSandbox): Promise<void> {
  await sandbox.runCommand("bash", ["-c", "mkdir -p $HOME/.agents/skills"]);
  for (const { repo, skill } of GLOBAL_SKILLS) {
    await sandbox.runCommand("npx", [
      "-y", "skills", "add", repo,
      "--skill", skill,
      "--yes",
      "--target", "$HOME/.agents/skills",
    ]);
  }
}

/** Bash body for the commit-guard hook. The output protocol differs between agents,
 *  so each adapter wraps this differently. */
export const COMMIT_GUARD_CHECK_SH = [
  "input=$(cat)",
  // Skip when re-entered (set by Claude as stop_hook_active, by us as already_blocked for Codex)
  `if echo "$input" | grep -q -E '"stop_hook_active":true|"already_blocked":true'; then exit 0; fi`,
  // Ignore changes inside ~/.claude/ or ~/.codex/ inside the workspace
  `changes=$(git status --porcelain | grep -v -E '^.. \\.(claude|codex)/' | grep -v -E '^\\?\\? \\.(claude|codex)/' || true)`,
].join("\n");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/sandbox/agents/shared.test.ts`
Expected: PASS.

---

### Task 3: Implement `agents/claude.ts` — Claude adapter

**Files:**
- Create: `src/sandbox/agents/claude.ts`
- Create: `src/sandbox/agents/claude.test.ts`

This task moves three families of code into the Claude adapter:

1. The wrapper script body from `src/sandbox/wrapper-script.ts` → `buildPhaseScript()`.
2. The parsers (`parseAgentOutput`, `parseResearchStatus`, `parseReviewOutput`) and `extractUsage` from `src/sandbox/agent-runner.ts` and `src/sandbox/usage.ts` → adapter methods that ignore the `structured` argument.
3. Provisioning side effects (`installArthurTracer`, `configureStopHookInSandbox`, skill install) from `src/sandbox/manager.ts` → `install()`, `configure()`, `setCommitGuard()`.

- [ ] **Step 1: Write `claude.test.ts` covering parsers + buildPhaseScript + setCommitGuard**

Note: parser test cases are copied verbatim from `src/sandbox/agent-runner.test.ts` and `src/sandbox/usage.test.ts`. Recreate the same coverage so old behaviour is preserved.

```ts
// src/sandbox/agents/claude.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeAgentAdapter } from "./claude.js";

const adapter = new ClaudeAgentAdapter();

describe("ClaudeAgentAdapter.parseAgentOutput", () => {
  it("parses implemented result", () => {
    const raw = JSON.stringify({ result: "implemented", summary: "done" });
    expect(adapter.parseAgentOutput(raw, null).result).toBe("implemented");
  });

  it("parses structured_output from result envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "freeform text",
      structured_output: { result: "implemented", summary: "Renamed endpoint" },
    });
    expect(adapter.parseAgentOutput(envelope, null).summary).toBe("Renamed endpoint");
  });

  it("returns failed on empty output", () => {
    expect(adapter.parseAgentOutput("", null).result).toBe("failed");
  });

  it("returns failed on garbage", () => {
    const out = adapter.parseAgentOutput("not json at all", null);
    expect(out.result).toBe("failed");
    expect(out.error).toContain("not structured JSON");
  });

  it("ignores the structured argument (Claude embeds output in raw)", () => {
    // Claude never receives a separate structured file; the structured arg is null in production.
    const raw = JSON.stringify({ result: "implemented", summary: "via raw" });
    expect(adapter.parseAgentOutput(raw, "ignored payload").summary).toBe("via raw");
  });
});

describe("ClaudeAgentAdapter.parseResearchStatus", () => {
  it("parses a STATUS line and returns the body", () => {
    // Claude wraps research output in a result envelope; parseResearchStatus must unwrap.
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "STATUS: completed\n\nPlan body here",
    });
    const r = adapter.parseResearchStatus(envelope, null);
    expect(r.status).toBe("completed");
    expect(r.body).toBe("Plan body here");
  });

  it("falls back to failed when no STATUS line is present", () => {
    expect(adapter.parseResearchStatus("no status here", null).status).toBe("failed");
  });
});

describe("ClaudeAgentAdapter.parseReviewOutput", () => {
  it("parses approved with empty issues", () => {
    const raw = JSON.stringify({ result: "approved", feedback: "looks good", issues: [] });
    expect(adapter.parseReviewOutput(raw, null).result).toBe("approved");
  });

  it("returns failed on empty input", () => {
    expect(adapter.parseReviewOutput("", null).result).toBe("failed");
  });
});

describe("ClaudeAgentAdapter.extractUsage", () => {
  it("extracts cost_usd from a result envelope", () => {
    const raw = JSON.stringify({
      type: "result", subtype: "success",
      cost_usd: 0.42, duration_ms: 60_000, duration_api_ms: 30_000, num_turns: 3,
      result: "ok",
    });
    const u = adapter.extractUsage(raw, null);
    expect(u).toEqual({
      cost_usd: 0.42,
      tokens: null,
      duration_ms: 60_000,
      duration_api_ms: 30_000,
      num_turns: 3,
    });
  });

  it("returns null when no envelope is present", () => {
    expect(adapter.extractUsage("not json", null)).toBeNull();
  });
});

describe("ClaudeAgentAdapter.buildPhaseScript", () => {
  it("emits a script that sources agent-env.sh and invokes claude", () => {
    const paths = adapter.artifactPaths("research");
    const s = adapter.buildPhaseScript({ phase: "research", model: "claude-opus-4-6", paths });
    expect(s).toContain("#!/bin/bash");
    expect(s).toContain("claude");
    expect(s).toContain("--model 'claude-opus-4-6'");
    expect(s).toContain("--output-format json");
    expect(s).toContain("/tmp/research-requirements.md");
    expect(s).toContain("/tmp/research-stdout.txt");
    expect(s).toContain("/tmp/research-stderr.txt");
    expect(s).toContain("/tmp/research-done");
    expect(s).not.toContain("--json-schema");
  });

  it("includes --json-schema when jsonSchema is supplied", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({
      phase: "impl",
      model: "claude-opus-4-6",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(s).toContain("--json-schema");
  });
});

describe("ClaudeAgentAdapter.artifactPaths", () => {
  it("returns Claude paths with structuredOutput=null", () => {
    expect(adapter.artifactPaths("research")).toEqual({
      wrapper: "/tmp/research-wrapper.sh",
      input: "/tmp/research-requirements.md",
      stdout: "/tmp/research-stdout.txt",
      stderr: "/tmp/research-stderr.txt",
      sentinel: "/tmp/research-done",
      structuredOutput: null,
    });
  });
});

describe("ClaudeAgentAdapter.setCommitGuard", () => {
  it("upserts the Stop hook when enabled and writes commit-guard.sh", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const sandbox = { runCommand, writeFiles } as any;

    await adapter.setCommitGuard(sandbox, true);

    const calls = runCommand.mock.calls;
    // Writes the guard script
    expect(calls.some(([cmd, args]) => cmd === "bash" && args[1].includes("commit-guard.sh"))).toBe(true);
    // Toggles via node merge script
    const mergeCall = calls.find(([cmd, args]) =>
      cmd === "node" && args[1] === "-e" && args[2].includes('"commitGuard":"enable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("disables by writing commitGuard=disable directive", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;

    await adapter.setCommitGuard(sandbox, false);

    const mergeCall = runCommand.mock.calls.find(([cmd, args]) =>
      cmd === "node" && typeof args[2] === "string" && args[2].includes('"commitGuard":"disable"'),
    );
    expect(mergeCall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sandbox/agents/claude.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `claude.ts`**

```ts
// src/sandbox/agents/claude.ts
import type {
  AgentAdapter, AgentOutput, ConfigureOpts, PhaseArtifactPaths, PhaseKind,
  PhaseScriptOpts, PhaseUsage, ResearchResult, ReviewOutput, RunnableSandbox,
} from "./types.js";
import { agentOutputSchema, reviewOutputSchema } from "./types.js";
import { installSkillsToAgentsDir } from "./shared.js";
import { ARTHUR_TRACER_PY_BASE64 } from "../arthur-tracer.js";

const ARTHUR_HOOK_EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["UserPromptSubmit", "user_prompt_submit"],
  ["PreToolUse", "pre_tool"],
  ["PostToolUse", "post_tool"],
  ["PostToolUseFailure", "post_tool_failure"],
  ["Stop", "stop"],
];

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly kind = "claude" as const;

  async install(sandbox: RunnableSandbox): Promise<void> {
    await sandbox.runCommand("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
    // Skip interactive onboarding
    await sandbox.runCommand("bash", [
      "-c",
      `mkdir -p ~/.claude && echo '{"hasCompletedOnboarding":true}' > ~/.claude.json`,
    ]);
  }

  async configure(sandbox: RunnableSandbox, opts: ConfigureOpts): Promise<void> {
    if (!opts.anthropicApiKey && !opts.claudeCodeOauthToken) {
      throw new Error("ClaudeAgentAdapter.configure requires anthropicApiKey or claudeCodeOauthToken");
    }
    const envLines: string[] = [];
    if (opts.claudeCodeOauthToken) {
      envLines.push(`export CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(opts.claudeCodeOauthToken)}`);
    } else if (opts.anthropicApiKey) {
      envLines.push(`export ANTHROPIC_API_KEY=${shellQuote(opts.anthropicApiKey)}`);
    }
    await sandbox.writeFiles([
      { path: "/tmp/agent-env.sh", content: Buffer.from(envLines.join("\n") + "\n") },
    ]);
    await sandbox.runCommand("chmod", ["600", "/tmp/agent-env.sh"]);

    // Skills: install into ~/.agents/skills, then symlink ~/.claude/skills → ~/.agents/skills
    await installSkillsToAgentsDir(sandbox);
    await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.claude && rm -rf $HOME/.claude/skills && ln -s $HOME/.agents/skills $HOME/.claude/skills",
    ]);

    // Arthur tracer (no-op without config)
    if (opts.arthur) {
      await this.installArthurTracer(sandbox, opts.arthur);
    }
  }

  async setCommitGuard(sandbox: RunnableSandbox, enabled: boolean): Promise<void> {
    // 1) Drop the guard script (idempotent)
    await sandbox.runCommand("bash", [
      "-c",
      [
        "mkdir -p ~/.claude",
        "cat > ~/.claude/commit-guard.sh << 'SCRIPT'",
        "#!/bin/bash",
        "input=$(cat)",
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        `changes=$(git status --porcelain | grep -v '^.. \\.claude/' | grep -v '^?? \\.claude/')`,
        `if [ -n "$changes" ]; then`,
        `  echo '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}' >&2`,
        "  exit 2",
        "fi",
        "SCRIPT",
        "chmod +x ~/.claude/commit-guard.sh",
      ].join("\n"),
    ]);

    // 2) Toggle the Stop hook entry via merge-aware settings.json writer
    await this.mergeSettings(sandbox, { commitGuard: enabled ? "enable" : "disable" });
  }

  buildPhaseScript(opts: PhaseScriptOpts): string {
    const { paths, jsonSchema, model, phase } = opts;
    let claudeFlags = `--print --model '${model}' --dangerously-skip-permissions --output-format json`;
    if (jsonSchema) {
      const escapedSchema = jsonSchema.replace(/'/g, "'\\''");
      claudeFlags += ` --json-schema '${escapedSchema}'`;
    }
    return `#!/bin/bash

# --- Cleanup stale files from prior runs ---
rm -f ${paths.sentinel} ${paths.stdout} ${paths.stderr}

# --- Source auth env vars ---
[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh

# --- Phase: ${phase} ---
cat ${paths.input} | claude \\
  ${claudeFlags} \\
  > ${paths.stdout} 2>${paths.stderr}; echo $? > /tmp/${phase}-exit-code || true

# --- Cleanup ---
cd /vercel/sandbox
rm -rf .claude/
git checkout -- .claude/ 2>/dev/null || true

# --- Signal completion ---
touch ${paths.sentinel}
`;
  }

  artifactPaths(phase: PhaseKind): PhaseArtifactPaths {
    return {
      wrapper: `/tmp/${phase}-wrapper.sh`,
      input: `/tmp/${phase}-requirements.md`,
      stdout: `/tmp/${phase}-stdout.txt`,
      stderr: `/tmp/${phase}-stderr.txt`,
      sentinel: `/tmp/${phase}-done`,
      structuredOutput: null,
    };
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
          if (event.subtype === "success" && !event.is_error) {
            return {
              result: "implemented",
              summary: typeof event.result === "string" ? event.result.trim().slice(0, 500) : undefined,
            };
          }
          return {
            result: "failed",
            error: typeof event.result === "string" ? event.result.trim().slice(0, 500) : "Agent returned non-structured result",
          };
        }
        const direct = agentOutputSchema.safeParse(event);
        if (direct.success) return direct.data;
      } catch { /* try next line */ }
    }

    const objects = raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    for (const [candidate] of objects) {
      try {
        const result = agentOutputSchema.safeParse(JSON.parse(candidate));
        if (result.success) return result.data;
      } catch { /* try next */ }
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

    const objects = raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    for (const [candidate] of objects) {
      try {
        const result = reviewOutputSchema.safeParse(JSON.parse(candidate));
        if (result.success) return result.data;
      } catch { /* try next */ }
    }

    return {
      result: "failed", feedback: "", issues: [],
      error: `Review output was not structured JSON. Output starts with: ${raw.slice(0, 500)}`,
    };
  }

  parseResearchStatus(raw: string, _structured: string | null): ResearchResult {
    const text = unwrapResearchEnvelope(raw);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? "";
      const m = line.match(/^STATUS:\s*([a-z_]+)/i);
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
    const envelope = findResultEnvelope(raw);
    if (!envelope) return null;
    const cost =
      typeof envelope.cost_usd === "number" ? envelope.cost_usd
      : typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd
      : null;
    if (cost === null) return null;
    return {
      cost_usd: cost,
      tokens: null,
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
    await sandbox.runCommand("node", ["--input-type=module", "-e", script]);
  }
}

// --- module-private helpers ---

function shellQuote(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
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

function unwrapResearchEnvelope(raw: string): string {
  if (!raw.trim()) return raw;
  const env = findResultEnvelope(raw);
  if (!env) return raw;
  return typeof env.result === "string" ? env.result : raw;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/sandbox/agents/claude.test.ts`
Expected: PASS.

---

### Task 4: Implement `agents/index.ts` — adapter factory

**Files:**
- Create: `src/sandbox/agents/index.ts`
- Create: `src/sandbox/agents/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/sandbox/agents/index.test.ts
import { describe, it, expect } from "vitest";
import { createAgentAdapter } from "./index.js";

describe("createAgentAdapter", () => {
  it("returns ClaudeAgentAdapter for kind=claude", () => {
    const a = createAgentAdapter("claude");
    expect(a.kind).toBe("claude");
  });

  it("throws for unknown kinds (forces exhaustive switch updates)", () => {
    // @ts-expect-error — runtime guard
    expect(() => createAgentAdapter("bogus")).toThrow();
  });
});
```

Note: the `kind=codex` case is added in Task 14 once `CodexAgentAdapter` exists.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sandbox/agents/index.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the factory**

```ts
// src/sandbox/agents/index.ts
import { ClaudeAgentAdapter } from "./claude.js";
import type { AgentAdapter } from "./types.js";

export type AgentKind = "claude" | "codex";

export function createAgentAdapter(kind: AgentKind): AgentAdapter {
  switch (kind) {
    case "claude": return new ClaudeAgentAdapter();
    case "codex":
      throw new Error("Codex adapter not yet wired (see Task 14)");
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown AGENT_KIND: ${_exhaustive}`);
    }
  }
}

export type { AgentAdapter } from "./types.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/sandbox/agents/index.test.ts`
Expected: PASS.

---

### Task 5: Add `collectPhase` helper to `poll-agent.ts`

**Files:**
- Modify: `src/sandbox/poll-agent.ts`
- Modify: `src/sandbox/poll-agent.test.ts`

- [ ] **Step 1: Write the failing test (append to `poll-agent.test.ts`)**

```ts
import { collectPhase } from "./poll-agent.js";

describe("collectPhase", () => {
  it("returns raw + structured when structuredOutput is set", async () => {
    const stdoutText = "ndjson body";
    const structuredText = '{"result":"implemented"}';
    // Mock @vercel/sandbox so Sandbox.get returns a fake with cat
    vi.doMock("@vercel/sandbox", () => ({
      Sandbox: {
        get: vi.fn().mockResolvedValue({
          runCommand: vi.fn().mockImplementation(async (_, args) => {
            const file = args[0];
            const out =
              file.includes("stdout") ? stdoutText :
              file.includes("structured") || file.endsWith("result.json") ? structuredText :
              "";
            return { stdout: async () => out };
          }),
        }),
      },
    }));

    const result = await collectPhase("sbx-1", {
      stdout: "/tmp/impl-stdout.txt",
      stderr: "/tmp/impl-stderr.txt",
      structuredOutput: "/tmp/impl-result.json",
    });
    expect(result.raw).toBe(stdoutText);
    expect(result.structured).toBe(structuredText);
  });

  it("returns structured=null when paths.structuredOutput is null", async () => {
    vi.doMock("@vercel/sandbox", () => ({
      Sandbox: {
        get: vi.fn().mockResolvedValue({
          runCommand: vi.fn().mockResolvedValue({ stdout: async () => "raw text" }),
        }),
      },
    }));
    const r = await collectPhase("sbx-1", {
      stdout: "/tmp/impl-stdout.txt",
      stderr: "/tmp/impl-stderr.txt",
      structuredOutput: null,
    });
    expect(r.structured).toBeNull();
    expect(r.raw).toBe("raw text");
  });

  it("falls back to stderr when stdout is empty", async () => {
    vi.doMock("@vercel/sandbox", () => ({
      Sandbox: {
        get: vi.fn().mockResolvedValue({
          runCommand: vi.fn().mockImplementation(async (_, args) => ({
            stdout: async () => args[0].includes("stdout") ? "" : "stderr text",
          })),
        }),
      },
    }));
    const r = await collectPhase("sbx-1", {
      stdout: "/tmp/impl-stdout.txt",
      stderr: "/tmp/impl-stderr.txt",
      structuredOutput: null,
    });
    expect(r.raw).toBe("stderr text");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sandbox/poll-agent.test.ts`
Expected: FAIL — `collectPhase` not exported.

- [ ] **Step 3: Implement `collectPhase` in `poll-agent.ts`**

Append after `collectPhaseOutput`:

```ts
/**
 * Collect raw + (optional) structured phase output. Replaces collectPhaseOutput
 * in adapter-aware code paths.
 */
export async function collectPhase(
  sandboxId: string,
  paths: { stdout: string; stderr: string; structuredOutput: string | null },
): Promise<{ raw: string; structured: string | null }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [paths.stdout]);
  const stdoutText = (await stdoutResult.stdout()).trim();
  const stderrResult = await sandbox.runCommand("cat", [paths.stderr]);
  const stderrText = (await stderrResult.stdout()).trim();
  const raw = stdoutText || stderrText;

  let structured: string | null = null;
  if (paths.structuredOutput) {
    const r = await sandbox.runCommand("cat", [paths.structuredOutput]);
    const text = (await r.stdout()).trim();
    structured = text || null;
  }
  return { raw, structured };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/sandbox/poll-agent.test.ts`
Expected: PASS.

---

### Task 6: Slim `SandboxManager`

**Files:**
- Modify: `src/sandbox/manager.ts`
- Modify: `src/sandbox/manager.test.ts`

The manager keeps responsibility for the sandbox lifecycle (create, clone, identity, merge, push prep) but delegates anything agent-specific to an injected `AgentAdapter`. After this task: no `GLOBAL_SKILLS`, no `installArthurTracer`, no `configureStopHookInSandbox` exports.

- [ ] **Step 1: Migrate `manager.test.ts` to the new signature**

Keep the lifecycle assertions that still belong to the manager (Sandbox.create source, git identity, optional merge-base, pre-agent-sha capture). Move the agent-specific assertions (auth `agent-env.sh`, commit-guard, Arthur, skills install) — they belong to `claude.test.ts` (already added in Task 3) and aren't valid against the slim manager any more.

Rewrite `src/sandbox/manager.test.ts` so it injects a fake adapter and asserts both the lifecycle and the delegation:

```ts
// src/sandbox/manager.test.ts (rewritten)
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockStdout = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
      stop: mockStop,
    })),
  },
}));

import { SandboxManager } from "./manager.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";

const makeFakeAgent = (): AgentAdapter & { calls: any[] } => {
  const calls: any[] = [];
  return {
    kind: "claude",
    install: vi.fn(async () => { calls.push({ op: "install" }); }),
    configure: vi.fn(async (_, opts: ConfigureOpts) => { calls.push({ op: "configure", opts }); }),
    setCommitGuard: vi.fn(async (_s, enabled) => { calls.push({ op: "guard", enabled }); }),
    buildPhaseScript: () => "#!/bin/bash\necho noop",
    artifactPaths: () => ({ wrapper: "", input: "", stdout: "", stderr: "", sentinel: "", structuredOutput: null }),
    parseAgentOutput: () => ({ result: "implemented" }),
    parseReviewOutput: () => ({ result: "approved", feedback: "", issues: [] }),
    parseResearchStatus: () => ({ status: "completed", body: "" }),
    extractUsage: () => null,
    calls,
  } as any;
};

describe("SandboxManager.provision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCommand.mockResolvedValue({ exitCode: 0, stdout: mockStdout });
    mockStdout.mockResolvedValue("");
    mockWriteFiles.mockResolvedValue(undefined);
  });

  const baseConfig = {
    kind: "github" as const,
    token: "ghp_test",
    repoPath: "test-org/test-repo",
    host: "https://github.com",
    jobTimeoutMs: 1_800_000,
    commitAuthor: "ai-workflow-blazity",
    commitEmail: "bot@blazity.com",
  };

  it("creates the sandbox with a git source pointed at the branch", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" });
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ type: "git", revision: "feat/test-branch" }),
        runtime: "node24",
      }),
    );
  });

  it("sets git identity to commitAuthor / commitEmail", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" });
    const idCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args[1] === "string" && args[1].includes("git config user.name"),
    );
    expect(idCall).toBeDefined();
    expect(idCall![1][1]).toContain("ai-workflow-blazity");
    expect(idCall![1][1]).toContain("bot@blazity.com");
  });

  it("captures pre-agent HEAD SHA for the push step", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" });
    const shaCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args[1] === "string" && args[1].includes("/tmp/.pre-agent-sha"),
    );
    expect(shaCall).toBeDefined();
  });

  it("calls agent.install then agent.configure with the supplied opts", async () => {
    const agent = makeFakeAgent();
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", agent, {
      anthropicApiKey: "sk-ant-test",
      model: "claude-opus-4-6",
    });
    const ops = (agent as any).calls.map((c: any) => c.op);
    expect(ops).toEqual(["install", "configure"]);
    expect((agent as any).calls[1].opts).toEqual(
      expect.objectContaining({ anthropicApiKey: "sk-ant-test", model: "claude-opus-4-6" }),
    );
  });

  it("fetches and merges mergeBase when supplied", async () => {
    const manager = new SandboxManager(baseConfig);
    await manager.provision("feat/test-branch", makeFakeAgent(), { model: "any", anthropicApiKey: "k" }, "main");
    const fetchCall = mockRunCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args[1] === "string" && args[1].includes("git fetch"),
    );
    expect(fetchCall).toBeDefined();
    expect(fetchCall![1][1]).toContain("main");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sandbox/manager.test.ts`
Expected: FAIL — new signature not in place.

- [ ] **Step 3: Rewrite `manager.ts` to thin orchestrator**

Replace the entire file. The new manager has only repo provisioning duties:

```ts
// src/sandbox/manager.ts
import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";

export interface SandboxConfig {
  kind: "github" | "gitlab";
  token: string;
  repoPath: string;
  host: string;
  jobTimeoutMs: number;
  commitAuthor: string;
  commitEmail: string;
}

/** Build clone/push URLs for the configured VCS. Unchanged from previous behaviour. */
export function buildVcsUrls(config: { kind: "github" | "gitlab"; token: string; repoPath: string; host: string }) {
  const host = config.host.replace(/\/+$/, "");
  const scheme = host.match(/^https?:\/\//)?.[0] ?? "https://";
  const hostNoScheme = host.replace(/^https?:\/\//, "");
  const authUser = config.kind === "gitlab" ? "oauth2" : "x-access-token";
  return {
    cloneUrl: `${host}/${config.repoPath}.git`,
    authUrl: `${scheme}${authUser}:${config.token}@${hostNoScheme}/${config.repoPath}.git`,
    authUser,
  };
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provision(
    branch: string,
    agent: AgentAdapter,
    configureOpts: ConfigureOpts,
    mergeBase?: string,
  ): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");
    const urls = buildVcsUrls(this.config);

    const sandbox = await Sandbox.create({
      ...getSandboxCredentials(),
      source: {
        type: "git",
        url: urls.cloneUrl,
        username: urls.authUser,
        password: this.config.token,
        revision: branch,
      },
      runtime: "node24",
      timeout: this.config.jobTimeoutMs,
    });

    // Strip auth from origin
    await sandbox.runCommand("git", ["remote", "set-url", "origin", urls.cloneUrl]);
    // Re-create the local branch (clone is detached HEAD on a revision)
    await sandbox.runCommand("git", ["checkout", "-B", branch]);
    // Identity
    await sandbox.runCommand("bash", [
      "-c",
      `git config user.name "${this.config.commitAuthor}" && git config user.email "${this.config.commitEmail}"`,
    ]);

    if (mergeBase) {
      const repoUrl = urls.authUrl;
      await sandbox.runCommand("bash", ["-c", `git fetch "${repoUrl}" ${mergeBase} 2>&1`]);
      await sandbox.runCommand("bash", ["-c", `git branch ${mergeBase} FETCH_HEAD 2>/dev/null || true`]);
      const merge = await sandbox.runCommand("bash", ["-c", `git merge FETCH_HEAD --no-edit 2>&1`]);
      if (merge.exitCode !== 0) {
        const out = (await merge.stdout()).trim();
        const { logger } = await import("../lib/logger.js");
        logger.warn({ mergeBase, exitCode: merge.exitCode, output: out.slice(0, 500) }, "merge_conflicts_during_provision");
      }
    }

    // Pre-agent SHA so push step can detect commits
    await sandbox.runCommand("bash", ["-c", "git rev-parse HEAD > /tmp/.pre-agent-sha"]);

    // --- Agent-specific work delegated to the adapter ---
    await agent.install(sandbox);
    await agent.configure(sandbox, configureOpts);

    return sandbox;
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try { await sandbox.stop(); } catch { /* non-critical */ }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/sandbox/manager.test.ts`
Expected: PASS.

---

### Task 7: Update `src/workflows/agent.ts` to use the adapter

**Files:**
- Modify: `src/workflows/agent.ts`

Threaded changes:
- `provisionSandbox` builds the adapter, returns `{ sandboxId, agentKind }` (persist `agentKind` so downstream steps reconstruct via `createAgentAdapter(agentKind)`).
- `configureStopHook` step → `setCommitGuardStep(sandboxId, agentKind, enabled)`.
- `writeAndStartPhase` callers swap to adapter paths + adapter `buildPhaseScript`.
- `collectPhaseOutput` → `collectPhase`.
- `extractUsage`, `parseResearchStatus`, `parseAgentOutput`, `parseReviewOutput`, `unwrapResearchText` calls move to `agent.X(...)`.
- The `import buildPhaseScript from "../sandbox/wrapper-script"` line is deleted.
- The `import { ... } from "../sandbox/agent-runner"` line is deleted.

- [ ] **Step 1: Replace `provisionSandbox` and `configureStopHook` step bodies**

```ts
// near top — keep type imports updated
import type { AgentOutput, ReviewOutput, PhaseUsage } from "../sandbox/agents/types.js";
import type { AgentKind } from "../sandbox/agents/index.js";

async function provisionSandbox(
  branchName: string,
  arthurTaskId: string | null,
  mergeBase?: string,
): Promise<{ sandboxId: string; agentKind: AgentKind }> {
  "use step";
  const { env, getVcsConfig } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const vcs = getVcsConfig();

  if (vcs.kind === "gitlab" && /^\d+$/.test(vcs.repoPath)) {
    throw new Error(
      `GITLAB_PROJECT_ID must be a namespace/project path (e.g. "group/repo"), ` +
        `not a numeric project ID ("${vcs.repoPath}").`,
    );
  }

  const arthur =
    env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TRACE_ENDPOINT && arthurTaskId
      ? { apiKey: env.GENAI_ENGINE_API_KEY, taskId: arthurTaskId, endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT }
      : undefined;

  const agentKind: AgentKind = env.AGENT_KIND;     // Will be set by Task 11; default 'claude' until then
  const agent = createAgentAdapter(agentKind);

  const manager = new SandboxManager({
    kind: vcs.kind,
    token: vcs.token,
    repoPath: vcs.repoPath,
    host: vcs.host,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
  });

  const sandbox = await manager.provision(branchName, agent, {
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    codexApiKey: env.CODEX_API_KEY,                   // unset until Task 11
    codexChatGptOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN, // unset until Task 11
    model: agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
    arthur,
  }, mergeBase);

  return { sandboxId: sandbox.sandboxId, agentKind };
}
provisionSandbox.maxRetries = 0;

async function setCommitGuardStep(sandboxId: string, agentKind: AgentKind, enabled: boolean): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind);
  await agent.setCommitGuard(sandbox, enabled);
}
```

Delete the old `configureStopHook` step.

- [ ] **Step 2: Replace per-phase wiring inside `agentWorkflow`**

Update the imports at the top of the workflow:

```ts
const { collectPhase, pushFromSandbox, fixAndRetryPush, teardownSandbox } =
  await import("../sandbox/poll-agent.js");
const { formatUsageReport } = await import("../sandbox/usage.js");
const { createAgentAdapter } = await import("../sandbox/agents/index.js");
const { AGENT_SCHEMA, REVIEW_SCHEMA } = await import("../sandbox/agents/types.js");
```

Delete the old imports:
- `buildPhaseScript` from `../sandbox/wrapper-script.js`
- `parseResearchStatus, parseAgentOutput, parseReviewOutput` from `../sandbox/agent-runner.js`
- `extractUsage, unwrapResearchText` from `../sandbox/usage.js`

Inside `agentWorkflow`, after `provisionSandbox`:

```ts
const { sandboxId, agentKind } = await provisionSandbox(branchName, arthurTaskId, mergeBase);
await registerTicketSandbox(ticket.identifier, sandboxId);

const agent = createAgentAdapter(agentKind);   // local handle for parsers + buildPhaseScript
```

Each phase block changes from "build script with `buildPhaseScript(...)`" to "build script with `agent.buildPhaseScript({ phase, model, paths, jsonSchema })`" and uses `agent.artifactPaths(phase)`. Example for research:

```ts
// ========== PHASE 1: Research & Plan ==========
await setCommitGuardStep(sandboxId, agentKind, false);

const researchPaths = agent.artifactPaths("research");
const researchInput = assembleResearchPlanContext({ /* unchanged */ });
const researchScript = agent.buildPhaseScript({
  phase: "research",
  model: agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
  paths: researchPaths,
});

await writeAndStartPhase(
  sandboxId,
  researchPaths.input, researchInput,
  researchPaths.wrapper, researchScript,
);

const researchDone = await pollUntilDone(sandboxId, researchPaths.sentinel, 20);
if (!researchDone) { /* same backlog/notify path as before */ }

const { raw: researchRaw, structured: researchStructured } =
  await collectPhase(sandboxId, researchPaths);
phaseUsages["Research"] = agent.extractUsage(researchRaw, researchStructured);
const research = agent.parseResearchStatus(researchRaw, researchStructured);
```

Implementation phase block (full replacement):

```ts
// ========== PHASE 2: Implementation ==========
await setCommitGuardStep(sandboxId, agentKind, true);

const implPaths = agent.artifactPaths("impl");
const implInput = assembleImplementationContext({
  ticket: ticketData,
  prompt: prompts.implement,
  researchPlanMarkdown,
  attachments: downloadedAttachments,
});
const implScript = agent.buildPhaseScript({
  phase: "impl",
  model: agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL,
  paths: implPaths,
  jsonSchema: AGENT_SCHEMA,
});

await writeAndStartPhase(
  sandboxId,
  implPaths.input, implInput,
  implPaths.wrapper, implScript,
);

const implDone = await pollUntilDone(sandboxId, implPaths.sentinel, 35);
let implOutput: AgentOutput;
if (implDone) {
  const { raw, structured } = await collectPhase(sandboxId, implPaths);
  phaseUsages["Impl"] = agent.extractUsage(raw, structured);
  implOutput = agent.parseAgentOutput(raw, structured);
} else {
  implOutput = { result: "failed", error: "Implementation phase timed out" };
}
// (existing branches on implOutput.result are untouched)
```

For the disabled review block (lines around `// ========== PHASE 3: Review ==========`), update its structure to mirror the impl block (`agent.artifactPaths("review")`, `agent.buildPhaseScript({ phase: "review", paths, jsonSchema: REVIEW_SCHEMA })`, `agent.parseReviewOutput(raw, structured)`) so re-enabling later is a single comment toggle.

Replace `setCommitGuardStep(sandboxId, agentKind, true)` everywhere `await configureStopHook(sandboxId, true)` appeared.

- [ ] **Step 3: Update the usage suffix call site**

`formatUsageReport` will gain an optional `priceLookup` argument in Task 8. For Phase 1 the workflow keeps the existing single-arg call: `formatUsageReport(phaseUsages)`.

- [ ] **Step 4: Run the workflow's existing tests**

Run: `pnpm typecheck && pnpm vitest run src/workflows/prompts-step.test.ts`
Expected: PASS — `prompts-step.test.ts` is untouched and `agent.ts` only changed wiring.

---

### Task 8: Update `usage.ts` for the new PhaseUsage shape

**Files:**
- Modify: `src/sandbox/usage.ts`
- Modify: `src/sandbox/usage.test.ts`

The old `extractUsage` and `unwrapResearchText` move into adapters (Task 3), so this file shrinks to `formatUsageReport`. The `PhaseUsage` interface re-exports from `agents/types.ts` for backward-compat imports.

- [ ] **Step 1: Replace `usage.ts`**

```ts
// src/sandbox/usage.ts
import type { PhaseUsage } from "./agents/types.js";
import type { TokenPrice } from "./agents/pricing.js";   // forward-declare; Task 12 creates the file

export type { PhaseUsage } from "./agents/types.js";

export type PriceLookup = (model: string) => TokenPrice | null;

/**
 * Slack-friendly usage line. Computes Codex costs from tokens when a price
 * is available; falls back to "cost unknown" for Codex without pricing.
 *
 * For each phase:
 *   - cost_usd != null → use it directly (Claude path)
 *   - tokens != null + priceLookup yields a price → compute cost
 *   - else → tokens-only, marked "cost unknown"
 */
export function formatUsageReport(
  phases: Record<string, PhaseUsage | null>,
  priceLookup?: PriceLookup,
  model?: string,
): string {
  const parts: string[] = [];
  let totalCost = 0;
  let anyUnknown = false;

  for (const [name, usage] of Object.entries(phases)) {
    if (!usage) { parts.push(`${name}: n/a`); continue; }
    const mins = Math.round(usage.duration_ms / 60_000);
    let costLabel: string;
    if (usage.cost_usd != null) {
      totalCost += usage.cost_usd;
      costLabel = `$${usage.cost_usd.toFixed(2)}`;
    } else if (usage.tokens && priceLookup && model) {
      const price = priceLookup(model);
      if (price) {
        const cost = usage.tokens.input * price.input
                   + usage.tokens.cached_input * price.cached_input
                   + usage.tokens.output * price.output;
        totalCost += cost;
        costLabel = `$${cost.toFixed(2)}`;
      } else {
        anyUnknown = true;
        costLabel = `${usage.tokens.input}/${usage.tokens.output} tok (cost unknown)`;
      }
    } else if (usage.tokens) {
      anyUnknown = true;
      costLabel = `${usage.tokens.input}/${usage.tokens.output} tok (cost unknown)`;
    } else {
      anyUnknown = true;
      costLabel = "cost unknown";
    }
    parts.push(`${name}: ${costLabel} (${mins}m)`);
  }

  const total = anyUnknown ? `$${totalCost.toFixed(2)}+ total` : `$${totalCost.toFixed(2)} total`;
  return `Usage: ${total} | ${parts.join(" | ")}`;
}
```

- [ ] **Step 2: Move `extractUsage` and `unwrapResearchText` tests to `agents/claude.test.ts`** (already done in Task 3).
      Replace `src/sandbox/usage.test.ts` with `formatUsageReport`-only coverage:

```ts
// src/sandbox/usage.test.ts
import { describe, it, expect } from "vitest";
import { formatUsageReport, type PhaseUsage } from "./usage.js";

const u = (over: Partial<PhaseUsage> = {}): PhaseUsage => ({
  cost_usd: null, tokens: null, duration_ms: 60_000, duration_api_ms: 30_000, num_turns: 1, ...over,
});

describe("formatUsageReport", () => {
  it("uses cost_usd when present", () => {
    const out = formatUsageReport({ Impl: u({ cost_usd: 1.23 }) });
    expect(out).toContain("$1.23");
    expect(out).toContain("$1.23 total");
  });

  it("computes cost from tokens + priceLookup when cost_usd is null", () => {
    const out = formatUsageReport(
      { Impl: u({ tokens: { input: 1000, cached_input: 0, output: 500 } }) },
      () => ({ input: 0.000003, cached_input: 0, output: 0.000015 }),
      "gpt-5-codex",
    );
    expect(out).toMatch(/\$0\.0[01]/);
    expect(out).not.toContain("cost unknown");
  });

  it("falls back to tokens-only when no price and tokens are present", () => {
    const out = formatUsageReport(
      { Impl: u({ tokens: { input: 100, cached_input: 0, output: 50 } }) },
      () => null,
      "unknown-model",
    );
    expect(out).toContain("100/50 tok (cost unknown)");
    expect(out).toContain("+ total");
  });

  it("shows n/a for null phases", () => {
    const out = formatUsageReport({ Impl: null });
    expect(out).toContain("Impl: n/a");
  });
});
```

- [ ] **Step 3: Run tests**

Note: `TokenPrice` import will fail until Task 12. Stub it temporarily by adding this line to the top of `usage.ts` (and removing it during Task 12):

```ts
// remove during Task 12 once agents/pricing.ts exists
type TokenPrice = { input: number; cached_input: number; output: number };
```

Then drop the `import type { TokenPrice } from "./agents/pricing.js"` line.

Run: `pnpm vitest run src/sandbox/usage.test.ts`
Expected: PASS.

---

### Task 9: Delete `wrapper-script.ts` + tests

**Files:**
- Delete: `src/sandbox/wrapper-script.ts`
- Delete: `src/sandbox/wrapper-script.test.ts`

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -R "wrapper-script" src/ docs/`
Expected: zero matches in `src/` (the spec file is fine).

- [ ] **Step 2: Delete the files**

```bash
rm src/sandbox/wrapper-script.ts src/sandbox/wrapper-script.test.ts
```

- [ ] **Step 3: Run typecheck + full unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

---

### Task 10: Delete `agent-runner.ts` + tests

**Files:**
- Delete: `src/sandbox/agent-runner.ts`
- Delete: `src/sandbox/agent-runner.test.ts`

The schemas and parsers moved to `agents/types.ts` and `agents/claude.ts`; the test cases moved to `agents/claude.test.ts`. Nothing should still import from this file.

- [ ] **Step 1: Verify no remaining imports**

Run: `grep -R "from .*sandbox/agent-runner" src/`
Expected: zero matches.

- [ ] **Step 2: Delete the files**

```bash
rm src/sandbox/agent-runner.ts src/sandbox/agent-runner.test.ts
```

- [ ] **Step 3: Final Phase 1 build**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — every existing unit test still green; the suite now exercises the adapter abstraction for Claude.

- [ ] **Step 4: Commit Phase 1**

```bash
git add src/sandbox/agents src/sandbox/manager.ts src/sandbox/manager.test.ts \
        src/sandbox/poll-agent.ts src/sandbox/poll-agent.test.ts \
        src/sandbox/usage.ts src/sandbox/usage.test.ts \
        src/workflows/agent.ts
git rm src/sandbox/wrapper-script.ts src/sandbox/wrapper-script.test.ts \
       src/sandbox/agent-runner.ts src/sandbox/agent-runner.test.ts
git commit -m "refactor(sandbox): extract Claude logic behind AgentAdapter interface"
```

---

## Phase 2 — Add the Codex adapter

### Task 11: Add Codex env vars + cross-field validation

**Files:**
- Modify: `env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Extend the schema in `env.ts`**

Add to the `server` block (place after the existing `CLAUDE_MODEL` line):

```ts
// Agent kind selection (claude | codex). Defaults to claude for back-compat.
AGENT_KIND: z.enum(["claude", "codex"]).default("claude"),

// Codex auth — at least one required when AGENT_KIND=codex.
CODEX_API_KEY: z.string().min(1).optional(),
CODEX_CHATGPT_OAUTH_TOKEN: z.string().min(1).optional(),

// Codex model selection.
CODEX_MODEL: z.string().default("gpt-5-codex"),

// LiteLLM community-maintained pricing JSON. Operator overridable.
CODEX_PRICING_URL: z
  .string()
  .url()
  .default("https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"),
CODEX_PRICING_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
```

Inside the cross-field block at the bottom of `env.ts`, add the AGENT_KIND guards next to the VCS_KIND check:

```ts
if (env.AGENT_KIND === "codex" && !env.CODEX_API_KEY && !env.CODEX_CHATGPT_OAUTH_TOKEN) {
  throw new Error(
    "Invalid environment variables:\n" +
      "  AGENT_KIND=codex requires CODEX_API_KEY or CODEX_CHATGPT_OAUTH_TOKEN",
  );
}
if (env.AGENT_KIND === "claude" && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
  throw new Error(
    "Invalid environment variables:\n" +
      "  AGENT_KIND=claude requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN",
  );
}
```

- [ ] **Step 2: Update `.env.example`**

Append (after the existing `CLAUDE_MODEL` block):

```bash
# Agent — choose runtime (claude | codex). Defaults to claude.
AGENT_KIND=claude

# Codex (only when AGENT_KIND=codex)
# CODEX_API_KEY=
# CODEX_CHATGPT_OAUTH_TOKEN=    # alternative to CODEX_API_KEY
# CODEX_MODEL=gpt-5-codex
# CODEX_PRICING_URL=https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
# CODEX_PRICING_TTL_MS=3600000
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS.

---

### Task 12: Implement `agents/pricing.ts`

**Files:**
- Create: `src/sandbox/agents/pricing.ts`
- Create: `src/sandbox/agents/pricing.test.ts`
- Modify: `src/sandbox/usage.ts` (drop the local `TokenPrice` stub from Task 8 and import from pricing)

- [ ] **Step 1: Write the failing test**

```ts
// src/sandbox/agents/pricing.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const SAMPLE = {
  "gpt-5-codex": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000007,
  },
};

describe("fetchModelPrice", () => {
  beforeEach(() => { vi.resetModules(); });

  it("normalises LiteLLM JSON to TokenPrice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => SAMPLE,
    }));
    const { fetchModelPrice } = await import("./pricing.js");
    const p = await fetchModelPrice("gpt-5-codex");
    expect(p).toEqual({ input: 0.000003, cached_input: 0.0000007, output: 0.000015 });
  });

  it("returns null on miss", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const { fetchModelPrice } = await import("./pricing.js");
    expect(await fetchModelPrice("unknown")).toBeNull();
  });

  it("returns null on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { fetchModelPrice } = await import("./pricing.js");
    expect(await fetchModelPrice("any")).toBeNull();
  });

  it("caches successful responses within TTL (one fetch for two calls)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModelPrice } = await import("./pricing.js");
    await fetchModelPrice("gpt-5-codex");
    await fetchModelPrice("gpt-5-codex");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sandbox/agents/pricing.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `pricing.ts`**

```ts
// src/sandbox/agents/pricing.ts
export interface TokenPrice {
  input: number;
  cached_input: number;
  output: number;
}

interface CacheEntry {
  fetchedAt: number;
  data: Record<string, TokenPrice>;
}
let cache: CacheEntry | null = null;

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
}

async function loadAll(): Promise<Record<string, TokenPrice> | null> {
  const { env } = await import("../../../env.js");
  const ttl = env.CODEX_PRICING_TTL_MS;
  if (cache && Date.now() - cache.fetchedAt < ttl) return cache.data;

  try {
    const r = await fetch(env.CODEX_PRICING_URL);
    if (!r.ok) return null;
    const json = await r.json();
    const out: Record<string, TokenPrice> = {};
    for (const [name, entry] of Object.entries(json as Record<string, LiteLLMEntry>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const input = entry.input_cost_per_token;
      const output = entry.output_cost_per_token;
      if (typeof input !== "number" || typeof output !== "number") continue;
      out[name] = {
        input,
        output,
        cached_input: typeof entry.cache_read_input_token_cost === "number"
          ? entry.cache_read_input_token_cost
          : 0,
      };
    }
    cache = { fetchedAt: Date.now(), data: out };
    return out;
  } catch {
    return null;
  }
}

export async function fetchModelPrice(model: string): Promise<TokenPrice | null> {
  const all = await loadAll();
  return all?.[model] ?? null;
}

/** Test-only: clear the in-memory cache. */
export function _resetPricingCache(): void { cache = null; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/sandbox/agents/pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Drop the local `TokenPrice` stub from `usage.ts`**

In `src/sandbox/usage.ts`, replace the inline `type TokenPrice` with:

```ts
import type { TokenPrice } from "./agents/pricing.js";
export type { TokenPrice };
```

Run: `pnpm typecheck && pnpm vitest run src/sandbox/usage.test.ts`
Expected: PASS.

---

### Task 13: Implement `agents/codex.ts` — Codex adapter

**Files:**
- Create: `src/sandbox/agents/codex.ts`
- Create: `src/sandbox/agents/codex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/sandbox/agents/codex.test.ts
import { describe, it, expect, vi } from "vitest";
import { CodexAgentAdapter } from "./codex.js";

const adapter = new CodexAgentAdapter();

describe("CodexAgentAdapter.parseAgentOutput", () => {
  it("prefers structured JSON when valid", () => {
    const structured = JSON.stringify({ result: "implemented", summary: "ok" });
    const out = adapter.parseAgentOutput("ignored ndjson", structured);
    expect(out.result).toBe("implemented");
    expect(out.summary).toBe("ok");
  });

  it("falls back to NDJSON item.completed when structured is missing", () => {
    const ndjson = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: '{"result":"implemented","summary":"foo"}' },
      }),
    ].join("\n");
    const out = adapter.parseAgentOutput(ndjson, null);
    expect(out.result).toBe("implemented");
    expect(out.summary).toBe("foo");
  });

  it("returns failed when both sources are unparseable", () => {
    expect(adapter.parseAgentOutput("not ndjson", null).result).toBe("failed");
  });
});

describe("CodexAgentAdapter.parseResearchStatus", () => {
  it("reads STATUS line from structured (free-form text)", () => {
    const r = adapter.parseResearchStatus("ndjson irrelevant", "STATUS: completed\n\nbody");
    expect(r.status).toBe("completed");
    expect(r.body).toBe("body");
  });

  it("falls back to last item.completed text when structured is null", () => {
    const ndjson = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "STATUS: failed\n\nreason" } }),
    ].join("\n");
    const r = adapter.parseResearchStatus(ndjson, null);
    expect(r.status).toBe("failed");
  });
});

describe("CodexAgentAdapter.extractUsage", () => {
  it("sums usage across multiple turn.completed events", () => {
    const ndjson = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 200, cached_input_tokens: 10 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 75, cached_input_tokens: 5 } }),
    ].join("\n");
    const u = adapter.extractUsage(ndjson, null);
    expect(u).toEqual({
      cost_usd: null,
      tokens: { input: 150, cached_input: 15, output: 275 },
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 2,
    });
  });

  it("returns null when no turn.completed event is present", () => {
    expect(adapter.extractUsage("\n", null)).toBeNull();
  });
});

describe("CodexAgentAdapter.buildPhaseScript", () => {
  it("research phase uses -o without --output-schema", () => {
    const paths = adapter.artifactPaths("research");
    const s = adapter.buildPhaseScript({ phase: "research", model: "gpt-5-codex", paths });
    expect(s).toContain("codex exec");
    expect(s).toContain("--full-auto");
    expect(s).toContain("--skip-git-repo-check");
    expect(s).toContain("--json");
    expect(s).toContain("-o /tmp/research-result.json");
    expect(s).not.toContain("--output-schema");
  });

  it("impl phase uses --output-schema with a heredoc", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({
      phase: "impl",
      model: "gpt-5-codex",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(s).toContain("--output-schema /tmp/impl-schema.json");
    expect(s).toContain("'SCHEMA_EOF'");
  });
});

describe("CodexAgentAdapter.artifactPaths", () => {
  it("includes structuredOutput pointing at -o file", () => {
    expect(adapter.artifactPaths("impl").structuredOutput).toBe("/tmp/impl-result.json");
  });
});

describe("CodexAgentAdapter.setCommitGuard", () => {
  it("upserts the Stop hook in ~/.codex/hooks.json when enabled", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;
    await adapter.setCommitGuard(sandbox, true);
    const merge = runCommand.mock.calls.find(([cmd, args]) =>
      cmd === "node" && typeof args[2] === "string" && args[2].includes('"commitGuard":"enable"'),
    );
    expect(merge).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sandbox/agents/codex.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `codex.ts`**

```ts
// src/sandbox/agents/codex.ts
import type {
  AgentAdapter, AgentOutput, ConfigureOpts, PhaseArtifactPaths, PhaseKind,
  PhaseScriptOpts, PhaseUsage, ResearchResult, ReviewOutput, RunnableSandbox,
} from "./types.js";
import { agentOutputSchema, reviewOutputSchema } from "./types.js";
import { installSkillsToAgentsDir } from "./shared.js";
import { ARTHUR_TRACER_PY_BASE64 } from "../arthur-tracer.js";

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

    // 1) auth env file
    const envLines: string[] = [];
    if (opts.codexApiKey) envLines.push(`export CODEX_API_KEY=${shellQuote(opts.codexApiKey)}`);
    else if (opts.codexChatGptOauthToken) envLines.push(`export CODEX_CHATGPT_OAUTH_TOKEN=${shellQuote(opts.codexChatGptOauthToken)}`);
    await sandbox.writeFiles([{ path: "/tmp/agent-env.sh", content: Buffer.from(envLines.join("\n") + "\n") }]);
    await sandbox.runCommand("chmod", ["600", "/tmp/agent-env.sh"]);

    // 2) ~/.codex/config.toml — minimal model + sandbox profile
    const configToml = [
      `model = "${opts.model}"`,
      `approval_policy = "never"`,
      `sandbox_mode = "workspace-write"`,
    ].join("\n") + "\n";
    await sandbox.writeFiles([{ path: "/tmp/config.toml", content: Buffer.from(configToml) }]);
    await sandbox.runCommand("bash", ["-c", "mkdir -p $HOME/.codex && mv /tmp/config.toml $HOME/.codex/config.toml"]);

    // 3) skills (~/.agents/skills is Codex's native scope)
    await installSkillsToAgentsDir(sandbox);

    // 4) commit-guard script (Codex flavour, JSON-on-stdout)
    await this.writeCommitGuardScript(sandbox);

    // 5) Arthur tracer (no-op if unconfigured)
    if (opts.arthur) await this.installArthurTracer(sandbox, opts.arthur);
  }

  async setCommitGuard(sandbox: RunnableSandbox, enabled: boolean): Promise<void> {
    await this.writeCommitGuardScript(sandbox);   // idempotent
    await this.mergeHooks(sandbox, { commitGuard: enabled ? "enable" : "disable" });
  }

  buildPhaseScript(opts: PhaseScriptOpts): string {
    const { paths, jsonSchema, model, phase } = opts;

    const flags: string[] = [
      `--model "${model}"`,
      `--full-auto`,
      `--skip-git-repo-check`,
      `--json`,
      `-o ${paths.structuredOutput}`,
    ];

    let schemaBlock = "";
    if (jsonSchema) {
      const escapedSchema = jsonSchema.replace(/'/g, "'\\''");
      schemaBlock = [
        `cat > /tmp/${phase}-schema.json << 'SCHEMA_EOF'`,
        escapedSchema,
        "SCHEMA_EOF",
      ].join("\n");
      flags.push(`--output-schema /tmp/${phase}-schema.json`);
    }

    return `#!/bin/bash

# --- Cleanup stale files ---
rm -f ${paths.sentinel} ${paths.stdout} ${paths.stderr} ${paths.structuredOutput}

# --- Source auth env vars ---
[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh

${schemaBlock}

# --- Phase: ${phase} ---
cat ${paths.input} | codex exec \\
  ${flags.join(" \\\n  ")} \\
  - \\
  > ${paths.stdout} 2> ${paths.stderr}; echo $? > /tmp/${phase}-exit-code || true

# --- Cleanup ---
cd /vercel/sandbox
rm -rf .codex/
git checkout -- .codex/ 2>/dev/null || true

touch ${paths.sentinel}
`;
  }

  artifactPaths(phase: PhaseKind): PhaseArtifactPaths {
    return {
      wrapper: `/tmp/${phase}-wrapper.sh`,
      input: `/tmp/${phase}-requirements.md`,
      stdout: `/tmp/${phase}-stdout.txt`,
      stderr: `/tmp/${phase}-stderr.txt`,
      sentinel: `/tmp/${phase}-done`,
      structuredOutput: `/tmp/${phase}-result.json`,
    };
  }

  parseAgentOutput(raw: string, structured: string | null): AgentOutput {
    if (structured) {
      try {
        const parsed = agentOutputSchema.safeParse(JSON.parse(structured));
        if (parsed.success) return parsed.data;
      } catch { /* fall through */ }
    }
    const text = unwrapLastItemCompleted(raw);
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
    const text = unwrapLastItemCompleted(raw);
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
    const text = (structured ?? unwrapLastItemCompleted(raw) ?? raw).trim();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = (lines[i] ?? "").trim().match(/^STATUS:\s*([a-z_]+)/i);
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
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === "turn.completed" && event.usage) {
          input  += numOr0(event.usage.input_tokens);
          cached += numOr0(event.usage.cached_input_tokens);
          output += numOr0(event.usage.output_tokens);
          turns  += 1;
        }
      } catch { /* ignore non-JSON lines */ }
    }
    if (turns === 0) return null;
    return {
      cost_usd: null,
      tokens: { input, cached_input: cached, output },
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: turns,
    };
  }

  // --- private helpers ---

  private async writeCommitGuardScript(sandbox: RunnableSandbox): Promise<void> {
    await sandbox.runCommand("bash", [
      "-c",
      [
        "mkdir -p ~/.codex/hooks",
        "cat > ~/.codex/hooks/commit-guard.sh << 'SCRIPT'",
        "#!/bin/bash",
        "input=$(cat)",
        `if echo "$input" | grep -q '"already_blocked":true'; then echo '{"continue": true}'; exit 0; fi`,
        `changes=$(git status --porcelain | grep -v '^.. \\.codex/' | grep -v '^?? \\.codex/')`,
        `if [ -n "$changes" ]; then`,
        `  printf '{"continue": false, "stopReason": "You have uncommitted changes. Commit them with a descriptive message or revert before stopping."}\\n'`,
        "  exit 0",
        "fi",
        `echo '{"continue": true}'`,
        "SCRIPT",
        "chmod +x ~/.codex/hooks/commit-guard.sh",
      ].join("\n"),
    ]);
  }

  private async mergeHooks(
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
      const cfgPath = path.join(home, '.codex', 'hooks.json');
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      let s = {};
      try { s = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
      s.hooks = s.hooks || {};

      const upsert = (event, command) => {
        const arr = s.hooks[event] || [];
        const has = arr.some(e => e && e.command === command);
        if (!has) arr.push({ type: 'command', command });
        s.hooks[event] = arr;
      };
      const remove = (event, predicate) => {
        const arr = s.hooks[event] || [];
        s.hooks[event] = arr.filter(e => !predicate(e?.command || ''));
      };

      if (opts.commitGuard === 'enable') upsert('Stop', 'bash ~/.codex/hooks/commit-guard.sh');
      else if (opts.commitGuard === 'disable') remove('Stop', c => c.includes('commit-guard.sh'));

      if (opts.arthur === 'install') {
        for (const [event, arg] of arthurEvents) {
          upsert(event, 'python3 "$HOME/.codex/hooks/claude_code_tracer.py" ' + arg);
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

    const configJson = JSON.stringify(
      { api_key: arthur.apiKey, task_id: arthur.taskId, endpoint: arthur.endpoint }, null, 2,
    );
    await sandbox.writeFiles([{ path: "/tmp/arthur_config.json", content: Buffer.from(configJson) }]);
    await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.codex && mv /tmp/arthur_config.json $HOME/.codex/arthur_config.json && chmod 600 $HOME/.codex/arthur_config.json",
    ]);

    await this.mergeHooks(sandbox, { arthur: "install" });
    logger.info({ agent: this.kind }, "agent_install_arthur_complete");
  }
}

// --- module-private helpers ---

function shellQuote(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
}

function numOr0(x: unknown): number { return typeof x === "number" ? x : 0; }

/** Walk Codex NDJSON in reverse for the last `item.completed` event with assistant text. */
function unwrapLastItemCompleted(raw: string): string | null {
  if (!raw.trim()) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event.item) {
        if (typeof event.item.text === "string") return event.item.text;
        if (typeof event.item.content === "string") return event.item.content;
      }
    } catch { /* not JSON */ }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/sandbox/agents/codex.test.ts`
Expected: PASS.

---

### Task 14: Wire Codex into the factory

**Files:**
- Modify: `src/sandbox/agents/index.ts`
- Modify: `src/sandbox/agents/index.test.ts`

- [ ] **Step 1: Update the test**

```ts
// add to src/sandbox/agents/index.test.ts
it("returns CodexAgentAdapter for kind=codex", () => {
  const a = createAgentAdapter("codex");
  expect(a.kind).toBe("codex");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/sandbox/agents/index.test.ts`
Expected: FAIL — current factory throws for codex.

- [ ] **Step 3: Wire Codex**

```ts
// src/sandbox/agents/index.ts
import { ClaudeAgentAdapter } from "./claude.js";
import { CodexAgentAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

export type AgentKind = "claude" | "codex";

export function createAgentAdapter(kind: AgentKind): AgentAdapter {
  switch (kind) {
    case "claude": return new ClaudeAgentAdapter();
    case "codex":  return new CodexAgentAdapter();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown AGENT_KIND: ${_exhaustive}`);
    }
  }
}

export type { AgentAdapter } from "./types.js";
```

- [ ] **Step 4: Run to verify both cases pass**

Run: `pnpm vitest run src/sandbox/agents/index.test.ts`
Expected: PASS.

---

### Task 15: Thread Codex pricing into `formatUsageReport`

**Files:**
- Modify: `src/workflows/agent.ts`

The workflow now resolves a price for the active model once per run and passes it as a closure to `formatUsageReport`.

- [ ] **Step 1: Update the usage suffix construction**

In `agentWorkflow`, replace `formatUsageReport(phaseUsages)` call sites with a helper that resolves price once per run:

```ts
// add inside agentWorkflow, near the top of the try block
const activeModel = agentKind === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
const priceCache = await (async () => {
  if (agentKind !== "codex") return null;
  const { fetchModelPrice } = await import("../sandbox/agents/pricing.js");
  try {
    return await fetchModelPrice(activeModel);
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn({ err: (err as Error).message, model: activeModel }, "pricing_fetch_failed");
    return null;
  }
})();

const priceLookup = priceCache ? () => priceCache : undefined;

const usageSuffix = () =>
  Object.keys(phaseUsages).length
    ? `\n${formatUsageReport(phaseUsages, priceLookup, activeModel)}`
    : "";
```

Replace any other direct `formatUsageReport(phaseUsages)` calls in the file with `formatUsageReport(phaseUsages, priceLookup, activeModel)`.

- [ ] **Step 2: Typecheck + run unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit Phase 2**

```bash
git add env.ts .env.example src/sandbox/agents/codex.ts src/sandbox/agents/codex.test.ts \
        src/sandbox/agents/pricing.ts src/sandbox/agents/pricing.test.ts \
        src/sandbox/agents/index.ts src/sandbox/agents/index.test.ts \
        src/sandbox/usage.ts src/workflows/agent.ts
git commit -m "feat(sandbox): add Codex agent adapter with pricing-aware usage reports"
```

---

## Phase 3 — Codex E2E

### Task 16: Add gated `e2e/codex-tier-1.test.ts`

**Files:**
- Create: `e2e/codex-tier-1.test.ts`
- Modify: `e2e/vitest.e2e.config.ts` (new project entry)

The e2e provisions a sandbox with `AGENT_KIND=codex`, runs the impl phase against a tiny seeded ticket, and asserts a commit + PR. It is skipped unless `CODEX_API_KEY` is set in the environment.

- [ ] **Step 1: Add the test file**

```ts
// e2e/codex-tier-1.test.ts
import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "./helpers/jira.js";
import { findPR, deleteBranch } from "./helpers/github.js";
import { cleanup as redisCleanup } from "./helpers/redis.js";
import { stopSandboxesForTicket } from "./helpers/sandbox.js";
import { waitFor } from "./helpers/wait.js";
import { e2eEnv } from "./env.js";

const HAVE_CODEX = Boolean(process.env.CODEX_API_KEY);
const guard = HAVE_CODEX ? describe : describe.skip;

guard("Codex Tier-1: clear ticket → PR via codex exec", () => {
  let ticketKey: string;
  let branchName: string;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("provisions a Codex sandbox, commits, and opens a PR", async () => {
    // Sanity — the harness must already have AGENT_KIND=codex set in process.env
    expect(process.env.AGENT_KIND).toBe("codex");

    const ticket = await createTestTicket({
      summary: "[E2E codex] Add GET /api/health endpoint",
      description: [
        "Create a GET /api/health route that returns JSON { status: \"ok\" } with HTTP 200.",
        "Acceptance:",
        "- Route file at app/api/health/route.ts",
        "- Returns { status: \"ok\" } with HTTP 200",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // Wait for the workflow to push a commit and open the PR.
    const pr = await waitFor(async () => findPR(branchName), { timeoutMs: 30 * 60_000, intervalMs: 30_000 });
    expect(pr).not.toBeNull();

    // Ticket should land in AI Review.
    await waitFor(async () => {
      const s = await getTicketStatus(ticketKey);
      return s === e2eEnv.COLUMN_AI_REVIEW ? s : null;
    }, { timeoutMs: 5 * 60_000 });
  });
});
```

- [ ] **Step 2: Add a `codex` project entry to `e2e/vitest.e2e.config.ts`**

Append inside `projects: [...]`:

```ts
{
  test: {
    name: "codex",
    include: ["e2e/codex-tier-1.test.ts"],
    testTimeout: 4_200_000,
    hookTimeout: 4_200_000,
  },
},
```

- [ ] **Step 3: Add a script to `package.json`**

```json
"test:e2e:codex": "AGENT_KIND=codex vitest run --config e2e/vitest.e2e.config.ts --project codex"
```

- [ ] **Step 4: Validate manually**

With `CODEX_API_KEY` set in `.env.e2e` (and `AGENT_KIND=codex` for that run):

Run: `pnpm test:e2e:codex`
Expected: PASS — sandbox provisions, the impl phase commits a change, the PR is created. (Manual; do not gate the regular CI on it.)

- [ ] **Step 5: Commit Phase 3**

```bash
git add e2e/codex-tier-1.test.ts e2e/vitest.e2e.config.ts package.json
git commit -m "test(e2e): add gated Tier-1 Codex agent run"
```

---

## Phase 4 — Documentation

### Task 17: README + .env.example final pass

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an "Agent" subsection to README**

Insert after the existing "Agent" block in `### 3. Configure environment variables`:

```md
**Switching agents** — Blazebot supports two CLI runtimes. Set `AGENT_KIND` once per deployment:

```bash
AGENT_KIND=claude    # default — Anthropic Claude Code
# or
AGENT_KIND=codex     # OpenAI Codex CLI
```

When `AGENT_KIND=codex`:

```bash
CODEX_API_KEY=sk-codex-xxxxxxxxxxxx   # or CODEX_CHATGPT_OAUTH_TOKEN
CODEX_MODEL=gpt-5-codex                # default
```

Pricing is fetched from [LiteLLM's community-maintained JSON](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) on each cold start (1h TTL by default). Override `CODEX_PRICING_URL` in airgapped environments. When pricing is unavailable, Slack reports show tokens-only with `cost unknown`.
```

- [ ] **Step 2: Update the Environment Variables Reference table**

Add rows for `AGENT_KIND`, `CODEX_API_KEY`, `CODEX_CHATGPT_OAUTH_TOKEN`, `CODEX_MODEL`, `CODEX_PRICING_URL`, `CODEX_PRICING_TTL_MS` matching the existing table style.

- [ ] **Step 3: Confirm `.env.example` already covers these** (set up in Task 11). If not, add the same block now.

- [ ] **Step 4: Commit Phase 4**

```bash
git add README.md
git commit -m "docs: document AGENT_KIND switching and Codex pricing source"
```

---

## Pre-implementation verifications (first 30 minutes)

These three checks belong at the start of Phase 2 (before Task 11) — they're not blocking, but a fast-fail saves time downstream. Each check is its own discrete sub-task:

1. **LiteLLM JSON reachable + has `gpt-5-codex`.**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json | jq '."gpt-5-codex"'
   ```
   Expected: an object with `input_cost_per_token` and `output_cost_per_token`. If missing, log `gpt-5` and `gpt-5-mini` for fallback documentation in the README.

2. **`skills` CLI accepts `--target`.** Inside a throwaway sandbox or local node:
   ```bash
   npx -y skills add https://github.com/obra/superpowers --skill using-superpowers --yes --target /tmp/skills-target-test
   test -d /tmp/skills-target-test/using-superpowers
   ```
   Expected: directory exists. If the flag is unsupported, switch the install in `agents/shared.ts` to `--global` for `~/.claude/skills` and rewrite Codex's symlink as `~/.agents/skills → ~/.claude/skills` instead.

3. **`codex --output-schema` validation behaviour.** Inside a Codex sandbox:
   ```bash
   echo "say hi" | codex exec --json --output-schema /tmp/strict-schema.json -o /tmp/r.json -
   ```
   With a deliberately strict schema. Confirm: validation failure does not crash the run — Codex emits `error` events and `r.json` is missing/empty. Adapter parsers already fall back to NDJSON `item.completed`; if Codex actually crashes, parsers must also handle the `error` event. Add a test for that path if observed.

---

## Net Change Summary

- **New files:** `src/sandbox/agents/{types,claude,codex,shared,index,pricing}.ts` plus tests, `e2e/codex-tier-1.test.ts`.
- **Modified:** `src/sandbox/manager.ts`, `src/sandbox/manager.test.ts`, `src/sandbox/poll-agent.ts`, `src/sandbox/poll-agent.test.ts`, `src/sandbox/usage.ts`, `src/sandbox/usage.test.ts`, `src/workflows/agent.ts`, `env.ts`, `.env.example`, `README.md`, `e2e/vitest.e2e.config.ts`, `package.json`.
- **Deleted:** `src/sandbox/wrapper-script.ts`, `src/sandbox/wrapper-script.test.ts`, `src/sandbox/agent-runner.ts`, `src/sandbox/agent-runner.test.ts`.
- **Untouched:** every adapter under `src/adapters/`, every helper under `src/lib/`, every route under `src/routes/`, `src/workflows/prompts-step.ts`, all run-registry / reconcile / dispatch / Jira webhook / cron / attachments / Arthur client code.
