# Slack Threaded Messages Design

## Problem

Today, every per-ticket notification posts as a top-level message in the configured Slack channel. The `MessagingAdapter.notify(message)` interface has no concept of conversation grouping, so a single ticket can produce 3–5 unrelated-looking messages scattered across the channel:

```text
[10:01] Task AWT-42 started
[10:14] Task AWT-42 needs clarification
[14:02] Task AWT-42 PR ready for review
[16:30] Task AWT-42 canceled: webhook confirmed ticket is outside AI column.
```

Two consequences:

1. The channel becomes hard to read — messages from different tickets interleave.
2. There is no clickable path from a Slack notification to the underlying Jira ticket or the GitHub PR. Readers have to copy the identifier and search.

## Solution

Make the `MessagingAdapter` ticket-aware. The first message about a ticket — `Task X started` — posts at top level and its Slack message timestamp is recorded as the **lifetime parent** for that ticket. Every subsequent message about the same ticket is posted as a thread reply under that parent. Clarification, PR-ready, failure, and cancellation messages all reply into the same thread.

In addition, the ticket identifier in every message becomes a clickable Jira link, and the `pr_ready` event includes a clickable GitHub PR reference.

## Scope

In scope:

- A new `notifyForTicket(ticketKey, event)` method on `MessagingAdapter` that replaces the existing `notify(message)`.
- A new `ThreadStore` interface (`getParent`, `setParent`, `clearParent`) implemented on `UpstashRunRegistry`.
- A new Redis hash `blazebot:thread-parents:{ENV_PREFIX}` for ticket → message-id mappings.
- Structured `TicketEvent` types replacing inline-string concatenation in `agent.ts`, `cron/poll.get.ts`, and `webhooks/jira.post.ts`.
- Slack-mrkdwn link formatting for the Jira ticket identifier and the PR reference.

Out of scope:

- Adding new notification events. The set of events stays exactly as today (start, clarification, PR-ready, failure, cancel).
- Threading for non-ticket notifications. There are none in the current code.
- A `notify(message)` escape hatch for non-ticket-scoped messages. All call sites are ticket-scoped; we drop the method entirely.
- Cross-ticket grouping (e.g., one thread per cron tick).

## Threading Policy

**Lifetime threading.** One Slack thread per ticket, indefinitely. If a ticket cycles through the AI column multiple times (initial run, then a fix-up after PR review feedback), every message lands in the same thread the original `Task X started` message established.

Trade-off accepted: very long-lived tickets (months) may eventually have threads that scroll off Slack's reasonable retrieval window. If this becomes a problem in practice, switching to "thread per run" is a localized change — key the `ThreadStore` lookup by `ticketKey + runStartedAt` and add a `clearParent` call at the start of every run.

**Top-level fallback when no parent exists.** Three cases collapse into one rule:

| Case | Behavior |
|---|---|
| No mapping for this ticket yet | Post top-level. Record parent **only if** the event is `started`. |
| Mapping exists, but Slack returns "thread/message not found" (parent deleted) | Catch the error, clear the mapping, retry top-level. Re-establish parent only if the event is `started`. |
| Mapping exists and parent is alive | Post as thread reply. |

