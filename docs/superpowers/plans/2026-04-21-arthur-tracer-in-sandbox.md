# Arthur Tracer In Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the Arthur AI Engine Claude Code tracer inside every Vercel Sandbox the workflow provisions, so every in-sandbox Claude Code turn emits OpenInference spans to a configured Arthur instance. Credentials are optional — if any of the three Arthur env vars is missing, provisioning behaves exactly as today.

**Architecture:** Bundle `arthur-engine/integrations/claude-code/claude_code_tracer.py` as a base64 string in a generated TS file so Nitro reliably includes it in the Vercel deployment. Extend `SandboxConfig` with an optional `arthur` block. In `SandboxManager.provision()`, after Claude Code is installed, pip-install two `opentelemetry` packages, write the tracer to `$HOME/.claude/hooks/claude_code_tracer.py`, write `$HOME/.claude/arthur_config.json`, and merge Arthur's five hook entries (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`) into `$HOME/.claude/settings.json`. Centralise every write to `settings.json` in a single merge-aware helper so `configureStopHookInSandbox` no longer clobbers Arthur's hooks when it toggles the commit-guard Stop entry.

**Tech Stack:** TypeScript, Vitest, `@vercel/sandbox` (`writeFiles`, `runCommand`), `@t3-oss/env-core` + Zod, Python 3 + pip (runs inside sandbox), Node 24 (runs inside sandbox for JSON merges).

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `env.ts` | **Modify** | Three optional server vars: `GENAI_ENGINE_API_KEY`, `GENAI_ENGINE_TASK_ID`, `GENAI_ENGINE_TRACE_ENDPOINT`. |
| `scripts/build-arthur-tracer.mjs` | **Create** | Generates `src/sandbox/arthur-tracer.ts` from `../arthur-engine/integrations/claude-code/claude_code_tracer.py`. |
| `src/sandbox/arthur-tracer.ts` | **Create (generated, checked in)** | Exports `ARTHUR_TRACER_PY_BASE64: string`. Regenerated via `pnpm build:arthur-tracer`. |
| `package.json` | **Modify** | Add script `"build:arthur-tracer": "node scripts/build-arthur-tracer.mjs"`. |
| `src/sandbox/manager.ts` | **Modify** | Extend `SandboxConfig.arthur`; add `installArthurTracer(sandbox, arthur)`; replace the heredoc writers in `configureStopHookInSandbox` with a single merge-aware helper `writeClaudeSettings(sandbox, opts)`. Call `installArthurTracer` from `provision()` after `installGlobalSkills`. |
| `src/sandbox/manager.test.ts` | **Modify** | Rewrite the two stop-hook tests to assert the new `node -e` merge call; add three Arthur tests (installs when configured, skipped when not, registers all five hook commands). |
| `src/workflows/agent.ts` | **Modify** | Build `arthur` config block from env once; pass into `SandboxManager`. `configureStopHook` signature unchanged. |
| `.gitignore` | **Modify** | No change — `src/sandbox/arthur-tracer.ts` is checked in. |

No changes to `arthur-engine/` (read-only source), VCS adapters, run registry, Slack, cron.

---

## Shared Types (referenced by multiple tasks)

Defined in Task 3, reproduced here so later tasks don't have to repeat the shape:

```ts
// src/sandbox/manager.ts
export interface ArthurConfig {
  apiKey: string;   // GENAI_ENGINE_API_KEY
  taskId: string;   // GENAI_ENGINE_TASK_ID (UUID)
  endpoint: string; // GENAI_ENGINE_TRACE_ENDPOINT (full URL incl. /api/v1/traces)
}

export interface SandboxConfig {
  // ...existing fields unchanged...
  arthur?: ArthurConfig;
}
```

---

## Task 1: Add Arthur env vars

**Files:**
- Modify: `env.ts`

- [ ] **Step 1: Add the three new optional vars to the `server` block**

In `env.ts`, inside the `server: { ... }` object in `createEnv(...)`, add the following entries directly after the `// Agent` group (after `COMMIT_EMAIL`, before `// Sandbox`):

```ts
    // Arthur AI Engine (optional — all three required together)
    GENAI_ENGINE_API_KEY: z.string().min(1).optional(),
    GENAI_ENGINE_TASK_ID: z.string().uuid().optional(),
    GENAI_ENGINE_TRACE_ENDPOINT: z.string().url().optional(),
```

