# E2E Test Suite Design

## Overview

End-to-end test suite for the ai-workflow service that validates the full ticket-to-PR pipeline against real external services: Jira, GitHub, Upstash Redis, Vercel Sandbox, and Claude Code agent.

Tests are split into two tiers:
- **Tier 1 (fast, ~5 min):** Integration plumbing — webhooks, polling, capacity, deduplication. No agent.
- **Tier 2 (slow, ~1-2 hours):** Full agent flows — implementation, clarification, review-fix. Real Claude agent in real Vercel Sandbox.

## Decisions

- **Full external integration** — all tests hit real Jira, GitHub, Upstash Redis, Vercel Sandbox.
- **Real Claude agent** — Tier 2 runs the actual agent, not mocks.
- **Structural assertions only** — verify side effects (PR created, ticket moved, comments posted, Redis cleaned) without inspecting agent-generated code.
- **Self-contained tests** — each test creates its own Jira tickets and cleans up after itself.
- **No Slack assertions** — Slack notifications are a side effect, not a core flow. Can be added later.
- **No agent-failure test** — unreliable to force with a real agent. Already covered by unit tests.
- **Trigger:** manual CLI (`npm run test:e2e`) and CI via GitHub Actions `workflow_dispatch`.
- **CI secrets:** GitHub `e2e` environment with optional approval gate.

## File Structure

```
e2e/
├── vitest.e2e.config.ts          # Separate vitest config (long timeouts)
├── helpers/
│   ├── jira.ts                   # Create/delete test tickets, move columns, read comments
│   ├── github.ts                 # Check PRs/branches, cleanup
│   ├── redis.ts                  # Direct Upstash KV reads for assertion + cleanup
│   ├── webhook.ts                # Craft and send signed Jira webhooks
│   └── wait.ts                   # Polling utilities (waitForPR, waitForTicketStatus, etc.)
├── tier1/                        # Fast tests
│   ├── webhook-signature.test.ts
│   ├── webhook-dispatch.test.ts
│   ├── webhook-cancel.test.ts
│   ├── webhook-ignore.test.ts
│   ├── cron-poll.test.ts
│   ├── cron-reconciliation.test.ts
│   └── duplicate-dispatch.test.ts
└── tier2/                        # Slow tests (sequential)
    ├── implementation-happy.test.ts
    ├── clarification-flow.test.ts
    └── review-fix-flow.test.ts
```

## Environment & Configuration

Tests run against a deployed instance. The target URL and service credentials are provided via `.env.e2e` (local) or GitHub environment secrets (CI).

### E2E env vars

```
# Target server
E2E_BASE_URL=https://your-staging.vercel.app

# Jira (for creating test tickets + crafting signed webhooks)
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=
JIRA_PROJECT_KEY=
JIRA_WEBHOOK_SECRET=
COLUMN_AI=AI
COLUMN_AI_REVIEW=AI Review
COLUMN_BACKLOG=Backlog

# GitHub (for PR/branch assertions + cleanup)
GITHUB_TOKEN=
GITHUB_OWNER=
GITHUB_REPO=

# Cron auth
CRON_SECRET=

# Upstash Redis (for registry assertions + cleanup)
AI_WORKFLOW_KV_REST_API_URL=
AI_WORKFLOW_KV_REST_API_TOKEN=
```

`.env.e2e` is gitignored. `.env.e2e.example` is committed.

### npm scripts

```json
{
  "test:e2e": "vitest run --config e2e/vitest.e2e.config.ts",
  "test:e2e:tier1": "vitest run --config e2e/vitest.e2e.config.ts e2e/tier1/",
  "test:e2e:tier2": "vitest run --config e2e/vitest.e2e.config.ts e2e/tier2/"
}
```

## Vitest E2E Config