Implication: out-of-band events that arrive before any `started` (e.g., a webhook cancellation racing the workflow's first message) post as standalone top-level messages and **do not** establish a parent. Only `started` is allowed to anchor a thread, because only `started` carries the implicit promise that more updates are coming.

## Architecture

```text
                           UpstashRunRegistry
                           ├── HASH_KEY            (ticket → runId)
                           ├── SANDBOX_HASH_KEY    (ticket → sandboxId)
                           ├── ENTRY_TS_HASH_KEY   (ticket → createdAt)
                           ├── FAILED_HASH_KEY     (ticket → failure meta)
                           └── THREAD_HASH_KEY     (ticket → slack message ts)  ← NEW

Workflow / cron / webhook
        │
        ▼
ChatSDKAdapter.notifyForTicket(ticketKey, event)
        │
        ├── threadStore.getParent(ticketKey)
        ├── format(event, ticketKey, jiraBaseUrl)  →  Slack-mrkdwn string
        ├── chat.channel(...).post(text, { thread_ts? })
        └── if event.kind === "started" && no parent existed:
              threadStore.setParent(ticketKey, sentMessage.id)
```

`MessagingAdapter` is the "smart" layer (this is the deliberate choice from approach 1 of brainstorming). It knows how to:

1. Post Slack messages.
2. Format `TicketEvent`s into wire text with embedded Jira/PR links.
3. Read and write parent-message-id mappings via an injected `ThreadStore`.

The `ThreadStore` interface is bounded to three methods so the adapter only depends on the slice of run-registry behavior it needs:

```ts
export interface ThreadStore {
  getParent(ticketKey: string): Promise<string | null>;
  setParent(ticketKey: string, messageId: string): Promise<void>;
  clearParent(ticketKey: string): Promise<void>;
}
```

`UpstashRunRegistry` implements this interface in addition to `RunRegistryAdapter`. Both interfaces are satisfied by the same class instance — the existing Redis client is reused.

## Event Types and Formatting

```ts
export type TicketEvent =
  | { kind: "started" }
  | { kind: "needs_clarification"; usageReport?: string }
  | { kind: "pr_ready"; pr: { url: string; number: number }; usageReport: string }
  | {
      kind: "failed";
      phase?: "research" | "impl" | "push";
      reason?: string;
      usageReport?: string;
    }
  | { kind: "canceled"; reason: string };
```

Formatter output (using Slack-native `<url|label>` mrkdwn syntax):

| Event | Rendered text |
|---|---|
| `started` | `Task <https://JIRA/browse/AWT-42\|AWT-42> started` |
| `needs_clarification` | `Task <https://JIRA/browse/AWT-42\|AWT-42> needs clarification` (+ `\n<usageReport>` if present) |
| `pr_ready` | `Task <https://JIRA/browse/AWT-42\|AWT-42> PR ready for review — <https://github.com/.../pull/123\|#123>\n<usageReport>` |
| `failed` | With phase: `Task <https://JIRA/browse/AWT-42\|AWT-42> failed: <phase> — <reason>`. Without phase (catch-all): `Task <…\|AWT-42> failed: <reason>`. Without reason or phase (extreme edge case): `Task <…\|AWT-42> failed`. (+ `\n<usageReport>` appended in all variants if non-empty.) |
| `canceled` | `Task <https://JIRA/browse/AWT-42\|AWT-42> canceled: <reason>` |

`ChatSDKConfig` grows by one field, `jiraBaseUrl: string`, supplied from `env.JIRA_BASE_URL`. The link is built as `${jiraBaseUrl.replace(/\/$/, '')}/browse/${ticketKey}` — defensive trim on a trailing slash because the env value is user-configured.

The `<url|label>` syntax is not standard markdown. Two implementation options will be evaluated during build:

1. Use the chat package's `link` AST node (`link("AWT-42", "https://...")`) inside a `PostableMessage` and let the Slack adapter render it. Preferred if it produces correct mrkdwn.
2. Pass a `PostableRaw` Slack-formatted string to bypass mdast escaping. Fallback if option 1 escapes the angle brackets.

Verified during implementation by posting one of each event type to a real Slack channel.

## Adapter Behavior (Pseudocode)

```pseudo
notifyForTicket(ticketKey, event):
  parent = threadStore.getParent(ticketKey)
  text   = format(event, ticketKey, jiraBaseUrl)

  try:
    sent = post(text, threadParentId: parent ?? undefined)
  catch e if isMissingParentError(e):
    threadStore.clearParent(ticketKey)
    sent = post(text)                    // top-level retry
    parent = null

  if event.kind === "started" && parent == null && sent != null:
    threadStore.setParent(ticketKey, sent.id)
```

Failure semantics match today's `notify(message)`: any error from the post (after the missing-parent retry) is caught and logged at `warn`. `notifyForTicket` never throws — workflow runs are never broken by a notification failure.

`isMissingParentError` discriminates on the Slack error code surfaced by the chat package. Likely candidates: `thread_not_found`, `message_not_found`. The exact discriminator is finalized during implementation by deliberately deleting a parent message in a test channel.

## Call-Site Changes

### `src/workflows/agent.ts`

Replace the existing `notifySlack(message: string)` step:

```ts
async function notifyTicket(ticketKey: string, event: TicketEvent) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notifyForTicket(ticketKey, event);
}
```

Each existing call site converts:

| Line | Today | After |
|---|---|---|
| 441 | `notifySlack(\`Task ${id} started\`)` | `notifyTicket(id, { kind: "started" })` |
| 518 | research-timeout `notifySlack(...)` | `notifyTicket(id, { kind: "failed", phase: "research", reason: "phase timed out", usageReport })` |
| 536 | research clarification | `notifyTicket(id, { kind: "needs_clarification", usageReport })` |
| 543 | research failure | `notifyTicket(id, { kind: "failed", phase: "research", reason: research.body.slice(0,200), usageReport })` |
| 587 | impl clarification | `notifyTicket(id, { kind: "needs_clarification", usageReport })` |
| 594 | impl failure | `notifyTicket(id, { kind: "failed", phase: "impl", reason: implOutput.error, usageReport })` |
| 653 | push failure | `notifyTicket(id, { kind: "failed", phase: "push", reason: pushResult.error, usageReport })` |
| 665 | PR ready | `notifyTicket(id, { kind: "pr_ready", pr: { url: pr.url, number: pr.id }, usageReport })` |
| 674 | catch-all | `notifyTicket(id, { kind: "failed", reason: err.message ?? "unknown", usageReport })` |

Two extra wiring details for line 665:

- `createPullRequest(...)` already returns the `PullRequest`, but the result is currently discarded on line 659. Capture it. Both branches (new PR path and existing-PR path) provide `{ url, id (number), branch }` — `prContext` is reusable directly.
- The trailing `${usageReport}` newline-prefix moves into the formatter; pass `usageReport` as a structured field, not concatenated.

`usageReport` is computed at the call site exactly as today (`formatUsageReport(...)`) and passed in as a string field. The formatter prepends `\n` when emitting it. An empty string is treated as absent (no trailing newline emitted) — equivalent to `undefined`. This matches the current behavior of `usageSuffix()` returning `""` when `phaseUsages` is empty.

### `src/routes/cron/poll.get.ts:23`

```ts
await adapters.messaging.notifyForTicket(ticketKey, { kind: "canceled", reason: detail });
```

### `src/routes/webhooks/jira.post.ts:110`

```ts
await adapters.messaging.notifyForTicket(ticketKey, {
  kind: "canceled",
  reason: "webhook confirmed ticket is outside AI column",
});
```

### Adapter wiring

`src/lib/adapters.ts` and `src/lib/step-adapters.ts` both pass three new ingredients into `ChatSDKAdapter`:

- `jiraBaseUrl: env.JIRA_BASE_URL`
- `threadStore: runRegistry` (the `UpstashRunRegistry` instance now satisfies both `RunRegistryAdapter` and `ThreadStore`)

Order: instantiate the run registry first, then pass it into the messaging adapter. Both factories already construct the registry, so this is a one-line reorder.

## Redis Data Model

**Hash key:** `blazebot:thread-parents:{ENV_PREFIX}`

Follows the same pattern as the existing `blazebot:active-runs:{ENV_PREFIX}` hash.

**Field:** Ticket key (e.g., `AWT-42`).

**Value:** Slack message timestamp (the `id` of `SentMessage` returned by `channel.post()`), e.g. `"1700000000.000123"`.

**TTL:** None. Entries are bounded by the number of distinct tickets ever processed; at ~50 bytes per entry and 100k tickets, total cost is ~5 MB. `clearParent` removes individual entries when a parent is detected as deleted on Slack.

**Lifecycle vs `unregister(ticketKey)`:** This hash is **not** touched by `unregister`. The thread mapping outlives a single workflow run, which is the whole point of lifetime threading.

## Testing

### `src/adapters/messaging/chatsdk.test.ts`

Rewrite around `notifyForTicket`. Existing two cases (channel routing, no-throw on failure) port over directly. Add:

- `started` with no parent → posts top-level, calls `threadStore.setParent` with the returned message id.
- Subsequent event with parent set → posts with `thread_ts` equal to the stored parent id; does **not** call `setParent`.
- Non-`started` event with no parent → posts top-level, does **not** call `setParent` (orphan stays orphan).
- Parent deleted on Slack (mock returns a `thread_not_found`-shaped error) → calls `clearParent`, retries top-level, and if the event is `started`, records the new parent.
- Each event variant produces the expected formatted string. Assert on the substring containing the Jira link (and PR link for `pr_ready`).
- `notifyForTicket` swallows post failures (existing no-throw guarantee preserved).

The mock for `chat.channel().post()` returns `{ id: "1700000000.000123" }` so we can assert it lands in the thread store unmodified.

### `src/adapters/run-registry/upstash.test.ts`

Three new cases for the `ThreadStore` methods on `UpstashRunRegistry`:

- `setParent` then `getParent` round-trips the message id.
- `getParent` returns `null` when no entry exists.
- `clearParent` removes the entry; `getParent` then returns `null`.
- `unregister(ticketKey)` does **not** touch the thread hash.

### Workflow integration

`agent.ts` is not directly unit-tested — steps run through Vercel WDK. The existing `e2e/` suite exercises the full flow. No new e2e is added specifically for threading; manual verification on a real Slack channel during PR review is the realistic check (post a `started`, then a `needs_clarification`, confirm the second appears as a reply under the first).

## Migration and Rollout

**In-flight tickets at deploy.** `THREAD_HASH_KEY` starts empty. Tickets currently mid-run have no recorded parent — their next message (which is by construction a non-`started` event such as PR-ready, clarification, or failure) posts top-level and does **not** establish a parent. The first cycle after deploy is therefore a single standalone message; every cycle after that threads correctly. No manual seeding.

**Re-runs of pre-existing tickets.** When a ticket created before deploy re-enters the AI column, `notifyForTicket(id, { kind: "started" })` runs against an empty entry, posts top-level, records the new parent. Lifetime threading then proceeds normally.

**Backwards compatibility.** None preserved. `MessagingAdapter.notify(message)` is removed. The change is internal to this repo (no external callers). Tests are rewritten in the same PR.

**Rollback.** A revert PR restores the prior interface. The `THREAD_HASH_KEY` data left behind in Redis is harmless and ignored by old code. No data cleanup required.

## Observability

The two existing log lines in `chatsdk.ts` get extra structured fields:

- `notification_sent` → adds `ticketKey`, `eventKind`, `threadParentId` (null on top-level posts).
- `notification_failed` → adds `ticketKey`, `eventKind`, and the Slack error code if extractable.

A new debug log line, `thread_parent_recovered`, is emitted when the missing-parent recovery path runs (parent existed, Slack rejected with thread-not-found, retry top-level). This makes the recovery branch visible in production without needing to instrument it later.

## Risks

- **Slack rate limits on `chat.postMessage`.** Threading does not change call frequency — same number of posts as today, just with `thread_ts` sometimes set. No new risk.
- **Bot loses access to a private channel containing the parent.** Surfaces as `channel_not_found` / `not_in_channel`. Same failure mode as today, just with extra context in logs. Operator action (re-invite) unchanged.
- **`<url|label>` mrkdwn rendering.** Not standard markdown. Resolved during implementation by testing one event of each kind against a real Slack channel and choosing between the chat package's `link` AST node and `PostableRaw`. Captured as a learning in `.claude/learnings.md` once verified.
- **Lifetime threads on very long-lived tickets.** A ticket that lives for months may eventually have a parent that's hard to reach in Slack search. If this becomes a real complaint, switching to "thread per run" is a small follow-up (key `ThreadStore` by `ticketKey + runStartedAt`).

## Future Work (not in this change)

- "Thread per run" mode behind a config flag, if lifetime threading proves unwieldy.
- Richer message blocks (Slack Block Kit) for `pr_ready` — buttons for "Open PR" / "Open ticket" instead of inline links.
- Reaction-driven workflow controls (e.g., react with ✅ on the `pr_ready` thread to re-trigger CI). Out of scope here; design only mentions for context.
