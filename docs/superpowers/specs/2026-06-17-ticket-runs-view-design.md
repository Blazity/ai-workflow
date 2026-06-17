# Ticket runs view — design

**Date:** 2026-06-17
**Status:** Approved (design); pending spec review → implementation plan

## Problem

Search (⌘K spotlight) currently jumps straight from a query to a single run's
trace (`/trace/[runId]`). But one Jira ticket (the "task id", e.g. `AWT-738`)
can be processed by **multiple** workflow runs over its lifetime. There is no
view that shows *all runs for a ticket*, no way to compare them, and no
ticket-level cost. The user wants:

1. A view, reached after search, that lists **all runs for a given ticket**.
2. The ability to **inspect an individual run** from there (a ticket has many).
3. **Cost for the whole task** (aggregated across its runs) and **per run**.

## Terminology

The user says "task id"; this means the **Jira ticket key** (`AWT-738`). The
codebase already uses "task" for an Arthur/workflow id in the existing cost view
(`CostByWorkflowEntry.taskId`), and consistently calls the Jira issue a
`ticket` (`workflow_runs.ticket_key`, `TicketLink`, "Search tickets"). To avoid
collision, **all code/routes use `ticket`**; UI labels are free to say "Task".

## Chosen UX: split master–detail

A dedicated ticket page with a sticky cost-rollup header over a two-pane split:
a **runs rail** on the left, the **selected run's full trace inline** on the
right. Switching runs does not leave the page. (Chosen over "drill to full trace
page" and "expandable rows" — see the brainstorming decision.)

```
┌ AWT-738 · Fix stale run state ·············· Jira ↗ ┐
│ 3 runs · $4.21 · 612k tok · 2 success · 1 failed    │   ← sticky rollup header
├──────────────┬──────────────────────────────────────┤
│ RUNS         │  wrun…WY  ● success  opus  $1.80  18m │   ← TraceDetail (reused)
│ ●succ WY ◀   │  ┌────────────────────────────────┐  │
│ ✕fail 3K     │  │ KPIs · flame graph · steps     │  │
│ ●succ 7Q     │  │ Setup▸Research▸Impl▸Review…     │  │
│  $1.80       │  └────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────┘
   pick a run in the rail → its trace renders on the right
```

Mobile (narrow): the split doesn't fit. Show the rollup header + run list; tap a
run → full-screen `/trace/[runId]` (reuse the existing mobile runs pattern).

## Architecture

Follows the existing dashboard pattern verbatim: `page.tsx` (parses route/search
params) → `*-data.tsx` (server component, fetches via `getJSON`) →
`screens/*.tsx` (client renderer) + skeleton + mobile variant.

### 1. Data layer (worker)

**New query** in `apps/worker/src/db/queries/runs-read.ts`:

```ts
listRunsForTicket(opts: {
  db; ticketKey: string; now: Date; jiraBaseUrl: string; modelFallback: string;
}): Promise<TicketRunsResult>
```

- Exact match `workflow_runs.ticket_key = $1` (bound parameter — never
  interpolated; the column is indexed). **Not** ILIKE, so `AWT-738` does not
  match `AWT-7380`.
- Ordered newest-first by `coalesce(started_at, first_seen_at) desc` (reuse
  `effTime()`).
- Reuses the existing row→`Run` mapping from `listRuns`.
- Computes the rollup in JS (run count per ticket is small):
  - `totals.cost` = Σ `cost_usd`
  - `totals.tokens` = Σ (`tokens_input` + `tokens_output`)
  - `totals.runCount`
  - `totals.counts` = outcome breakdown `{success, running, awaiting, failed, blocked}`
    (via `coerceStatus`)
- Resolves ticket identity from the newest row: `{ key, title, url }` (url falls
  back to `${jiraBaseUrl}/browse/${key}` like `listRuns`).

**New route** `apps/worker/src/routes/api/v1/tickets/[ticketKey].get.ts`:
- `GET /api/v1/tickets/:ticketKey` → `TicketRunsResponse`.
- Normalize the param (trim, length-cap) like `parseSearch`.
- On DB error, degrade to `{ available: false, … }` empty envelope (mirror
  `runs.get.ts`), so the dashboard renders its N/A state instead of throwing.
- `Cache-Control: private, max-age=15, stale-while-revalidate=60` (match
  `runs.get.ts`).

**New contract** in `apps/shared/contracts/api.ts`:

```ts
export interface TicketRunsResponse {
  generatedAt: string;
  available: boolean;
  ticket: { key: string; title: string; url: string } | null;
  runs: Run[];
  totals: {
    cost: number;
    tokens: number;
    runCount: number;
    counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
  };
}
```

### 2. Reuse the trace renderer (surgical refactor)

`apps/dashboard/components/cockpit/screens/trace.tsx` currently is one component
`TraceScreen({runId, data})` = `Breadcrumb` + body (run header, KPI grid, error
card, flame-graph step timeline, step inspector), and owns `selectedId` step
state + the 1s `router.refresh()` live-tail.

Extract the body into **`TraceDetail({data})`** (everything below the
breadcrumb, including `selectedId` state and the live-tail effect). Then:
- `TraceScreen` = `Breadcrumb` + `<TraceDetail data={data} />` — `/trace/[runId]`
  behaves identically.
- The ticket split view's right pane renders `<TraceDetail data={selectedDetail} />`.

This avoids duplicating ~300 lines and keeps a single source of truth for trace
rendering. The unavailable-run state (`!data.available || !run`) moves into
`TraceDetail` (it renders its own "Run unavailable" card; `TraceScreen` keeps
showing the breadcrumb above it).

### 3. Ticket page wiring (dashboard)

- `apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx`
  - Reads `params.ticketKey` and `searchParams.run`.
  - `<Suspense key={ticketKey} fallback={<TicketSkeleton/>}>` — keyed on
    `ticketKey` **only**, so changing `?run=` re-renders in place (no skeleton
    flash), exactly like `/runs` keys on `window` only.
- `apps/dashboard/app/ticket-data.tsx` (server)
  - `getJSON<TicketRunsResponse>('/api/v1/tickets/<key>')` (with empty-state
    fallback like `runs-data.tsx`).
  - Pick selected run id: `?run=` if it's a valid run in the list, else the
    newest run.
  - `getJSON<RunDetailResponse>('/api/v1/runs/<selectedId>')` (with
    `runDetailFallback`), only if there is at least one run.
  - Render desktop `TicketScreen` and mobile `TicketMobileScreen` (hidden/shown
    via the same `lg:` breakpoint pattern as `runs-data.tsx`).
- `apps/dashboard/app/ticket-skeleton.tsx` — header + split skeleton.
- `apps/dashboard/components/cockpit/screens/ticket.tsx` (client `TicketScreen`)
  - Sticky rollup header: ticket key · title · "Open ticket ↗" · rollup chips
    (`$total`, total tokens, `N runs`, outcome breakdown).
  - Left rail: one selectable row per run — status pill, short run id, model,
    duration, **per-run cost**, started-ago, PR badge. Active row marked with the
    mariner rail (match the spotlight's active-row treatment). Clicking →
    `router.push('/ticket/<key>?run=<id>')`. Keyboard ↑/↓/↩ navigation.
  - Right pane: `<TraceDetail data={selectedDetail} />`.
  - Empty state when the ticket has no runs.
- `apps/dashboard/components/cockpit/mobile/screens/ticket-mobile.tsx`
  - Rollup header + run list; tap → `/trace/<id>`.

**Tradeoff (accepted):** switching runs is a server refetch (one worker
round-trip via the re-run server component), chosen over adding a client-side
run-detail proxy. It's consistent with how the app already navigates, and the
live-tail `router.refresh()` then refreshes the rail statuses for free.

### 4. Search routing

- `apps/dashboard/components/cockpit/spotlight-search.tsx`: `go(hit)` →
  `router.push('/ticket/<hit.ticket>')` when `hit.ticket` is non-empty; fall
  back to `/trace/<hit.id>` for ticketless gate runs.
- `apps/dashboard/app/api/runs/search/route.ts`: **dedupe hits by ticket** — one
  palette row per ticket (keep the newest run's status/title), with a "N runs"
  hint; ticketless hits stay run-level. (Hit payload gains an optional
  `runCount`.)
- `apps/dashboard/components/cockpit/screens/trace.tsx` `Breadcrumb`: add a
  ticket crumb (`← Runs / AWT-738 / runId`) linking to `/ticket/<key>`, so the
  standalone trace and the ticket view connect both directions.

### 5. Out of scope (scope guard)

- No new telemetry or cost computation — per-run cost/tokens are already
  persisted (`recordRunUsage`); the ticket cost is a pure read-time sum.
- No change to how runs are recorded or to the registry/live path.
- No restyling of `/runs` or `/trace` beyond the breadcrumb crumb and the
  `TraceDetail` extraction.

## Acceptance criteria

1. `GET /api/v1/tickets/AWT-738` returns that ticket's runs (exact key match),
   the resolved ticket identity, and correct rollup totals (cost = Σ run cost,
   tokens = Σ in+out, run count, outcome breakdown). Unknown key → `available`
   true with empty runs (or `available:false` only on DB error).
2. Visiting `/ticket/AWT-738` shows the rollup header and a runs rail; the newest
   run's trace renders on the right by default.
3. Clicking another run updates the right pane to that run's trace **without a
   skeleton flash** and updates the URL to `?run=<id>`.
4. Per-run cost appears in each rail row; the whole-task cost appears in the
   header.
5. Searching a ticket key in spotlight and pressing ↩ lands on
   `/ticket/<key>` (not directly on a single trace); ticketless hits still open
   the trace.
6. Spotlight shows one row per ticket (deduped), with a run-count hint.
7. `/trace/[runId]` is visually and behaviorally unchanged except for the new
   ticket breadcrumb crumb.
8. A still-running selected run live-tails in the right pane (existing 1s
   refresh), and the rail status updates with it.
9. Mobile: `/ticket/<key>` shows the rollup + run list; tapping a run opens the
   full-screen trace.
10. SQL injection guard preserved: `ticketKey` reaches SQL only as a bound
    parameter; existing `listRuns`/search tests still pass.

## Test plan

- Worker: unit-test `listRunsForTicket` (exact match, rollup math, ticket
  identity from newest row, empty result) alongside `runs-read.test.ts`. Test the
  route's empty-envelope degrade path.
- Dashboard: unit-test the search-dedupe-by-ticket helper. Run-switch in-place
  behavior is covered by the existing Suspense-key pattern (no new test runner;
  dashboard tests run via the worker's tsx, per repo convention).
- Manual: verify against a real multi-run ticket on the demo Neon branch.
