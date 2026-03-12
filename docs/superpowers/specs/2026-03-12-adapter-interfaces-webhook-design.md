# Adapter Interfaces & Jira Webhook Design

## Overview

Define adapter interfaces for all external integrations (ticket, source control, messaging) per PRD requirement #5, and implement a Jira webhook endpoint that receives ticket transition events, parses them, and routes them to stub handlers.

No business logic is implemented — all handlers log "not implemented yet" messages.

**Webhook authentication:** The `POST /webhooks/jira` endpoint requires the `JIRA_WEBHOOK_SECRET` env var and verifies the `X-Hub-Signature` header on every request using HMAC-SHA256. Requests with missing or invalid signatures are rejected with 401.

## Adapter Interfaces

Three adapter interfaces in `src/adapters/`, each in its own file. All methods return Promises. No concrete implementations in this phase.

### TicketAdapter (`src/adapters/ticket.ts`)

```typescript
export interface TicketAdapter {
  getTicket(externalId: string): Promise<Ticket>;
  addComment(externalId: string, body: string): Promise<void>;
  moveTicket(externalId: string, columnName: string): Promise<void>;
}

export interface Ticket {
  externalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  comments: TicketComment[];
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: Date;
}
```

### SourceControlAdapter (`src/adapters/source-control.ts`)

```typescript
export interface SourceControlAdapter {
  createBranch(repoOwner: string, repoName: string, branchName: string, baseBranch: string): Promise<void>;
  createPullRequest(repoOwner: string, repoName: string, title: string, body: string, head: string, base: string): Promise<PullRequest>;
  getPullRequestComments(repoOwner: string, repoName: string, prNumber: number): Promise<PullRequestComment[]>;
  /** Merges baseBranch into branchName (e.g., merge main into feature branch for conflict resolution) */
  mergeBranch(repoOwner: string, repoName: string, branchName: string, baseBranch: string): Promise<void>;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface PullRequestComment {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  fromApprovedReview: boolean;
}
```

### MessagingAdapter (`src/adapters/messaging.ts`)

```typescript
export interface MessagingAdapter {
  sendNotification(channel: string, message: string): Promise<void>;
}
```

## Webhook Layer

### Normalized Event Type (`src/webhooks/types.ts`)

```typescript
export type TicketTransitionEvent = {
  source: "jira" | "linear";
  externalTicketId: string;
  fromColumn: string;
  toColumn: string;
  actor: string;
};
```

All ticket system parsers produce this common shape.

### Jira Parser (`src/webhooks/jira.ts`)

- Accepts the raw Jira webhook request body
- Validates with Zod (checks for `issue`, `changelog` fields)
- Extracts the status transition from `changelog.items` where `field === "status"`
- Returns a `TicketTransitionEvent` or `null` if the webhook isn't a status change

### Webhook Router (`src/webhooks/router.ts`)

Takes a `TicketTransitionEvent` and matches against 4 cases using configurable column names:

1. **`toColumn === AI_COLUMN`** → log `TODO: start new work for ticket {id}`
2. **`toColumn === AI_IN_PROGRESS_COLUMN && fromColumn === AI_REVIEW_COLUMN`** → log `TODO: pick up review comments for ticket {id}`
3. **`toColumn === AI_IN_PROGRESS_COLUMN && fromColumn === BACKLOG_COLUMN`** → log `TODO: resume after clarification for ticket {id}`
4. **`fromColumn === AI_IN_PROGRESS_COLUMN`** (none of the above) → log `TODO: cancel active agent run for ticket {id}`
5. Any other transition → ignore (not relevant to Blazebot)

### Webhook Signature Verification (`src/webhooks/jira.ts`)

`JIRA_WEBHOOK_SECRET` is a required env var; the app will not start without it.

- The raw request body is captured via a custom Fastify content type parser
- The `X-Hub-Signature` header is verified against an HMAC-SHA256 of the raw body using the secret
- Comparison uses `timingSafeEqual` to prevent timing attacks
- Invalid or missing signatures result in a 401 response

### Fastify Route

`POST /webhooks/jira` registered in `src/index.ts`:

- Verifies `X-Hub-Signature` header against `JIRA_WEBHOOK_SECRET` (rejects with 401 on failure)
- Calls the Jira parser
- If parser returns `null` (not a status change), respond 200 OK
- Otherwise, pass the event to the router
- Always respond 200 for authenticated requests (webhook endpoints should not reject)

## Environment Variables

Added to `src/env.ts`:

| Variable | Default | Purpose |
|---|---|---|
| `JIRA_WEBHOOK_SECRET` | *(required)* | HMAC-SHA256 secret for verifying Jira webhook signatures |
| `COLUMN_AI` | `"AI"` | Column that triggers new work |
| `COLUMN_AI_IN_PROGRESS` | `"AI In Progress"` | Column for active agent work |
| `COLUMN_AI_REVIEW` | `"AI Review"` | Column for code review phase |
| `COLUMN_BACKLOG` | `"Backlog"` | Column for clarification parking |

Column names are workflow-level concepts (not Jira-specific), so they use a generic `COLUMN_` prefix. Comparison in the router is **case-insensitive** with whitespace trimmed.

## File Structure

```
src/
  adapters/
    ticket.ts          # TicketAdapter interface + types
    source-control.ts  # SourceControlAdapter interface + types
    messaging.ts       # MessagingAdapter interface + types
  webhooks/
    types.ts           # TicketTransitionEvent type
    jira.ts            # Jira webhook payload parser
    router.ts          # Event → case routing (stub handlers)
  env.ts               # + column name env vars
  index.ts             # + POST /webhooks/jira route
```

## Testing

Following the project's established 1:1 test convention, tests will be written for:

- **`src/webhooks/jira.test.ts`** — Jira parser: valid payload, missing changelog, non-status-change webhook, malformed payload
- **`src/webhooks/router.test.ts`** — Router: each of the 5 cases (start work, review fix, clarification resume, cancel agent, ignore)
- **`src/index.test.ts`** — Updated to include integration test for `POST /webhooks/jira` (200 response, parser → router flow)
