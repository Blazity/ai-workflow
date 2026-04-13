# Jira Ticket Attachments in the Sandbox — Design

**Date:** 2026-04-13
**Status:** Design approved, ready for implementation plan

## Problem

Today, the agent receives a Jira ticket as a `requirements.md` blob containing only text: title, description, acceptance criteria, comments. Any files attached to the ticket in Jira (mockups, PDFs of specs, sample JSON fixtures, screenshots) are invisible to the agent.

We want the agent to have access to those files inside the sandbox so it can read them during research, implementation, and review.

## Scope

**In scope**
- Jira attachments (files uploaded to the issue via the Jira UI).
- All three phases on the same sandbox run (research, implement, review) see the same attachments.
- Best-effort delivery: a single broken attachment does not fail the workflow.

**Out of scope (v1)**
- Following external URLs found in the ticket description/comments. Links stay as text in `requirements.md` for the agent to decide whether to fetch manually inside the sandbox.
- Cross-ticket attachment reuse ("knowledge pack" of files that outlive a single ticket).
- Attachment previews in Slack notifications.
- Content-hash dedup across tickets.

## Key decisions

1. **Jira attachments only.** URL-following was considered and rejected — it introduces SSRF risk, auth headaches (OAuth for Figma/Drive), unpredictable size/content, and is not needed for the v1 use case.
2. **Stage into `/tmp/attachments/` in the sandbox, not into the repo.** `requirements.md` already lives in `/tmp/`, outside the cloned repo. Placing attachments alongside means they are never in `git diff` and therefore never accidentally committed or pushed. No `.gitignore` plumbing needed.
3. **One sandbox per workflow, one staging pass.** The sandbox is provisioned once per ticket (`src/workflows/agent.ts:256`) and reused across all phases. Attachments are fetched once at workflow start and written once after `provisionSandbox`.
4. **Generated index in `requirements.md`.** The ticket description does not always reference attachments by name (someone may just drag a PNG onto the ticket). A short index at the top of `requirements.md` guarantees the agent knows what exists and where to find it.
5. **Per-file retries with skip-on-failure.** A broken attachment is logged, marked in the index, and does not block the workflow.

## Architecture

```
Workflow start (src/workflows/agent.ts)
  ├─ fetchAndValidateTicket        (existing)
  ├─ fetchAttachments              (NEW step — downloads bytes from Jira)
  ├─ createFeatureBranch           (existing)
  ├─ provisionSandbox              (existing — one sandbox for the whole workflow)
  ├─ writeAttachments              (NEW step — writeFiles to /tmp/attachments/)
  │
  ├─ Phase 1: Research   (requirements.md contains the attachments index)
  ├─ Phase 2: Implement  (same index, same files on disk)
  ├─ Phase 3: Review     (same)
  │
  └─ teardownSandbox               (existing — kills sandbox, attachments die with it)
```

Attachments live at `/tmp/attachments/{sanitized-filename}` for the full workflow lifetime.

## Components

### 1. `JiraAdapter` — metadata + download

**File:** `src/adapters/issue-tracker/jira.ts`