No cross-field validation needed in the `createEnv` call — the "either all three or none" rule is enforced at the only use site (`src/workflows/agent.ts`, see Task 6).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (the optional fields won't break anything).

- [ ] **Step 3: Commit**

```bash
git add env.ts
git commit -m "feat(env): add optional Arthur AI Engine env vars"
```

---

## Task 2: Build script for the tracer bundle

**Files:**
- Create: `scripts/build-arthur-tracer.mjs`
- Modify: `package.json`

Nitro's Vercel preset does not reliably bundle arbitrary `.py` files that sit next to `.ts` sources, so we embed the Python tracer as a base64 string in a generated TS file that Nitro will treat as source. The build script is run manually (and can be re-run whenever Arthur's tracer is updated upstream).

- [ ] **Step 1: Write the build script**

Create `scripts/build-arthur-tracer.mjs` with this exact content:

```js
#!/usr/bin/env node
// Generates src/sandbox/arthur-tracer.ts from the Arthur Engine tracer source.
// Regenerate whenever arthur-engine/integrations/claude-code/claude_code_tracer.py changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultSource = path.resolve(
  repoRoot,
  "..",
  "arthur-engine",
  "integrations",
  "claude-code",
  "claude_code_tracer.py",
);
const sourcePath = process.env.ARTHUR_TRACER_SRC
  ? path.resolve(process.env.ARTHUR_TRACER_SRC)
  : defaultSource;

if (!fs.existsSync(sourcePath)) {
  console.error(`Arthur tracer not found at ${sourcePath}.`);
  console.error("Set ARTHUR_TRACER_SRC to override.");
  process.exit(1);
}

const bytes = fs.readFileSync(sourcePath);
const base64 = bytes.toString("base64");
const outPath = path.resolve(repoRoot, "src", "sandbox", "arthur-tracer.ts");

const out = `// AUTO-GENERATED — do not edit by hand.
// Source: ${path.relative(repoRoot, sourcePath)}
// Regenerate: pnpm build:arthur-tracer
//
// Base64-encoded Python source of the Arthur Engine Claude Code tracer.
// Bundled so Nitro reliably ships it with the Vercel deployment; decoded at
// runtime and written into each provisioned sandbox under ~/.claude/hooks/.
export const ARTHUR_TRACER_PY_BASE64 = "${base64}";
`;

fs.writeFileSync(outPath, out);
console.log(`Wrote ${path.relative(repoRoot, outPath)} (${bytes.length} bytes -> ${base64.length} base64 chars)`);
```

- [ ] **Step 2: Add the npm script**

Edit `package.json`, insert in the `"scripts"` block (after `"typecheck"` is fine):

```json
    "build:arthur-tracer": "node scripts/build-arthur-tracer.mjs",
```

- [ ] **Step 3: Run the script**

Run: `pnpm build:arthur-tracer`
Expected output: `Wrote src/sandbox/arthur-tracer.ts (59174 bytes -> 78900 base64 chars)` (exact numbers will vary with tracer version).

- [ ] **Step 4: Sanity-check the generated file**

