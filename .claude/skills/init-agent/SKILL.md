---
name: init-agent
description: Configure or rotate the agent runtime (Claude or Codex) for the Blazebot workflow. Branches on runtime choice and emits a single paste-template for the chosen kind. Use for "set up claude", "set up codex", "rotate anthropic key", "switch agent to codex", "configure agent runtime".
---

# Initialize Agent Runtime

Branch-on-choice skill. Asks **Claude or Codex**, then emits a single paste-template for the chosen runtime. Cross-field rule in `env.ts` (`AGENT_KIND=claude` requires `ANTHROPIC_API_KEY`; `AGENT_KIND=codex` requires `CODEX_API_KEY` or `CODEX_CHATGPT_OAUTH_TOKEN`) is enforced by construction.

> If you want full project setup (Jira + VCS + Agent + Slack + Upstash + deploy), invoke `init-env` instead. This skill only handles the agent runtime.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## Step 1 — Pick runtime

Ask: *"Claude or Codex?"*

If switching from a previously-configured runtime, the user should also remove the old runtime's keys from Vercel. Print a one-line warning.

## Step 2 — Emit paste-template

### Claude branch

Walk the user through https://console.anthropic.com/settings/keys to create an API key. Codex OAuth is documented in `references/oauth-alternative.md`.

Collect:
- `ANTHROPIC_API_KEY` (starts with `sk-ant-`)
- `CLAUDE_MODEL` (default `claude-opus-4-6`; only override if requested)

Emit:

```
AGENT_KIND=claude
ANTHROPIC_API_KEY=<value>
```

If the user asked for a non-default model, also append:
```
CLAUDE_MODEL=<value>
```

### Codex branch (default API key, OAuth alternative)

Walk the user through https://platform.openai.com/api-keys to create an API key. OAuth via `CODEX_CHATGPT_OAUTH_TOKEN` is documented in `references/oauth-alternative.md`.

Collect:
- `CODEX_API_KEY`
- `CODEX_MODEL` (default `gpt-5-codex`; only override if requested)

Emit:

```
AGENT_KIND=codex
CODEX_API_KEY=<value>
```

If non-default model:
```
CODEX_MODEL=<value>
```

## Step 3 — Done

Tell the user to paste into Vercel → Project Settings → Environment Variables (all three environments), save, and reply when done. No verification — `init-env`'s end-of-flow validator catches missing/malformed values.

## Don'ts

- **Don't emit both API key and OAuth token.** Pick one. The runbook explains the swap if the user wants OAuth.
- **Don't print the key after collecting it.** Reference by name only.
- **Don't change `CLAUDE_MODEL` / `CODEX_MODEL` defaults without being asked.** They're set in `env.ts`; only emit them when the user requests an override.
