# OAuth alternative

Codex accepts either an API key or an OAuth token. The default `init-agent` flow uses API keys because they're simpler: one secret, no expiration handling. Use OAuth when:

- Your org issues OAuth tokens via SSO and you can't mint long-lived API keys.
- You want the bot to act under a specific human's account (each request shows up under that account in usage logs).
- You're on a managed plan that doesn't expose API key management.

> Claude reads one variable, `ANTHROPIC_API_KEY`, which accepts a Console API key or a Claude Code OAuth token (`sk-ant-oat...`); the worker hands an OAuth token to the sandbox as `CLAUDE_CODE_OAUTH_TOKEN` (`apps/worker/src/harness-profiles/capability-catalog.ts`).

## Codex: `CODEX_CHATGPT_OAUTH_TOKEN`

Replace the API_KEY line in the paste-template with:

```
CODEX_CHATGPT_OAUTH_TOKEN=<value>
```

The worker accepts either `CODEX_API_KEY` *or* `CODEX_CHATGPT_OAUTH_TOKEN` (`apps/worker/src/infra/runtime-env.ts`, `apps/worker/src/harness-profiles/capability-catalog.ts`). Don't paste both: pick one.

OAuth tokens are obtained via the Codex CLI's login flow.

## Rotation

Rotate either kind quarterly. For OAuth, also track expiry: refresh before expiration to avoid runtime failures.

```bash
vercel env rm <KEY_NAME> production
vercel env add <KEY_NAME> production
vercel --prod    # redeploy so the new value takes effect
```