Run: `head -c 200 src/sandbox/arthur-tracer.ts`
Expected: starts with `// AUTO-GENERATED` comment, then `export const ARTHUR_TRACER_PY_BASE64 = "...`.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-arthur-tracer.mjs package.json src/sandbox/arthur-tracer.ts
git commit -m "feat(sandbox): bundle Arthur tracer source via build script"
```

---

## Task 3: Extend `SandboxConfig` with `arthur` block

**Files:**
- Modify: `src/sandbox/manager.ts`

Surgical type change; no runtime behaviour yet. Isolating the type change lets later tasks focus on logic.

- [ ] **Step 1: Add the `ArthurConfig` interface and extend `SandboxConfig`**

In `src/sandbox/manager.ts`, directly above the existing `export interface SandboxConfig {` block (~line 14), add:

```ts
export interface ArthurConfig {
  apiKey: string;
  taskId: string;
  endpoint: string;
}
```

Then inside `SandboxConfig`, append at the end (after `jobTimeoutMs`):

```ts
  /** Arthur AI Engine tracing config. If set, the tracer is installed into every provisioned sandbox. */
  arthur?: ArthurConfig;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (optional field, no call sites yet).

- [ ] **Step 3: Commit**

```bash
git add src/sandbox/manager.ts
git commit -m "feat(sandbox): add optional ArthurConfig to SandboxConfig"
```

---

## Task 4: Centralise `settings.json` writes

**Files:**
- Modify: `src/sandbox/manager.ts`
- Modify: `src/sandbox/manager.test.ts`

The existing `configureStopHookInSandbox` writes a full `~/.claude/settings.json` via a shell heredoc, which would wipe Arthur's hooks when toggled between phases. Replace it with `writeClaudeSettings(sandbox, opts)` — a single helper that always merges into the current file.

The merge logic runs inside the sandbox via `node -e` (node 24 is the runtime — always available). It takes a single JSON argument describing what to mutate:

- `{"commitGuard":"enable"}` — add the commit-guard Stop hook entry if absent
- `{"commitGuard":"disable"}` — remove the commit-guard Stop hook entry if present
- `{"arthur":"install"}` — append the five Arthur hook entries if absent (idempotent by exact command string)

Multiple keys can be combined. The helper does **not** touch hook entries it doesn't own.

- [ ] **Step 1: Write the failing tests**

Replace the two existing stop-hook tests (`manager.test.ts:114-159`) with the following, and add two new ones. After the existing `"writes CLAUDE_CODE_OAUTH_TOKEN..."` test (~line 112), rewrite/extend this block:

```ts
  it("enabling the stop hook runs a node merge script that adds commit-guard", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });
    const sandbox = await manager.provision("feat/test-branch");
    mockRunCommand.mockClear();

    await manager.configureStopHook(sandbox, true);

    const mergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes("commit-guard.sh") &&
        c[1][2].includes('"commitGuard":"enable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("disabling the stop hook runs a node merge script with commitGuard=disable", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });
    const sandbox = await manager.provision("feat/test-branch");
    mockRunCommand.mockClear();

    await manager.configureStopHook(sandbox, false);

    const mergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes('"commitGuard":"disable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("configureStopHookInSandbox works with any sandbox-like object", async () => {
    const fakeSandbox = { runCommand: mockRunCommand };
    mockRunCommand.mockClear();

    await configureStopHookInSandbox(fakeSandbox as any, true);

    const mergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes('"commitGuard":"enable"'),
    );
    expect(mergeCall).toBeDefined();
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm test -- manager.test.ts`
Expected: FAIL — the old heredoc writer doesn't call `node -e`.

- [ ] **Step 3: Implement the merge helper**

In `src/sandbox/manager.ts`, **replace** the entire body of `configureStopHookInSandbox` (lines 64-92) and **replace** the `cat > ~/.claude/settings.json << 'JSON' ... JSON` / `echo '{}' > ~/.claude/settings.json` writes with the new helper. Add the new helper directly above `configureStopHookInSandbox`:

```ts
/**
 * Merge-aware writer for ~/.claude/settings.json inside a sandbox.
 *
 * Accepts a partial "directive" — only the keys provided are mutated; existing
 * hook entries (including those owned by other tools, e.g. Arthur's tracer)
 * are preserved. The merge itself runs inside the sandbox via `node -e`
 * because Node 24 is the sandbox runtime and we can't assume Python is
 * available for stop-hook toggling.
 */
async function writeClaudeSettings(
  sandbox: RunnableSandbox,
  opts: {
    commitGuard?: "enable" | "disable";
    arthur?: "install";
  },
): Promise<void> {
  const directive = JSON.stringify(opts);
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    const opts = ${JSON.stringify(opts)};
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
    const removeHook = (event, commandPredicate) => {
      const existing = s.hooks[event] || [];
      s.hooks[event] = existing
        .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => !commandPredicate(h.command || '')) }))
        .filter(e => (e.hooks || []).length > 0);
    };

    if (opts.commitGuard === 'enable') {
      upsertHook('Stop', '', 'bash ~/.claude/commit-guard.sh');
    } else if (opts.commitGuard === 'disable') {
      removeHook('Stop', c => c.includes('commit-guard.sh'));
    }

    if (opts.arthur === 'install') {
      const events = [
        ['UserPromptSubmit', 'user_prompt_submit'],
        ['PreToolUse', 'pre_tool'],
        ['PostToolUse', 'post_tool'],
        ['PostToolUseFailure', 'post_tool_failure'],
        ['Stop', 'stop'],
      ];
      for (const [event, arg] of events) {
        upsertHook(event, '', 'python3 "$HOME/.claude/hooks/claude_code_tracer.py" ' + arg);
      }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  `;
  // Note: we serialise opts into the script body twice — the JSON.stringify above
  // injects the literal, which is what the test assertions look for. The
  // \`directive\` string is included below purely to make the intent grep-able
  // when reading runtime logs. (It does not affect behaviour.)
  void directive;
  await sandbox.runCommand("node", ["--input-type=module", "-e", script]);
}

