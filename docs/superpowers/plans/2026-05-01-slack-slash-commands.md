# Slack Slash Commands Implementation Plan

**Goal:** Add inbound Slack slash commands (`/ai-workflow list | status <KEY> | cancel <KEY>`) so operators can inspect and control workflow runs from Slack.

**Architecture:** One Nitro POST route at `/webhooks/slack` verifies Slack's HMAC signature, parses the slash command payload, ack's within 3s, and dispatches the subcommand to async handlers that read the existing `RunRegistryAdapter` and reuse `cancelRun()`. Results are posted back via Slack's `response_url`.

**Tech Stack:** Nitro (h3), `@chat-adapter/slack` (already wired for outbound), Node `crypto` for HMAC, existing Upstash run registry, `workflow/api` for run cancel.

**Out of scope (deferred):** interactive buttons, Events API / `app_mention`, multi-tenant routing, audit log persistence.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/routes/webhooks/slack.post.ts` | Route entry: verify signature, parse payload, ack, dispatch |
| `src/lib/slack/verify.ts` | HMAC-SHA256 signature verification + timestamp drift check |
| `src/lib/slack/commands.ts` | Subcommand parser + dispatcher (`list`, `status`, `cancel`) |
| `src/lib/slack/respond.ts` | Helper to POST formatted text to Slack `response_url` |
| `src/lib/slack/format.ts` | Format registry rows + status into Slack mrkdwn |
| `env.ts` | Add `SLACK_SIGNING_SECRET` (required); optional `SLACK_ALLOWED_USER_IDS` |
| `*.test.ts` siblings | Unit tests for verify, commands, format |

`cancelRun` (`src/lib/cancel-run.ts`) and `RunRegistryAdapter.listAll/getRunId/getSandboxId` are reused as-is — no changes.

---

## Phase 1 — Signature verification (foundational, pure function)

**Task 1.1:** Add `SLACK_SIGNING_SECRET: z.string().min(1)` to `env.ts` server schema. Add optional `SLACK_ALLOWED_USER_IDS: z.string().optional()` (comma-separated).

**Task 1.2:** Implement `src/lib/slack/verify.ts`:
- `verifySlackSignature({ rawBody, timestamp, signature, signingSecret })` → boolean
- Compute `v0=` + HMAC-SHA256 over `v0:${timestamp}:${rawBody}` with `signingSecret`
- Compare with `timingSafeEqual`
- Reject if `Math.abs(now - timestamp) > 300` (5 min replay window)

**Task 1.3:** TDD: cover (a) valid sig passes, (b) tampered body fails, (c) old timestamp fails, (d) length-mismatched signature fails without throwing.

---

## Phase 2 — Command parsing (pure)

**Task 2.1:** Implement `src/lib/slack/commands.ts` with:
```ts
type ParsedCommand =
  | { kind: "list" }
  | { kind: "status"; ticketKey: string }
  | { kind: "cancel"; ticketKey: string }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

export function parseCommand(text: string): ParsedCommand;
```
- Trim, split on whitespace, lowercase verb
- Validate ticket key matches `/^[A-Z][A-Z0-9]+-\d+$/` (uppercase first), else return `unknown`
- Empty / `help` → help

**Task 2.2:** TDD each branch including malformed keys (`abc`, `AWT`, `AWT-`, `awt-1` lowercased before validation).

---

## Phase 3 — Subcommand handlers

Each returns a `string` (Slack mrkdwn) — no Slack I/O inside, so they're trivial to test.

**Task 3.1:** `handleList(runRegistry)`:
- `runRegistry.listAll()` → filter out claiming sentinels (use existing `isClaimingSentinel`)
- Format each row: `• <jiraUrl|TICKET> — runId: \`xxx\`` (link via `JIRA_BASE_URL`)
- Empty list → "No active workflows."

**Task 3.2:** `handleStatus(runRegistry, ticketKey)`:
- Look up `getRunId` + `getSandboxId`
- Return `Not tracked.` / `TICKET → runId, sandbox: yes/no`
- Out of scope: live workflow status from `workflow/api` (add only if registry-only is insufficient in practice)

