---
name: init-agent
description: Configure or rotate provider credentials used by AI Workflow harness profiles. Emits a paste-template for the providers those profiles use. Use for "set up claude", "set up codex", "rotate anthropic key", or "configure agent credentials".
---

# Initialize Agent Credentials

Harness Profiles own the provider and model. This skill asks which providers the deployment's harness profiles use, then emits credentials only. The credentials required are those of the providers your harness profiles use: an Anthropic key for Claude profiles, and a Codex API key or OAuth token for Codex profiles.

> **Canonical reference:** [SETUP.md section 2.4](../../../SETUP.md#24-agent-runtime) holds the facts and constraints for the agent runtime. This skill is the procedure; when the two disagree, SETUP.md wins and this skill gets updated.
>
> If you want full project setup (Jira + VCS + Agent + Slack + Neon + deploy), invoke `init-env` instead. This skill only handles the agent runtime.

## Precondition

`.vercel/project.json` must exist. If missing:

```
ERROR: no Vercel project linked. Run `vercel link` first, or invoke `init-env`
for the full first-time setup.
```

Halt.

## Step 1: Identify profile providers

Ask: *"Do your harness profiles use Claude, Codex, or both?"*

Provider and model changes belong on the Harness Profiles page. If no profile uses a previously configured provider, the user should remove that provider's credentials from Vercel. Print a one-line warning.

## Step 2: Emit paste-template

### Claude branch

Walk the user through https://console.anthropic.com/settings/keys to create an API key. Codex OAuth is documented in `references/oauth-alternative.md`.

Collect:
- `ANTHROPIC_API_KEY` (starts with `sk-ant-`; a Claude Code OAuth token `sk-ant-oat...` also works)

Emit:

```
ANTHROPIC_API_KEY=<value>
```

### Codex branch (default API key, OAuth alternative)

Walk the user through https://platform.openai.com/api-keys to create an API key. OAuth via `CODEX_CHATGPT_OAUTH_TOKEN` is documented in `references/oauth-alternative.md`.

Collect:
- `CODEX_API_KEY`

Emit:

```
CODEX_API_KEY=<value>
```

For deployments whose profiles use both providers, emit both credential lines. The user can choose the OAuth alternative instead of the Codex API key.

## Step 3: Done

Tell the user to paste into Vercel Project Settings, Environment Variables for all three environments, save, and reply when done. Credentials are not checked at boot: a missing one surfaces when an agent block using that provider runs, or when the scheduled capability refresh (`/cron/harness-capabilities`) reports discovery not ready. With no authored profile the built-in `builtin-codex` profile runs, so a Claude-only deployment needs a Claude profile pinned on its agent blocks.

## Don'ts

- **Don't emit both API key and OAuth token.** Pick one. The runbook explains the swap if the user wants OAuth.
- **Don't print the key after collecting it.** Reference by name only.
- **Don't emit provider or model settings.** Harness Profiles own both.