export async function configureStopHookInSandbox(sandbox: RunnableSandbox, enabled: boolean): Promise<void> {
  // Ensure the commit-guard script exists before toggling the hook (idempotent).
  await sandbox.runCommand("bash", [
    "-c",
    [
      `mkdir -p ~/.claude`,
      `cat > ~/.claude/commit-guard.sh << 'SCRIPT'`,
      `#!/bin/bash`,
      `input=$(cat)`,
      `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
      `changes=$(git status --porcelain | grep -v '^.. \\.claude/' | grep -v '^?? \\.claude/')`,
      `if [ -n "$changes" ]; then`,
      `  echo '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}' >&2`,
      `  exit 2`,
      `fi`,
      `SCRIPT`,
      `chmod +x ~/.claude/commit-guard.sh`,
    ].join("\n"),
  ]);

  await writeClaudeSettings(sandbox, { commitGuard: enabled ? "enable" : "disable" });
}
```

Also **remove** the `SandboxManager.configureStopHook` method's body change is unnecessary — it already delegates. Leave `SandboxManager.configureStopHook` (lines ~229-231) as-is.

- [ ] **Step 4: Export `writeClaudeSettings` for Task 5's use**

At the bottom of `src/sandbox/manager.ts`, the helper lives inside the module scope. Task 5 will call it from `installArthurTracer` which also lives in the same module, so no export needed. Leave it as an internal helper.

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `pnpm test -- manager.test.ts`
Expected: PASS — all five tests in `manager.test.ts` green.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "refactor(sandbox): merge-aware settings.json writer"
```

---

## Task 5: Install Arthur tracer inside `provision()`

**Files:**
- Modify: `src/sandbox/manager.ts`
- Modify: `src/sandbox/manager.test.ts`

Now wire the Arthur install into `provision()`. The install is a no-op when `config.arthur` is undefined, so existing tests keep passing without setting it.

Install order inside `provision()`:

1. (existing) `npm install -g @anthropic-ai/claude-code`
2. (existing) write `agent-env.sh`
3. (existing) onboarding `~/.claude.json`
4. (existing) `installGlobalSkills`
5. **(new)** `installArthurTracer` — only if `config.arthur` is set

- [ ] **Step 1: Write the failing tests**

In `src/sandbox/manager.test.ts`, append three new tests in the existing `describe` block (after the last one):

```ts
  it("installs Arthur tracer when config.arthur is set", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
      arthur: {
        apiKey: "test-key",
        taskId: "00000000-0000-4000-8000-000000000000",
        endpoint: "https://example.ngrok.app/api/v1/traces",
      },
    });

    await manager.provision("feat/test-branch");

    const pipCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "bash" &&
        typeof c[1]?.[1] === "string" &&
        c[1][1].includes("pip3 install") &&
        c[1][1].includes("opentelemetry-sdk") &&
        c[1][1].includes("opentelemetry-exporter-otlp-proto-http"),
    );
    expect(pipCall).toBeDefined();

    const arthurMergeCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "node" &&
        Array.isArray(c[1]) &&
        c[1][0] === "--input-type=module" &&
        c[1][1] === "-e" &&
        typeof c[1][2] === "string" &&
        c[1][2].includes('"arthur":"install"') &&
        c[1][2].includes("user_prompt_submit") &&
        c[1][2].includes("pre_tool") &&
        c[1][2].includes("post_tool") &&
        c[1][2].includes("post_tool_failure"),
    );
    expect(arthurMergeCall).toBeDefined();
  });

  it("skips Arthur install when config.arthur is undefined", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    await manager.provision("feat/test-branch");

    const pipCall = mockRunCommand.mock.calls.find(
      (c: any[]) =>
        c[0] === "bash" && typeof c[1]?.[1] === "string" && c[1][1].includes("pip3 install"),
    );
    expect(pipCall).toBeUndefined();
  });

  it("Arthur install writes arthur_config.json and the tracer script", async () => {
    const manager = new SandboxManager({
      kind: "github",
      token: "ghp_test",
      repoPath: "test-org/test-repo",
      host: "https://github.com",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-opus-4-6",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
      arthur: {
        apiKey: "test-key",
        taskId: "00000000-0000-4000-8000-000000000000",
        endpoint: "https://example.ngrok.app/api/v1/traces",
      },
    });

    await manager.provision("feat/test-branch");

    // Every writeFiles call passes an array of { path, content }. Flatten them.
    const written = mockWriteFiles.mock.calls.flatMap(([files]: any[]) => files);
    const tracerFile = written.find((f: any) => f.path.endsWith("arthur-tracer.py"));
    expect(tracerFile).toBeDefined();
    expect(Buffer.isBuffer(tracerFile.content)).toBe(true);
    expect(tracerFile.content.length).toBeGreaterThan(1000);

    const configFile = written.find((f: any) => f.path.endsWith("arthur_config.json"));
    expect(configFile).toBeDefined();
    const cfg = JSON.parse(Buffer.from(configFile.content).toString());
    expect(cfg).toEqual({
      api_key: "test-key",
      task_id: "00000000-0000-4000-8000-000000000000",
      endpoint: "https://example.ngrok.app/api/v1/traces",
    });
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm test -- manager.test.ts`
Expected: FAIL — `installArthurTracer` doesn't exist yet.

- [ ] **Step 3: Implement `installArthurTracer`**

In `src/sandbox/manager.ts`, add this import at the top of the file (after existing imports):

```ts
import { ARTHUR_TRACER_PY_BASE64 } from "./arthur-tracer.js";
```

Then inside the `SandboxManager` class, directly below `installGlobalSkills`, add:

```ts
  /**
   * Install the Arthur AI Engine Claude Code tracer into the sandbox.
   *
   * No-op if the three credentials are not all configured on the SandboxManager.
   * The tracer hooks into every Claude Code turn and exports OpenInference spans
   * via OTLP/HTTP to the configured endpoint.
   *
   * If pip install fails (e.g. missing python3, offline), we log and return
   * without registering hooks — failing hooks would block Claude Code turns.
   */
  private async installArthurTracer(sandbox: SandboxInstance): Promise<void> {
    const arthur = this.config.arthur;
    if (!arthur) return;

    const { logger } = await import("../lib/logger.js");

    const pip = await sandbox.runCommand("bash", [
      "-c",
      "python3 -m pip install --user --quiet opentelemetry-sdk>=1.20.0 opentelemetry-exporter-otlp-proto-http>=1.20.0",
    ]);
    if (pip.exitCode !== 0) {
      const err = (await pip.stderr()).trim();
      logger.warn({ err: err.slice(0, 500) }, "arthur_pip_install_failed");
      return;
    }

    // Stage tracer to /tmp, then relocate (writeFiles takes absolute paths; $HOME
    // isn't expanded by the API, only by shell commands).
    const tracerBytes = Buffer.from(ARTHUR_TRACER_PY_BASE64, "base64");
    await sandbox.writeFiles([
      { path: "/tmp/arthur-tracer.py", content: tracerBytes },
    ]);
    await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.claude/hooks && mv /tmp/arthur-tracer.py $HOME/.claude/hooks/claude_code_tracer.py && chmod +x $HOME/.claude/hooks/claude_code_tracer.py",
    ]);

    // Write the config file. Priority-2 location per Arthur's README.
    const configJson = JSON.stringify(
      { api_key: arthur.apiKey, task_id: arthur.taskId, endpoint: arthur.endpoint },
      null,
      2,
    );
    await sandbox.writeFiles([
      { path: "/tmp/arthur_config.json", content: Buffer.from(configJson) },
    ]);
    await sandbox.runCommand("bash", [
      "-c",
      "mkdir -p $HOME/.claude && mv /tmp/arthur_config.json $HOME/.claude/arthur_config.json && chmod 600 $HOME/.claude/arthur_config.json",
    ]);

    // Register all five Arthur hooks via the merge-aware writer.
    await writeClaudeSettings(sandbox, { arthur: "install" });
  }
