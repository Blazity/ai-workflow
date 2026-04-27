# Setup Onboarding — What We Can and Can't Automate

**Date**: 2026-04-27 · **Status**: Research

## TL;DR

The biggest single UX win is a **Vercel Deploy Button** that imports the repo, provisions Upstash
Redis via Marketplace, prompts for credentials, and deploys — all in one click. The remaining
manual work is per-provider token minting (the operator owns the accounts, not us). Sections
below are ordered by install flow: host first, then everything fed into it.

> Script names below (`pnpm setup`, `pnpm setup:check`) are proposed. Today only
> `pnpm setup:arthur-prompts` exists.

---

## Vercel

**Can't:** create the Vercel team, run `vercel login` for the operator.

**Can:**

- **Deploy Button + Marketplace stores** — one URL imports the repo, creates the project,
  provisions Upstash Redis (and optionally Postgres), prompts for env vars, deploys:
  ```
  https://vercel.com/new/clone
    ?repository-url=<repo>&project-name=blazebot
    &env=<required-keys>&envDescription=<short-explainer>
    &stores=[{"type":"integration","integrationSlug":"upstash","productSlug":"upstash-kv-redis"}]
  ```
- `vercel link` wrapper, `vercel env add` / `pull` automation, env-drift diff between local and
  prod.

---

## Upstash Redis

**Can't** (outside Vercel): account creation, dashboard provisioning. Inside Vercel Marketplace,
the operator never touches Upstash directly.

**Can:**

- Marketplace install during project creation auto-injects connection env vars.
- Connection + round-trip tests, namespace prefix derived from project name.

> **Precondition:** rename `AI_WORKFLOW_KV_REST_API_URL` / `_TOKEN` to the Marketplace defaults
> (`KV_REST_API_URL` / `_TOKEN` or `UPSTASH_REDIS_REST_URL` / `_TOKEN`). ~30-min change.

---

## Jira

**Can't:** Atlassian account, API token, project selection, the operator's intent of which status
maps to which role.

**Can:**

- Token + project-access validation.
- **Status → role mapping** — fetch project statuses, show three dropdowns (Active / Review /
  Backlog), write `COLUMN_AI` / `COLUMN_AI_REVIEW` / `COLUMN_BACKLOG`.
- **Missing-status helper** — team-managed projects: create via REST; company-managed (most
  enterprises): print exact UI steps to take, then re-run.
- Auto-generate `JIRA_WEBHOOK_SECRET`.

**Can't (without a Connect/Forge app):** programmatic webhook registration. Operator clicks
through Jira's Webhooks UI by hand.

**Setup splits in two:** pre-deploy (token, statuses, secret) → post-deploy (webhook URL needs
the deployed domain). Cron polling works without the webhook, so the post-deploy step is optional.

---

## GitHub / GitLab

**Can't:** account, PAT minting, repo selection.

**Can:** token + repo validation, push-permission probe (create + delete throwaway branch),
base-branch auto-discovery, PAT-creation deep-link.

---

## Slack

**Can't:** workspace creation, app-install consent.

**Can:**

- **App manifest install** — one URL with scopes pre-set. ~6 manual clicks → 2.
- Token validation, channel pick by name, bot-membership probe with `/invite` instructions.

---

## Anthropic / Claude Code

**Can't:** account, key issuance.

**Can:** key validation against `/v1/models`, accept either API key or `claude setup-token` OAuth,
**model selection** from the live `/v1/models` list (defaults to `CLAUDE_MODEL` in `env.ts`).

---

## Secrets

`CRON_SECRET`, `JIRA_WEBHOOK_SECRET` — auto-generate via `openssl rand -hex 32`. Operator never
sees them.

---

## Arthur (optional)

**Can't:** account, key issuance.

**Can:** skip-if-unconfigured, key validation, idempotent prompt-task creation
(`pnpm setup:arthur-prompts` already does this).

> Future: the wizard could call this script automatically to fully scaffold Arthur tracing +
> hosted prompts in one step. Out of scope for the first cut — left as a follow-up.

---

## Happy path (if everything above ships)

A new operator's full setup, end to end:

1. **One-time accounts.** Operator has Vercel, Atlassian, GitHub, Slack, Anthropic accounts and
   mints tokens for each. ~5 min, outside our control.

2. **`pnpm setup`** — interactive wizard, ~3 min:
   - Auto-generates `CRON_SECRET` and `JIRA_WEBHOOK_SECRET`.
   - Validates each token live as it's pasted.
   - Fetches Jira statuses → three dropdowns for Active / Review / Backlog.
   - Opens Slack manifest install URL → bot token returned → channel picked by name.
   - Anthropic model picker from live `/v1/models`.
   - Writes a complete `.env.local`.

3. **One-click deploy** — wizard ends with a `[Deploy]` step (or operator clicks the README's
   Deploy Button):
   - Repo imported, project created, Upstash Redis provisioned via Marketplace (env vars
     auto-injected).
   - Wizard pushes the rest of `.env` to Vercel.
   - Cron registered. First poll within 60s.
   - Deployment URL returned to the wizard.

4. **`pnpm setup:webhook`** — post-deploy continuation, ~30 sec:
   - Prints the Jira webhook URL + secret to paste.
   - Operator opens Jira → Webhooks → Add → Save.
   - Wizard verifies the first delivery.

5. **Done.** Drop a Jira ticket into the AI column; first PR comes back within minutes.

**Operator time after the one-time account setup: ~5 minutes.** Compare to today's manual flow —
~30 minutes of typing 18 env vars across five service dashboards.

What still requires the operator: account creation, token minting (we can never do these), and
three consent screens (Vercel project, Slack install, Jira webhook).

### Rough estimate

| Step | Operator-active | Wall-clock |
| --- | --- | --- |
| 1 — One-time accounts + tokens | ~5 min | ~5 min |
| 2 — `pnpm setup` wizard | ~3 min | ~3 min |
| 3 — Deploy click | ~30 sec | ~1–2 min (Vercel build) |
| 4 — `pnpm setup:webhook` | ~30 sec | ~30 sec |
| 5 — First ticket → first PR | — | ~few min (cron + agent run) |

**Totals:** ~9 min operator-active for a fresh operator, ~4 min if accounts already exist;
~10–12 min wall-clock to a working install. Today: ~30 min operator-active, ~35 min wall-clock —
roughly a 3× speedup end-to-end and 6–7× less typing.