**Task 3.3:** `handleCancel(runRegistry, ticketKey)`:
- `getRunId(ticketKey)` — if null, return `No active run for TICKET.`
- If runId is a claiming sentinel, return `TICKET is mid-dispatch; try again in a moment.`
- Otherwise call `cancelRun(ticketKey, runId, runRegistry)` and return result message.

**Task 3.4:** TDD with stubbed `RunRegistryAdapter` — assert exact return strings. Don't mock `workflow/api`; instead inject a fake `cancelRun` via parameter so the handler stays a pure function over its dependencies.

---

## Phase 4 — Route wiring (the only place with side effects)

**Task 4.1:** `src/routes/webhooks/slack.post.ts`:
1. `readRawBody` (mirrors Jira webhook).
2. Read headers `x-slack-request-timestamp`, `x-slack-signature`. Verify via Phase 1; on failure `throw createError({ statusCode: 401 })`.
3. Parse `application/x-www-form-urlencoded` → `{ command, text, response_url, user_id, channel_id }`.
4. Optional allowlist: if `SLACK_ALLOWED_USER_IDS` set and `user_id` not in it, reply 200 with ephemeral "Not authorized."
5. `parseCommand(text)`. For `unknown`/`help`, respond synchronously with usage.
6. For real commands: respond **immediately** with `{ response_type: "ephemeral", text: "Working on \`${command} ${text}\`…" }` (Slack's 3s budget).
7. Schedule the handler in the background:
   ```ts
   event.waitUntil(runHandler(parsed, response_url, adapters));
   ```
   `runHandler` calls the appropriate `handle*`, then POSTs `{ response_type: "in_channel", text: result }` to `response_url`.
8. `createAdapters()` is reused — same shape as Jira webhook.

**Task 4.2:** `src/lib/slack/respond.ts`:
- `postToResponseUrl(url, payload)` — `fetch(url, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } })`
- Log + swallow on failure (matches existing messaging adapter philosophy: notifications never break flows).

**Task 4.3:** Integration test (vitest) that boots the route via Nitro test util or by calling the handler directly with a hand-crafted h3 event:
- Valid signature + `list` → 200, ack body shape correct, `response_url` POSTed with formatted list.
- Invalid signature → 401.
- Disallowed user → 200 + "Not authorized."
- `cancel AWT-42` with no entry → "No active run."
- `cancel AWT-42` with entry → `cancelRun` invoked once with the right args.

---

## Phase 5 — Slack app config + docs (no code, but blocks shipping)

**Task 5.1:** In api.slack.com app settings:
- Slash Commands → add `/ai-workflow` → request URL `https://<host>/webhooks/slack`.
- Reinstall app (`commands` scope is already granted on most chat-adapter installs; verify).
- Copy the Signing Secret into Vercel env (`SLACK_SIGNING_SECRET`) for Production + Preview.

**Task 5.2:** Update `init-slack` skill (`.claude/skills/init-slack`) to also prompt for `SLACK_SIGNING_SECRET` and mention the slash-command URL. Add a one-paragraph operator note in `README.md` under the existing Slack section.

---

## Verification checklist

- [ ] `pnpm test` passes (new unit + integration tests)
- [ ] Locally: `vercel dev` + `ngrok` → run `/ai-workflow list` from Slack, see ack <3s and final list message
- [ ] Bad-signature curl returns 401
- [ ] `/ai-workflow cancel AWT-<real ticket>` cancels the run and posts confirmation
- [ ] Workflow-side: registry entry gone, sandbox stopped, Jira thread shows the existing cancel notification (already handled by `cancelRun`'s downstream)

---

## Risks / open questions

1. **`event.waitUntil` on Nitro/Vercel preset** — confirm h3 exposes it (or use Nitro's `event.context.waitUntil` if applicable). Fallback: do the work synchronously and rely on Slack's 3s being usually achievable for a single Redis read; cancel uses two extra ops which is borderline. Safer to confirm waitUntil first.
2. **Multi-channel installs** — current outbound adapter is single-channel via `CHAT_SDK_CHANNEL_ID`. Slash commands can come from any channel the bot is in; `response_url` makes that fine for replies, but if you want to *restrict* commands to one channel, add a channel allowlist alongside the user one.
3. **Concurrency** — `cancel` racing the dispatch claim is already handled by `dispatch.ts`'s post-claim verification, so no new logic needed.