Separate config at `e2e/vitest.e2e.config.ts`:
- Environment: `node`
- Globals: `true`
- Include: `e2e/**/*.test.ts`
- Sequence: serial (no parallelism between test files)
- Setup file loads `.env.e2e`
- Uses vitest [projects](https://vitest.dev/guide/workspace) to set different timeouts per tier:
  - `e2e/tier1/**` → `testTimeout: 120_000` (2 min)
  - `e2e/tier2/**` → `testTimeout: 2_100_000` (35 min)

## Helper Utilities

### `e2e/helpers/jira.ts`

| Function | Purpose |
|----------|---------|
| `createTestTicket(overrides?)` | Creates ticket with title `[E2E] test-<uuid>`, returns `{ ticketKey, ticketId }` |
| `moveTicketToColumn(ticketKey, column)` | Transitions ticket to target status column |
| `getTicketStatus(ticketKey)` | Reads current ticket status |
| `getTicketComments(ticketKey)` | Reads ticket comments (for clarification assertion) |
| `deleteTicket(ticketKey)` | Deletes ticket (cleanup) |

### `e2e/helpers/github.ts`

| Function | Purpose |
|----------|---------|
| `findPR(branchName)` | Returns PR data or null |
| `getPRCommits(prNumber)` | Returns commit list for assertion |
| `deleteBranch(branchName)` | Cleanup |
| `closePR(prNumber)` | Cleanup |

### `e2e/helpers/redis.ts`

| Function | Purpose |
|----------|---------|
| `getRunId(ticketKey)` | Check if a run is registered |
| `listAll()` | List all active entries |
| `cleanup(ticketKey)` | Force-remove entry (cleanup) |

### `e2e/helpers/webhook.ts`

| Function | Purpose |
|----------|---------|
| `sendJiraWebhook(payload, options?)` | Signs payload with HMAC-SHA256, POSTs to `E2E_BASE_URL/webhooks/jira`. Options: `{ invalidSignature?: boolean, omitSignature?: boolean }` |

### `e2e/helpers/wait.ts`

| Function | Purpose |
|----------|---------|
| `waitFor(fn, { timeout, interval })` | Generic poller: calls `fn` every `interval` until truthy or timeout. Default interval: 5s |
| `waitForPR(branchName, timeout?)` | Polls GitHub until PR appears. Default timeout: 35 min |
| `waitForTicketStatus(ticketKey, status, timeout?)` | Polls Jira until target column. Default timeout: 35 min |
| `waitForRegistryClean(ticketKey, timeout?)` | Polls Redis until entry gone. Default timeout: 35 min |

Tier 1 helper defaults: 30s timeout. Tier 2 helper defaults: 35 min timeout.

## Test Cases

### Tier 1 — Fast Tests

#### `webhook-signature.test.ts`
- Valid signature → 200 OK
- Invalid signature → 401
- Missing signature → 401
- Empty body → 400

#### `webhook-dispatch.test.ts`
- Create ticket in AI column, send signed webhook
- Assert: response `{ action: "dispatch", dispatched: true }`
- Assert: Redis has entry for ticket
- Cleanup: delete ticket, clean Redis

#### `webhook-cancel.test.ts`
- Create ticket, dispatch via webhook
- Move ticket away from AI column, send another webhook
- Assert: response `{ action: "cancel" }`
- Assert: Redis entry removed
- Cleanup: delete ticket

#### `webhook-ignore.test.ts`
- Send webhook for non-status-change event
- Assert: response `{ action: "ignored" }`

#### `cron-poll.test.ts`
- Create ticket in AI column, call `GET /cron/poll` with Bearer token
- Assert: response `discovered >= 1`
- Call without auth → 401
- Cleanup: delete ticket, clean Redis

#### `cron-reconciliation.test.ts`
- Manually insert stale Redis entry (ticketKey not in AI column)
- Call poll endpoint
- Assert: response `cleaned >= 1`, Redis entry removed

#### `duplicate-dispatch.test.ts`
- Create ticket, dispatch via webhook
- Immediately send same webhook again
- Assert: second response `{ reason: "already_claimed" }`
- Cleanup: delete ticket, clean Redis

### Tier 2 — Slow Tests

#### `implementation-happy.test.ts`
- Create ticket: "Add a `GET /ping` endpoint that returns `{ ping: 'pong' }`"
- Move to AI column, send webhook
- `waitForPR("blazebot/<ticket-key>", 35min)` — PR appears
- `waitForTicketStatus(ticketKey, "AI Review")` — ticket moved
- Assert: PR has commits, branch exists, Redis entry cleaned
- Cleanup: close PR, delete branch, delete ticket

#### `clarification-flow.test.ts`
- Create ticket with vague description: "Do the thing"
- Move to AI column, send webhook
- `waitForTicketStatus(ticketKey, "Backlog", 35min)` — ticket moved back
- Assert: ticket has comment with numbered questions, Redis entry cleaned
- Cleanup: delete ticket

#### `review-fix-flow.test.ts`
- Depends on implementation happy path completing first (needs existing PR)
- Add review comment on the PR: "Please rename the endpoint to `/healthcheck`"
- Move ticket back to AI column, send webhook
- `waitForTicketStatus(ticketKey, "AI Review", 35min)` — ticket moved after fix
- Assert: PR has new commits since the review comment, Redis entry cleaned
- Cleanup: close PR, delete branch, delete ticket

**Sequencing:** `implementation-happy` and `review-fix-flow` share a ticket/PR lifecycle. They run in sequence within a single describe block or ordered test files. `clarification-flow` is independent.

## Test Lifecycle & Cleanup

Each test follows:
```
beforeAll → create test resources (tickets, Redis entries, etc.)
test       → trigger flow, wait, assert
afterAll   → cleanup ALL created resources (always runs, even on failure)
```

- Every helper that creates a resource returns an ID pushed to a cleanup array
- `afterAll` iterates in reverse and deletes: tickets, branches, PRs, Redis entries
- Cleanup is best-effort — individual failures are logged but don't fail the test
- Ticket titles prefixed with `[E2E]` so leaked resources are identifiable for manual cleanup

## CI — GitHub Actions

### Workflow file: `.github/workflows/e2e.yml`

```yaml
name: E2E Tests
on:
  workflow_dispatch:
    inputs:
      tier:
        description: "Which tier to run"
        type: choice
        options:
          - tier1
          - tier2
          - all
        default: all
```

- Uses `environment: e2e` to pull secrets from the dedicated GitHub environment
- Runs on `ubuntu-latest`
- Steps: checkout → install deps → build → run selected tier(s)
- When `tier: all`, Tier 1 runs first. Tier 2 runs only if Tier 1 passes.
- Job timeout: 15 min for Tier 1, 2.5 hours for Tier 2
- On failure: upload vitest output as GitHub Actions artifact for debugging