Changes:
- Add `attachment` to the `fields=` query in `fetchTicket`.
- Parse `data.fields.attachment` into a new `attachments: JiraAttachmentMeta[]` field on `TicketContent`.
- New method `downloadAttachment(url: string): Promise<Buffer>`:
  - GET with `redirect: "manual"`. On 302, read `Location` and re-GET **without** the `Authorization` header (Atlassian's CDN uses signed URLs; re-sending Basic auth breaks them).
  - Timeout: 30s (AbortSignal).
  - Max redirects: 1.

**New type:** `TicketAttachment` added to `src/adapters/issue-tracker/types.ts`:

```ts
export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}
```

Added to `TicketContent`:

```ts
export interface TicketContent {
  // ...existing fields
  attachments: TicketAttachment[];
}
```

### 2. Workflow step — `fetchAttachments`

**File:** `src/workflows/agent.ts` (new step) and a helper in `src/sandbox/attachments.ts` (new file).

Signature:

```ts
async function fetchAttachments(
  attachments: TicketAttachment[]
): Promise<DownloadedAttachment[]>
```

`DownloadedAttachment`:

```ts
interface DownloadedAttachment {
  filename: string;        // sanitized, collision-resolved
  originalFilename: string;
  mimeType: string;
  size: number;
  content: Buffer;         // present only on success
  failed?: { reason: string; attempts: number };  // present only on failure
}
```

Behavior:
- Iterate attachments in Jira-returned order.
- Enforce caps (see "Safety caps" below) before calling download.
- Call `JiraAdapter.downloadAttachment(url)` with a per-file retry loop (see "Retries").
- Sanitize filename: strip path separators (`/`, `\`), null bytes, leading dots; fall back to `attachment-{id}{ext}` if result is empty.
- Collision handling: if the sanitized filename already exists in the accumulator, append `-{id}` before the extension.
- On download failure after retries, include a `failed` entry (no `content`) so the index can reflect it.

### 3. Workflow step — `writeAttachments`

**File:** `src/workflows/agent.ts` (new step).

```ts
async function writeAttachments(
  sandboxId: string,
  attachments: DownloadedAttachment[]
): Promise<void>
```

- `Sandbox.get({ sandboxId })` then `sandbox.writeFiles(...)` for every entry with `content` defined.
- Path: `/tmp/attachments/{filename}`.
- Skip failed entries (no bytes to write).

### 4. `context.ts` — attachments index

**File:** `src/sandbox/context.ts`

Add an `attachments?: DownloadedAttachment[]` parameter to all four `assembleXContext` functions (`assembleResearchPlanContext`, `assembleImplementationContext`, `assembleImplementationRetryContext`, `assembleReviewContext`).

New helper `formatAttachmentsIndex(attachments)`:

```
## Attachments

The following files from the Jira ticket are available in `/tmp/attachments/`.
Read them when relevant to the task.

- `/tmp/attachments/mockup.png` — image/png, 340 KB
- `/tmp/attachments/api-sample.json` — application/json, 2 KB
- ⚠️ `spec.pdf` — failed to download after 3 attempts (HTTP 500)
```

- Section inserted **once**, right after the `## Ticket ID` / `## Ticket` header block and before `## Description`.
- Omitted entirely only when the ticket had **zero attachments** in Jira. If attachments existed but all failed to download, the section still appears with every entry marked as failed.
- Human-readable size (`340 KB`, `1.2 MB`) via a small `formatBytes` helper.

### 5. `src/sandbox/attachments.ts` (new file)

Exports:
- `fetchAttachmentsWithRetry(jiraAdapter, attachments, caps, logger)` — the core loop used by the workflow step.
- `sanitizeFilename(name, id)` — pure utility.
- `formatAttachmentsIndex(attachments)` — pure formatter.
- `formatBytes(n)` — pure utility.

Kept out of `jira.ts` because retry/caps/sanitize logic is Blazebot-specific, not part of the adapter contract.

## Safety caps

Env-configurable with sane defaults. Declared in `env.ts`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `ATTACHMENT_MAX_FILE_SIZE_MB` | 25 | Per-file cap. Oversize files are skipped and noted in the index. |
| `ATTACHMENT_MAX_TOTAL_SIZE_MB` | 100 | Cumulative cap. Once exceeded, remaining attachments are skipped. |
| `ATTACHMENT_MAX_COUNT` | 20 | Hard cap on number of attachments. |
| `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | 30000 | Per-download timeout. |

All caps are applied **before** downloading — cap decisions use the metadata `size` field returned by Jira, so we never fetch bytes we'll throw away.

## Retries

Two layers:

1. **WDK step-level (free).** The `fetchAttachments` step inherits the default retry behavior from the workflow runtime. If the whole step throws, it re-runs.
2. **Per-file retry loop (inside the step).** Implemented in `fetchAttachmentsWithRetry`:
   - Max 3 attempts.
   - Exponential backoff: 500ms → 2000ms → 5000ms.
   - Retryable errors: network errors (`ECONNRESET`, `ETIMEDOUT`, `AbortError`), HTTP 5xx, HTTP 429 (honors `Retry-After` if present, capped at 10s).
   - Non-retryable: 4xx other than 429 (401/403/404 typically mean auth/missing, not transient).
   - After max attempts: mark the file as failed in the returned array. Do **not** throw from the step — other attachments and the workflow continue.

## Observability

- `pino` logs at `info` for each successfully downloaded attachment: `{ ticketId, filename, mimeType, size, attempts }`.
- `pino` logs at `warn` for each failed or skipped attachment with reason: `{ ticketId, filename, reason, attempts? }`.
- Slack notification text unchanged in v1. (Future: add attachment count to the "started" message.)

## Testing

Unit:
- `JiraAdapter.fetchTicket` parses `attachment` field into `TicketAttachment[]` correctly (including empty array when absent).
- `JiraAdapter.downloadAttachment` follows one 302 and drops `Authorization` on the redirect.
- `sanitizeFilename` — path separators, null bytes, empty-after-sanitize fallback, extension preservation.
- `formatAttachmentsIndex` — happy path, all-failed path, empty path (omitted), mixed.
- `formatBytes` — KB/MB rounding.
- `fetchAttachmentsWithRetry` — enforces size/total/count caps without downloading; retries transient errors; gives up on 404; surfaces `failed` entries after exhausting attempts.
- `assembleResearchPlanContext` / implementation / retry / review — emit index when attachments present; omit section when empty.

Integration:
- End-to-end with a `fetch`-mocked Jira returning 2 attachments (one image, one JSON) → `writeAttachments` called with both → sandbox receives both at expected paths. (Uses existing `@vercel/sandbox` test patterns from `manager.test.ts`.)

## Failure modes and how we handle them

| Failure | Behavior |
|---------|----------|
| Jira metadata fetch fails | Existing `fetchAndValidateTicket` step retry handles it (unchanged path). |
| One file 500s | Retry 3×, then mark failed in index, continue. |
| One file 404s | No retry, mark failed in index, continue. |
| File exceeds `ATTACHMENT_MAX_FILE_SIZE_MB` | Skip, mark in index, continue. |
| Total bytes exceeds `ATTACHMENT_MAX_TOTAL_SIZE_MB` | Skip remaining, mark in index, continue. |
| Count exceeds `ATTACHMENT_MAX_COUNT` | Skip overflow, mark in index, continue. |
| All downloads fail | Step still returns an array (all with `failed` set). Index shows all as failed. Workflow continues. |
| `writeAttachments` fails | WDK step retry. If still failing, workflow fails — this is the correct behavior (sandbox is broken). |

## Migration

No data migration. New steps are additive. Existing tickets without attachments simply get an empty `attachments` array and no index section.

## Open questions

None at design time. All caps are env-configurable so they can be tuned without code changes after v1 ships.