```

Then in `provision()`, **after** the existing call `await this.installGlobalSkills(sandbox);` (near the end of the method, just before `return sandbox;`), add:

```ts
    await this.installArthurTracer(sandbox);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- manager.test.ts`
Expected: PASS — all eight tests in `manager.test.ts` green.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "feat(sandbox): install Arthur AI tracer during provision"
```

---

## Task 6: Wire env into the workflow

**Files:**
- Modify: `src/workflows/agent.ts`

`provisionSandbox` builds the `SandboxConfig`; this is where the "all three or none" rule lives.

- [ ] **Step 1: Build the `arthur` block from env and pass it into `SandboxManager`**

In `src/workflows/agent.ts`, find the `new SandboxManager({...})` call at line ~159 and replace it with:

```ts
  const arthur =
    env.GENAI_ENGINE_API_KEY && env.GENAI_ENGINE_TASK_ID && env.GENAI_ENGINE_TRACE_ENDPOINT
      ? {
          apiKey: env.GENAI_ENGINE_API_KEY,
          taskId: env.GENAI_ENGINE_TASK_ID,
          endpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
        }
      : undefined;

  const manager = new SandboxManager({
    kind: vcs.kind,
    token: vcs.token,
    repoPath: vcs.repoPath,
    host: vcs.host,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    arthur,
  });
```

