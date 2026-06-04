# Design: Run-ID labels on tickets → durable ticket↔run mapping

**Date:** 2026-06-03
**Status:** Approved (pending implementation plan)

## Problem

There is no durable mapping between a Jira ticket and the workflow run that
processed it. The only mapping is the Redis `active-runs` hash
(`blazebot:active-runs:<env>`), which maps `ticketKey → runId` **only while a
run is active**.

The dashboard's runs table (`apps/worker/src/lib/overview/collect-runs.ts`)
lists runs from the Vercel Workflow store and tries to recover each run's
ticket from the workflow input via `extractTicket`. But the list call uses
`resolveData: "none"` (required — `"all"` throws on expired runs and blanks the
whole table), so the `input` stays encrypted and `extractTicket` degrades to
`""`. **Result: for completed/older runs the dashboard cannot show which ticket
the run belonged to.**

## Goal

Give every run a durable, ticket-side record of its `runId` so the dashboard
can map ticket ↔ run for completed runs, and operators can see/search the
mapping directly in Jira.

## Decision

Attach a Jira label `run:<runId>` to a ticket when it is dispatched into AI
processing. Labels **accumulate** (re-dispatched tickets carry one label per
run = full history). The dashboard reads these labels back to resolve each
run's ticket.

Chosen over a durable Redis-only mapping because the label is also visible and
JQL-searchable inside Jira, which is valuable to operators.

## Components

### 1. Label helper — `apps/worker/src/lib/labels.ts`

Add alongside the existing `NEEDS_CLARIFICATION_LABEL`:

```ts
export const RUN_LABEL_PREFIX = "run:";
export const runLabel = (runId: string) => `${RUN_LABEL_PREFIX}${runId}`;
```

`run:<runId>` — Jira Cloud labels allow colons; only spaces are forbidden.
Build-time check: confirm a real `handle.runId` contains no spaces (sanitize if
that ever changes). The prefix makes labels JQL-searchable and obvious to
operators.

### 2. Producer — `apps/worker/src/lib/dispatch.ts`

Immediately after the existing `runRegistry.register(ticketKey, handle.runId)`
(currently line 159):

```ts
await issueTracker
  .updateLabels?.(ticketKey, { add: [runLabel(handle.runId)] })
  .catch((err) =>
    logger.warn({ ticketKey, runId: handle.runId, err }, "run_label_add_failed"),
  );
```

- **Placement:** after `register`, so only tickets that actually started a
  workflow and survived the post-start claim verification get labeled.
- **Best-effort:** the workflow has already started; a label failure must not
  fail the dispatch. Caught and logged, never thrown. Dispatch still returns
  `{ started: true, runId }`.
- **Accumulate:** `add` only, never `remove`.
- `updateLabels` is optional on `IssueTrackerAdapter`; call with `?.`.
- Jira accepts the issue key (`ticketKey`) for updates.

### 3. Consumer — `apps/worker/src/lib/overview/collect-runs.ts`

New resolution flow inside `collectRuns`:

1. Collect `runIds` from the listed runs (≤ `limit`, default 50).
2. One JQL query via `issueTracker.searchTickets`:
   `project = "<KEY>" AND labels in ("run:id1", "run:id2", …)`
   → distinct ticket keys carrying any of those run labels.
   (`searchTickets` returns ticket **keys** only.)
3. `fetchTicket` each returned key once; read `.labels`, and for every label
   with the `run:` prefix build `runId → { ticketKey, title }`.
4. Per run, resolve the ticket: **label-map first, `extractTicket` fallback**
   (preserves behavior for legacy/unlabeled runs and non-agent workflows).
   Reuse the title from the map; a small title cache avoids refetching a ticket
   shared by several runs.
5. Empty run list → skip the Jira query. `searchTickets`/Jira failure → log and
   fall back to today's best-effort path (no regression).

Requires `JIRA_PROJECT_KEY` in the collector: add a `projectKey` field to
`CollectRunsOptions`, passed from `runs.get.ts` (where `env` is in scope).

## Data flow

```text
dispatch → start(agentWorkflow) → register(ticketKey, runId)
         → updateLabels(ticketKey, add: ["run:<runId>"])   [best-effort]

dashboard /api/v1/runs → collectRuns
   runsLister.list({resolveData:"none"})           → runs (input encrypted)
   searchTickets(`labels in ("run:<id>"...)`)        → ticket keys
   fetchTicket(key).labels                           → runId→{ticketKey,title}
   per run: map.lookup(runId) ?? extractTicket(run)  → ticket + title + url
```

## Testing

- **dispatch:** successful dispatch calls `updateLabels` with `run:<id>`; a
  rejecting `updateLabels` still yields `{ started: true }` (label failure is
  non-fatal).
- **collect-runs:** a run whose ticket carries a `run:<id>` label resolves to
  that ticket even when `input` is unresolvable; falls back to `extractTicket`
  when no label matches; no Jira query is issued when the run list is empty.

## Out of scope

- No backfill of labels onto already-processed tickets (only new dispatches are
  labeled).
- No changes to the Redis run registry.