No changes needed to `configureStopHook` (the helper in `agent.ts`, line ~205) — `writeClaudeSettings` preserves Arthur's hooks automatically.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: PASS across the board. `agent.test`-style workflow tests should not regress (they either mock `SandboxManager` or don't look at the arthur field).

- [ ] **Step 4: Commit**

```bash
git add src/workflows/agent.ts
git commit -m "feat(workflow): pass Arthur config from env into SandboxManager"
```

---

## Task 7: Local end-to-end smoke test

**Files:**
- None (verification only)

- [ ] **Step 1: Expose local Arthur via ngrok**

Run in a separate terminal: `ngrok http 3030`
Copy the `https://...ngrok-free.app` URL.

- [ ] **Step 2: Create an Arthur task and grab its UUID**

Open `http://localhost:3030`, sign in with `changeme_genai_engine_admin_key`, create a task, copy its UUID.

- [ ] **Step 3: Configure `.env`**

Add to `.env` in the repo root:

```
GENAI_ENGINE_API_KEY=changeme_genai_engine_admin_key
GENAI_ENGINE_TASK_ID=<paste-uuid>
GENAI_ENGINE_TRACE_ENDPOINT=https://<subdomain>.ngrok-free.app/api/v1/traces
```

- [ ] **Step 4: Ensure the tracer bundle is fresh**

Run: `pnpm build:arthur-tracer`

- [ ] **Step 5: Start the dev server and dispatch one ticket**

Run: `pnpm dev`
In Jira, transition one ticket to the AI column (or wait for the cron sweep). The workflow will provision a sandbox with Arthur wired in.

- [ ] **Step 6: Verify in Arthur UI**

Watch Arthur's task view. Within ~30s of the agent starting, you should see:
- One `claude-code-turn` trace per user prompt inside the sandbox
- Child spans: `LLM` (claude/claude-sonnet-*), `TOOL` (Read/Edit/Bash/etc.), `RETRIEVER` (WebSearch/WebFetch), `AGENT` (Task)
- The `arthur.session` resource attribute grouping spans from the same Claude Code session

- [ ] **Step 7: Negative check**

Unset one of the three `GENAI_ENGINE_*` vars in `.env`, restart `pnpm dev`, dispatch another ticket. Confirm the sandbox provisions and the ticket processes exactly as today — no Arthur HTTP calls (tail ngrok's request log to confirm zero traffic), no broken hooks.

---

## Verification

1. **Unit tests**: `pnpm test` — green across all suites.
2. **Typecheck**: `pnpm typecheck` — green.
3. **Manual smoke test**: Task 7 end-to-end — traces appear in Arthur UI, unset-credentials path is a clean no-op.

## Risks / Open items

- **Python availability in sandbox**: Vercel's `node24` runtime image includes `python3` + `pip3`, but if a future image change removes them, `pip3 install` fails, `installArthurTracer` logs a warning and returns early — provisioning continues unaffected. No hooks get registered, so no broken turns.
- **Tracer drift**: `src/sandbox/arthur-tracer.ts` is a snapshot. Re-run `pnpm build:arthur-tracer` and redeploy whenever Arthur ships a new tracer.
- **Bundle size**: +~80KB to the deployed JS artifact. Acceptable.
- **Networking**: The sandbox hits whatever URL is in `GENAI_ENGINE_TRACE_ENDPOINT`. For local dev that's ngrok; for prod, deploy Arthur somewhere with a stable public URL and swap the env var.
