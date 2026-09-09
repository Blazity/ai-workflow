# Ticket Runs View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ticket view, reached from search, that lists all runs for a Jira ticket with a task-level cost rollup and lets you inspect each run inline (split master–detail), reusing the existing trace renderer.

**Architecture:** New worker query (`listRunsForTicket`, exact `ticket_key` match) + route (`GET /api/v1/tickets/[ticketKey]`) + contract (`TicketRunsResponse`). Dashboard adds a `/ticket/[ticketKey]` route following the existing `page.tsx → *-data.tsx (server) → screens/*.tsx (client)` pattern. The trace screen's body is extracted into a reusable `TraceDetail` so both `/trace/[runId]` and the ticket split view render it. Spotlight search routes to the ticket view and dedupes hits by ticket.

**Tech Stack:** Next.js App Router (dashboard), h3/nitro + Drizzle/Postgres (worker), Vitest (worker tests), node:test via the worker's tsx (dashboard pure-helper tests), Tailwind + existing cockpit UI primitives.

## Global Constraints

- **Naming:** all code/routes use `ticket` (the Jira ticket key, e.g. `AWT-738`). Do NOT use `task` — the existing cost view already uses "task" for an Arthur/workflow id (`CostByWorkflowEntry.taskId`). UI labels may say "Task".
- **SQL safety:** every caller-supplied value reaches SQL only as a bound parameter — use Drizzle `eq(...)` or `sql` template interpolation of values (which binds), never string concatenation.
- **Worker tests:** Vitest. Run all: `pnpm --filter worker test`. Run one file: `pnpm --filter worker exec vitest run <path>`.
- **Worker typecheck:** `pnpm --filter worker typecheck`.
- **Dashboard has no test runner.** Pure helpers get `node:test` files run via the worker's tsx: `apps/worker/node_modules/.bin/tsx --test apps/dashboard/<path>.test.ts` (pattern established by `apps/dashboard/lib/merge-live-runs.test.ts`).
- **Dashboard typecheck/build:** `pnpm --filter ai-workflow-dashboard build` (runs `next build` → tsc). Faster type-only check: `cd apps/dashboard && npx tsc --noEmit`.
- **Dashboard pattern:** `app/(cockpit)/<screen>/page.tsx` (parses params) → `app/<screen>-data.tsx` (server, fetches via `getJSON`) → `components/cockpit/screens/<screen>.tsx` (client) + `components/cockpit/mobile/screens/<screen>-mobile.tsx` + `app/<screen>-skeleton.tsx`.
- **Reuse UI primitives** from `@/components/ui` (`CkCard`, `CkStatusPill`, `CkChip`, `TicketLink`, `PRLink`, `CkKPI`) and existing theme classes. Do not introduce new design tokens.
- **Known false positive:** the `posttooluse-validate: workflow` hook flags `setInterval`/`fetch` in dashboard `"use client"` components as "use sleep()/import fetch from workflow". These are browser components — IGNORE it; do NOT import from `"workflow"`.

---

### Task 1: Worker — `TicketRunsResponse` contract + `listRunsForTicket` query

Adds the response contract and the read-path query (exact ticket match + cost/token/outcome rollup). Refactors the shared row→`Run` mapping out of `listRuns` so both queries share it (DRY); the existing `listRuns` tests guard the refactor.

**Files:**
- Modify: `apps/shared/contracts/api.ts` (add `TicketRunsResponse`)
- Modify: `apps/worker/src/db/queries/runs-read.ts` (extract `runColumns` + `mapRun`; add `listRunsForTicket`)
- Test: `apps/worker/src/db/queries/runs-read.test.ts` (add a `listRunsForTicket` describe block)

**Interfaces:**
- Produces (contract `apps/shared/contracts/api.ts`):
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
- Produces (query `runs-read.ts`):
  ```ts
  export interface ListRunsForTicketOptions {
    db: Db; ticketKey: string; now: Date; jiraBaseUrl: string; modelFallback: string;
  }
  export interface TicketRunsResult {
    ticket: { key: string; title: string; url: string } | null;
    runs: Run[];
    totals: {
      cost: number; tokens: number; runCount: number;
      counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
    };
  }
  export function listRunsForTicket(opts: ListRunsForTicketOptions): Promise<TicketRunsResult>
  ```
- Consumes: `Db`, `workflowRuns`, `coerceStatus`, `effTime` (existing in `runs-read.ts`); `Run` (`@shared/contracts`).

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/db/queries/runs-read.test.ts`. Add `listRunsForTicket` to the import from `./runs-read.js`, then append:

```ts
describe("listRunsForTicket", () => {
  const base = { db: undefined as unknown as Db, now: NOW, jiraBaseUrl: JIRA, modelFallback: "claude-opus-4-8" };

  it("returns only exact ticket_key matches, newest first", async () => {
    await seed({ runId: "r_old", ticketKey: "AWT-738", startedAt: new Date(NOW.getTime() - 2 * HOUR) });
    await seed({ runId: "r_new", ticketKey: "AWT-738", startedAt: new Date(NOW.getTime() - HOUR) });
    await seed({ runId: "r_other", ticketKey: "AWT-7380" }); // must NOT match (no ILIKE)
    await seed({ runId: "r_unrel", ticketKey: "AWT-1" });

    const res = await listRunsForTicket({ ...base, db, ticketKey: "AWT-738" });

    expect(res.runs.map((r) => r.id)).toEqual(["r_new", "r_old"]);
    expect(res.totals.runCount).toBe(2);
  });

  it("rolls up cost, tokens, and outcome counts across the ticket's runs", async () => {
    await seed({ ticketKey: "AWT-9", status: "success", costUsd: 1.5, tokensInput: 1000, tokensOutput: 500 });
    await seed({ ticketKey: "AWT-9", status: "failed", costUsd: 0.25, tokensInput: 200, tokensOutput: 100 });

    const res = await listRunsForTicket({ ...base, db, ticketKey: "AWT-9" });

    expect(res.totals.cost).toBeCloseTo(1.75, 5);
    expect(res.totals.tokens).toBe(1800);
    expect(res.totals.counts.success).toBe(1);
    expect(res.totals.counts.failed).toBe(1);
  });

  it("resolves ticket identity from the newest row", async () => {
    await seed({ ticketKey: "AWT-9", ticketTitle: "Newest title", startedAt: new Date(NOW.getTime() - HOUR) });
    await seed({ ticketKey: "AWT-9", ticketTitle: "Older title", startedAt: new Date(NOW.getTime() - 3 * HOUR) });

    const res = await listRunsForTicket({ ...base, db, ticketKey: "AWT-9" });

    expect(res.ticket).toEqual({
      key: "AWT-9",
      title: "Newest title",
      url: "https://blazity.atlassian.net/browse/AWT-9",
    });
  });

  it("returns an empty result for an unknown ticket", async () => {
    await seed({ ticketKey: "AWT-1" });
    const res = await listRunsForTicket({ ...base, db, ticketKey: "AWT-404" });
    expect(res.runs).toEqual([]);
    expect(res.totals.runCount).toBe(0);
    expect(res.ticket).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/db/queries/runs-read.test.ts`
Expected: FAIL — `listRunsForTicket is not exported` / not a function.

- [ ] **Step 3a: Add the contract**

In `apps/shared/contracts/api.ts`, after the `RunsResponse` interface (around line 118) add:

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

(`Run` is already imported at the top of the file.)

- [ ] **Step 3b: Extract `runColumns` + `mapRun`, then add `listRunsForTicket`**

In `apps/worker/src/db/queries/runs-read.ts`:

1. Add `eq` to the drizzle import on line 1:
   ```ts
   import { and, count, eq, sql, type SQL } from "drizzle-orm";
   ```

2. Just above `// ── Recent runs list ──` (line ~159), add the shared column set and mapper:

```ts
// Shared run projection + row→Run mapper, used by listRuns and listRunsForTicket.
const runColumns = {
  runId: workflowRuns.runId,
  workflowId: workflowRuns.workflowId,
  workflowName: workflowRuns.workflowName,
  status: workflowRuns.status,
  ticketKey: workflowRuns.ticketKey,
  ticketTitle: workflowRuns.ticketTitle,
  ticketUrl: workflowRuns.ticketUrl,
  model: workflowRuns.model,
  startedAt: workflowRuns.startedAt,
  firstSeenAt: workflowRuns.firstSeenAt,
  durationSec: workflowRuns.durationSec,
  costUsd: workflowRuns.costUsd,
  tokensInput: workflowRuns.tokensInput,
  tokensOutput: workflowRuns.tokensOutput,
  prNumber: workflowRuns.prNumber,
  prUrl: workflowRuns.prUrl,
} as const;

type RunRow = {
  runId: string;
  workflowId: string | null;
  workflowName: string | null;
  status: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  model: string | null;
  startedAt: Date | null;
  firstSeenAt: Date;
  durationSec: number | null;
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  prNumber: number | null;
  prUrl: string | null;
};

function mapRun(r: RunRow, now: Date, tenantOrigin: string, modelFallback: string): Run {
  const eff = r.startedAt ?? r.firstSeenAt;
  const tokens =
    r.tokensInput != null || r.tokensOutput != null
      ? (r.tokensInput ?? 0) + (r.tokensOutput ?? 0)
      : null;
  return {
    id: r.runId,
    workflow: r.workflowId ?? "wf_unknown",
    workflowName: r.workflowName ?? r.workflowId ?? "—",
    status: coerceStatus(r.status),
    ticket: r.ticketKey ?? "",
    actor: "ai-bot",
    model: r.model ?? modelFallback,
    startedAtMin: Math.max(0, Math.round((now.getTime() - eff.getTime()) / 60000)),
    duration: r.durationSec,
    tokens,
    cost: r.costUsd,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: r.ticketTitle ?? r.ticketKey ?? "",
    prNumber: r.prNumber,
    ticketUrl: r.ticketUrl ?? (r.ticketKey ? `${tenantOrigin}/browse/${r.ticketKey}` : ""),
    prUrl: r.prUrl,
  };
}
```

3. In `listRuns`, replace the inline `.select({...})` (lines ~197-214) with `.select(runColumns)`, and replace the `const rows = data.map((r): Run => { ... })` block (lines ~233-259) with:
   ```ts
   const rows = data.map((r) => mapRun(r, now, tenantOrigin, modelFallback));
   ```

4. At the end of the file, add the new query:

```ts
// ── Runs for a single ticket (+ rollup) ──────────────────────────────────────

export interface ListRunsForTicketOptions {
  db: Db;
  ticketKey: string;
  now: Date;
  jiraBaseUrl: string;
  modelFallback: string;
}

export interface TicketRunsResult {
  ticket: { key: string; title: string; url: string } | null;
  runs: Run[];
  totals: {
    cost: number;
    tokens: number;
    runCount: number;
    counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
  };
}

export async function listRunsForTicket(
  opts: ListRunsForTicketOptions,
): Promise<TicketRunsResult> {
  const { db, ticketKey, now, jiraBaseUrl, modelFallback } = opts;
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  const data = await db
    .select(runColumns)
    .from(workflowRuns)
    .where(eq(workflowRuns.ticketKey, ticketKey))
    .orderBy(sql`${effTime()} desc`);

  const runs = data.map((r) => mapRun(r, now, tenantOrigin, modelFallback));

  const counts = { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 };
  let cost = 0;
  let tokens = 0;
  for (const r of runs) {
    counts[r.status] += 1;
    cost += r.cost ?? 0;
    tokens += r.tokens ?? 0;
  }

  const newest = data[0];
  const ticket = newest
    ? {
        key: newest.ticketKey ?? ticketKey,
        title: newest.ticketTitle ?? newest.ticketKey ?? ticketKey,
        url:
          newest.ticketUrl ??
          `${tenantOrigin}/browse/${newest.ticketKey ?? ticketKey}`,
      }
    : null;

  return { ticket, runs, totals: { cost, tokens, runCount: runs.length, counts } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter worker exec vitest run src/db/queries/runs-read.test.ts`
Expected: PASS — new `listRunsForTicket` block green AND the pre-existing `listRuns` tests still green (guards the `mapRun` extraction).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/shared/contracts/api.ts apps/worker/src/db/queries/runs-read.ts apps/worker/src/db/queries/runs-read.test.ts
git commit -m "feat(worker): listRunsForTicket query + TicketRunsResponse contract"
```

---

### Task 2: Worker — `GET /api/v1/tickets/[ticketKey]` route

Thin h3 handler wrapping `listRunsForTicket`, degrading to an empty envelope on DB error (mirrors `runs.get.ts` / `runs/[runId].get.ts`). Routes are not unit-tested in this repo (they import `env`/`getDb`, which trigger t3-env validation at import); verify via typecheck + a manual curl.

**Files:**
- Create: `apps/worker/src/routes/api/v1/tickets/[ticketKey].get.ts`

**Interfaces:**
- Consumes: `listRunsForTicket` (Task 1), `TicketRunsResponse` (Task 1), `env`, `getDb`, `logger`.
- Produces: HTTP `GET /api/v1/tickets/:ticketKey` → `TicketRunsResponse`.

> Import depths mirror the sibling `apps/worker/src/routes/api/v1/runs/[runId].get.ts` exactly (the new file sits at the same nesting depth under `v1/`).

- [ ] **Step 1: Create the route**

Create `apps/worker/src/routes/api/v1/tickets/[ticketKey].get.ts`:

```ts
import { defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import type { TicketRunsResponse } from "@shared/contracts";
import { env } from "../../../../../env.js";
import { getDb } from "../../../../db/client.js";
import { listRunsForTicket } from "../../../../db/queries/runs-read.js";
import { logger } from "../../../../lib/logger.js";

const EMPTY: Omit<TicketRunsResponse, "generatedAt"> = {
  available: false,
  ticket: null,
  runs: [],
  totals: {
    cost: 0,
    tokens: 0,
    runCount: 0,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  },
};

export default defineEventHandler(async (event): Promise<TicketRunsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  const raw = getRouterParam(event, "ticketKey");
  const ticketKey = raw ? decodeURIComponent(raw).trim().slice(0, 100) : "";
  if (!ticketKey) return { generatedAt, ...EMPTY };

  try {
    const model =
      env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
    const { ticket, runs, totals } = await listRunsForTicket({
      db: getDb(),
      ticketKey,
      now: new Date(),
      jiraBaseUrl: env.JIRA_BASE_URL,
      modelFallback: model,
    });
    return { generatedAt, available: true, ticket, runs, totals };
  } catch (err) {
    logger.warn({ err: (err as Error).message, ticketKey }, "ticket_runs_failed");
    return { generatedAt, ...EMPTY };
  }
});
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (optional, requires a local worker with DATABASE_URL)**

Run: `pnpm --filter worker dev`, then in another shell:
`curl -s -H "Authorization: Bearer $WORKER_API_TOKEN" "http://localhost:3000/api/v1/tickets/AWT-738" | head -c 400`
Expected: JSON `{ "generatedAt": ..., "available": true, "ticket": {...}, "runs": [...], "totals": {...} }`. (If no local DB, it returns the `available:false` empty envelope — also acceptable; the route shape is what matters.)

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/routes/api/v1/tickets/
git commit -m "feat(worker): GET /api/v1/tickets/[ticketKey] route"
```

---

### Task 3: Dashboard — extract `TraceDetail` + add ticket breadcrumb crumb

Split `TraceScreen` into `Breadcrumb` + a reusable `TraceDetail` (header, KPIs, error, flame graph, step inspector, `selectedId` state, live-tail). `/trace/[runId]` must look and behave identically; the only visible change is a new ticket crumb in the breadcrumb. `TraceDetail` is exported for reuse by the ticket split view (Task 5).

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/trace.tsx`

**Interfaces:**
- Produces: `export function TraceDetail({ runId, data }: { runId: string; data: RunDetailResponse })` — renders the run body as a `<div className="flex flex-col gap-4">…</div>` (no outer page padding; the unavailable branch returns its `CkCard` directly).
- Produces (unchanged signature): `export function TraceScreen({ runId, data }: { runId: string; data: RunDetailResponse })`.
- Consumes: `RunDetailResponse` (`@shared/contracts`); `useRouter` (`next/navigation`).

- [ ] **Step 1: Refactor `TraceScreen` → `TraceScreen` + `TraceDetail`**

In `apps/dashboard/components/cockpit/screens/trace.tsx`:

1. Replace the current `export function TraceScreen({ runId, data }) { … }` (lines ~115-437) so that the wrapper + breadcrumb live in `TraceScreen` and everything else moves into `TraceDetail`. Concretely:

Replace the function header and the `onBack` line:
```ts
export function TraceScreen({
  runId,
  data,
}: {
  runId: string;
  data: RunDetailResponse;
}) {
  const router = useRouter();
  const onBack = () => router.push("/runs");
  const onTicket = (key: string) => router.push(`/ticket/${encodeURIComponent(key)}`);
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-6 lg:px-6 lg:pt-5 lg:pb-8">
      <Breadcrumb
        runId={runId}
        ticket={data.run?.ticket ?? ""}
        onBack={onBack}
        onTicket={onTicket}
      />
      <TraceDetail runId={runId} data={data} />
    </div>
  );
}

export function TraceDetail({
  runId,
  data,
}: {
  runId: string;
  data: RunDetailResponse;
}) {
  const router = useRouter();
  const { run, steps } = data;
```

2. Keep the live-tail effect, `barMs`, the `useMemo`, `selectedId` state, `onSelect` exactly as they were — they now live in `TraceDetail`. (Delete the old `const onBack = …` line that was here; `onBack` moved to `TraceScreen`.)

3. The unavailable branch inside `TraceDetail` becomes (no padding wrapper, no Breadcrumb):
```tsx
  if (!data.available || !run) {
    return (
      <CkCard eyebrow="Run trace" title="Run unavailable">
        <div className="py-6 text-center text-neutral-500 font-body text-[13px]">
          No trace data for <span className="font-mono">{runId}</span>. The run
          may have expired, or the workflow runtime is unavailable.
        </div>
      </CkCard>
    );
  }
```

4. The main `return (` of `TraceDetail` changes ONLY its outer wrapper class — from
   `<div className="flex flex-col gap-4 px-4 pt-4 pb-6 lg:px-6 lg:pt-5 lg:pb-8">`
   to
   `<div className="flex flex-col gap-4">`
   and its first child is no longer `<Breadcrumb …/>` (that line is removed — the header row that starts with `<div className="flex flex-col gap-3 lg:flex-row …">` becomes the first child). Everything from the run header down to the step-inspector grid is unchanged.

5. Update the `Breadcrumb` component (bottom of file) to render the optional ticket crumb:
```tsx
function Breadcrumb({
  runId,
  ticket,
  onBack,
  onTicket,
}: {
  runId: string;
  ticket: string;
  onBack: () => void;
  onTicket: (key: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 font-body text-[13px] min-w-0">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to runs"
        className="appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-mariner cursor-pointer uppercase tracking-[0.04em] shrink-0"
      >
        ← Runs
      </button>
      {ticket && (
        <>
          <span className="text-[#D2D6DA] shrink-0">/</span>
          <button
            type="button"
            onClick={() => onTicket(ticket)}
            aria-label={`All runs for ${ticket}`}
            className="appearance-none border-0 bg-transparent p-0 font-mono text-[11px] text-mariner cursor-pointer tracking-[0.04em] shrink-0"
          >
            {ticket}
          </button>
        </>
      )}
      <span className="text-[#D2D6DA] shrink-0">/</span>
      <span className="font-mono text-neutral-700 truncate">{runId}</span>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification — `/trace/[runId]` unchanged**

Run: `pnpm --filter ai-workflow-dashboard dev`, open `http://localhost:3001/trace/<some-run-id>`.
Expected: identical layout to before, PLUS the breadcrumb now reads `← Runs / <TICKET> / <runId>` (when the run has a ticket); clicking the ticket navigates to `/ticket/<TICKET>` (404/empty until Task 5 lands — that's fine here).

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/components/cockpit/screens/trace.tsx
git commit -m "refactor(dashboard): extract TraceDetail; add ticket breadcrumb crumb"
```

---

### Task 4: Dashboard — run selection helper, fallback, server data component, skeleton

The non-UI half of the ticket page: a pure `pickSelectedRunId` helper (TDD), the empty-state fallback, the server component that fetches the ticket's runs + the selected run's detail, and the loading skeleton.

**Files:**
- Create: `apps/dashboard/lib/ticket.ts`
- Test: `apps/dashboard/lib/ticket.test.ts`
- Modify: `apps/dashboard/lib/api/fallbacks.ts` (add `ticketRunsFallback`)
- Create: `apps/dashboard/app/ticket-data.tsx`
- Create: `apps/dashboard/app/ticket-skeleton.tsx`

**Interfaces:**
- Produces: `export function pickSelectedRunId(runs: Run[], requested: string | null | undefined): string | null` — `requested` if it matches a run id, else the first (newest) run's id, else `null`.
- Produces: `export function ticketRunsFallback(now: string): TicketRunsResponse`.
- Produces: `export async function TicketData({ ticketKey, run }: { ticketKey: string; run?: string })` — server component rendering `TicketScreen` (desktop) + `TicketMobileScreen` (mobile).
- Produces: `export function TicketSkeleton()`.
- Consumes: `TicketRunsResponse`, `RunDetailResponse`, `Run` (`@shared/contracts`); `getJSON` (`@/lib/api/server`); `runDetailFallback` (`@/lib/api/fallbacks`); `TicketScreen`/`TicketMobileScreen` (Task 5).

> Task 5 creates `TicketScreen`/`TicketMobileScreen`. To keep this task independently green, do the typecheck step (Step 5) AFTER Task 5 if executing strictly in order, OR temporarily stub the two imports. Recommended: run Tasks 4 and 5 as a pair, committing each, and run the full typecheck at the end of Task 5. The node:test for `pickSelectedRunId` (Steps 1-4) is fully self-contained and verifiable now.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/lib/ticket.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSelectedRunId } from "./ticket";
import type { Run } from "@shared/contracts";

function run(id: string): Run {
  return {
    id,
    workflow: "wf_agent",
    workflowName: "Agent",
    status: "success",
    ticket: "AWT-1",
    actor: "ai-bot",
    model: "claude",
    startedAtMin: 0,
    duration: null,
    tokens: null,
    cost: null,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: "t",
    prNumber: null,
    ticketUrl: "",
    prUrl: null,
  };
}

test("returns requested id when it matches a run", () => {
  assert.equal(pickSelectedRunId([run("a"), run("b")], "b"), "b");
});

test("falls back to the first (newest) run when requested is missing/unknown", () => {
  assert.equal(pickSelectedRunId([run("a"), run("b")], undefined), "a");
  assert.equal(pickSelectedRunId([run("a"), run("b")], "zzz"), "a");
});

test("returns null when there are no runs", () => {
  assert.equal(pickSelectedRunId([], "a"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `apps/worker/node_modules/.bin/tsx --test apps/dashboard/lib/ticket.test.ts`
Expected: FAIL — cannot find module `./ticket`.

- [ ] **Step 3: Implement the helper + fallback**

Create `apps/dashboard/lib/ticket.ts`:

```ts
import type { Run } from "@shared/contracts";

/**
 * Pick which run the ticket view shows on the right. Honors the `?run=` URL
 * param when it names a real run; otherwise defaults to the newest run (the
 * worker returns runs newest-first). Returns null only when the ticket has no
 * runs at all.
 */
export function pickSelectedRunId(
  runs: Run[],
  requested: string | null | undefined,
): string | null {
  if (runs.length === 0) return null;
  if (requested && runs.some((r) => r.id === requested)) return requested;
  return runs[0].id;
}
```

In `apps/dashboard/lib/api/fallbacks.ts`, add `TicketRunsResponse` to the type import block (lines 1-11) and append:

```ts
export function ticketRunsFallback(now: string): TicketRunsResponse {
  return {
    generatedAt: now,
    available: false,
    ticket: null,
    runs: [],
    totals: {
      cost: 0,
      tokens: 0,
      runCount: 0,
      counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `apps/worker/node_modules/.bin/tsx --test apps/dashboard/lib/ticket.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the server data component + skeleton**

Create `apps/dashboard/app/ticket-data.tsx`:

```tsx
// apps/dashboard/app/ticket-data.tsx
import { getJSON } from "@/lib/api/server";
import { TicketScreen } from "@/components/cockpit/screens/ticket";
import { TicketMobileScreen } from "@/components/cockpit/mobile/screens/ticket-mobile";
import type { TicketRunsResponse, RunDetailResponse } from "@shared/contracts";
import { ticketRunsFallback, runDetailFallback } from "@/lib/api/fallbacks";
import { pickSelectedRunId } from "@/lib/ticket";

export async function TicketData({
  ticketKey,
  run,
}: {
  ticketKey: string;
  run?: string;
}) {
  const now = new Date().toISOString();
  const data = await getJSON<TicketRunsResponse>(
    `/api/v1/tickets/${encodeURIComponent(ticketKey)}`,
  ).catch(() => ticketRunsFallback(now));

  const selectedRunId = pickSelectedRunId(data.runs, run);
  const detail: RunDetailResponse = selectedRunId
    ? await getJSON<RunDetailResponse>(
        `/api/v1/runs/${encodeURIComponent(selectedRunId)}`,
      ).catch(() => runDetailFallback(now))
    : runDetailFallback(now);

  return (
    <>
      <div className="hidden lg:block">
        <TicketScreen
          ticketKey={ticketKey}
          data={data}
          detail={detail}
          selectedRunId={selectedRunId}
        />
      </div>
      <div className="lg:hidden">
        <TicketMobileScreen ticketKey={ticketKey} data={data} />
      </div>
    </>
  );
}
```

Create `apps/dashboard/app/ticket-skeleton.tsx`:

```tsx
// apps/dashboard/app/ticket-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function TicketSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* Rollup header */}
      <Block className="h-4 w-40" />
      <Block className="h-9 w-[28rem]" />
      <Block className="h-5 w-72" />
      {/* Split: rail + detail */}
      <div className="grid grid-cols-[260px_1fr] gap-4">
        <div className="flex flex-col gap-2">
          <Block className="h-16" />
          <Block className="h-16" />
          <Block className="h-16" />
        </div>
        <Block className="h-[420px]" />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/lib/ticket.ts apps/dashboard/lib/ticket.test.ts apps/dashboard/lib/api/fallbacks.ts apps/dashboard/app/ticket-data.tsx apps/dashboard/app/ticket-skeleton.tsx
git commit -m "feat(dashboard): ticket run-selection helper, fallback, data component, skeleton"
```

---

### Task 5: Dashboard — `TicketScreen` (split master–detail), mobile screen, route

The UI: the route page, the desktop split view (rollup header + runs rail + inline `TraceDetail`), and the mobile list. After this task the full flow works end-to-end.

**Files:**
- Create: `apps/dashboard/components/cockpit/screens/ticket.tsx`
- Create: `apps/dashboard/components/cockpit/mobile/screens/ticket-mobile.tsx`
- Create: `apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx`
- Modify: `apps/dashboard/app/(cockpit)/cockpit-shell.tsx` (add `ticket` to `TITLE_FOR_SCREEN`)

**Interfaces:**
- Consumes: `TicketRunsResponse`, `RunDetailResponse` (`@shared/contracts`); `TraceDetail` (Task 3); `useCockpit().openRun` (`@/components/cockpit/context`); `CkCard`/`CkChip`/`CkStatusPill`/`TicketLink`/`PRLink` (`@/components/ui`); `TicketData`/`TicketSkeleton` (Task 4).
- Produces: `export function TicketScreen({ ticketKey, data, detail, selectedRunId }: { ticketKey: string; data: TicketRunsResponse; detail: RunDetailResponse; selectedRunId: string | null })`.
- Produces: `export function TicketMobileScreen({ ticketKey, data }: { ticketKey: string; data: TicketRunsResponse })`.

- [ ] **Step 1: Create the desktop split screen**

Create `apps/dashboard/components/cockpit/screens/ticket.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { CkCard, CkChip, CkStatusPill } from "@/components/ui";
import { TraceDetail } from "@/components/cockpit/screens/trace";
import type { TicketRunsResponse, RunDetailResponse } from "@shared/contracts";

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
}
/** "2 success · 1 failed" — only nonzero buckets, in a stable order. */
function outcomeSummary(counts: TicketRunsResponse["totals"]["counts"]): string {
  const order: (keyof typeof counts)[] = ["success", "running", "awaiting", "failed", "blocked"];
  return order
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`)
    .join(" · ");
}

export function TicketScreen({
  ticketKey,
  data,
  detail,
  selectedRunId,
}: {
  ticketKey: string;
  data: TicketRunsResponse;
  detail: RunDetailResponse;
  selectedRunId: string | null;
}) {
  const router = useRouter();
  const { ticket, runs, totals } = data;
  const title = ticket?.title || ticketKey;

  const select = (runId: string) =>
    router.push(`/ticket/${encodeURIComponent(ticketKey)}?run=${encodeURIComponent(runId)}`);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Sticky rollup header */}
      <div className="flex flex-col gap-2 px-6 pt-5 pb-4 border-b border-neutral-200 bg-app-bg">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="font-mono text-[11px] text-neutral-700">{ticket?.key ?? ticketKey}</span>
          {ticket?.url && (
            <a
              href={ticket.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-mariner no-underline"
            >
              Open ticket ↗
            </a>
          )}
        </div>
        <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">
          {title}
        </h2>
        <div className="flex items-center gap-2 flex-wrap font-mono text-[11px] text-neutral-700">
          <CkChip tone="coal">{fmtCost(totals.cost)}</CkChip>
          <span>{fmtTokens(totals.tokens)} tok</span>
          <span className="text-neutral-300">·</span>
          <span>{totals.runCount} {totals.runCount === 1 ? "run" : "runs"}</span>
          {outcomeSummary(totals.counts) && (
            <>
              <span className="text-neutral-300">·</span>
              <span>{outcomeSummary(totals.counts)}</span>
            </>
          )}
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="px-6 py-16 text-center font-body text-[13px] text-neutral-500">
          No runs recorded for {ticketKey}.
        </div>
      ) : (
        <div className="grid grid-cols-[280px_1fr] flex-1 min-h-0">
          {/* Runs rail */}
          <nav
            aria-label={`Runs for ${ticketKey}`}
            className="border-r border-neutral-200 overflow-y-auto min-h-0 bg-panel"
          >
            {runs.map((r) => {
              const active = r.id === selectedRunId;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-current={active}
                  onClick={() => select(r.id)}
                  className={`relative w-full appearance-none border-0 border-b border-neutral-200 cursor-pointer text-left flex flex-col gap-1.5 px-4 py-3 ${
                    active ? "bg-mariner-100" : "bg-panel hover:bg-neutral-100"
                  }`}
                >
                  {active && (
                    <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-mariner" aria-hidden="true" />
                  )}
                  <div className="flex items-center gap-2">
                    <CkStatusPill status={r.status} />
                    <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-neutral-700">
                    <span className="truncate">{r.model}</span>
                    <span className="shrink-0">{r.cost === null ? "—" : fmtCost(r.cost)}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px] text-neutral-500">
                    <span className="truncate">{r.id}</span>
                    {r.prNumber && <span className="shrink-0">PR #{r.prNumber}</span>}
                  </div>
                </button>
              );
            })}
          </nav>

          {/* Selected run trace */}
          <div className="overflow-y-auto min-h-0 p-4 lg:p-6">
            {selectedRunId ? (
              <TraceDetail runId={selectedRunId} data={detail} />
            ) : (
              <CkCard eyebrow="Run trace" title="No run selected">
                <div className="py-6 text-center text-neutral-500 font-body text-[13px]">
                  Select a run to inspect.
                </div>
              </CkCard>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create the mobile screen**

Create `apps/dashboard/components/cockpit/mobile/screens/ticket-mobile.tsx`:

```tsx
"use client";

import { CkChip, CkStatusPill, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { TicketRunsResponse } from "@shared/contracts";

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
}

export function TicketMobileScreen({
  ticketKey,
  data,
}: {
  ticketKey: string;
  data: TicketRunsResponse;
}) {
  const { openRun } = useCockpit();
  const { ticket, runs, totals } = data;

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-6">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] text-neutral-500">{ticket?.key ?? ticketKey}</span>
        <h2 className="font-display text-xl font-medium text-neutral-900 m-0">
          {ticket?.title || ticketKey}
        </h2>
        <div className="flex items-center gap-2 flex-wrap font-mono text-[11px] text-neutral-700 mt-1">
          <CkChip tone="coal">{fmtCost(totals.cost)}</CkChip>
          <span>{fmtTokens(totals.tokens)} tok</span>
          <span className="text-neutral-300">·</span>
          <span>{totals.runCount} {totals.runCount === 1 ? "run" : "runs"}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {runs.length === 0 && (
          <div className="bg-panel border border-neutral-200 rounded-sm px-4 py-8 text-center font-body text-[13px] text-neutral-500">
            No runs recorded for {ticketKey}.
          </div>
        )}
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => openRun(r)}
            className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm p-3.5 active:bg-neutral-100"
          >
            <div className="flex items-center gap-2">
              <CkStatusPill status={r.status} />
              <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <CkChip>{r.workflowName}</CkChip>
              {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3 pt-2.5 border-t border-neutral-200 font-mono">
              <div>
                <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">Dur</div>
                <div className="text-[13px] font-semibold text-neutral-900">{r.duration === null ? "—" : `${r.duration}s`}</div>
              </div>
              <div>
                <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">Cost</div>
                <div className="text-[13px] font-semibold text-neutral-900">{r.cost === null ? "—" : fmtCost(r.cost)}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create the route page**

Create `apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx`:

```tsx
// apps/dashboard/app/(cockpit)/ticket/[ticketKey]/page.tsx — Ticket runs ("/ticket/<key>")
import { Suspense } from "react";

import { TicketData } from "@/app/ticket-data";
import { TicketSkeleton } from "@/app/ticket-skeleton";

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketKey: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { ticketKey: raw } = await params;
  const ticketKey = decodeURIComponent(raw);
  const sp = await searchParams;
  const run = typeof sp.run === "string" ? sp.run : undefined;
  // Key on the ticket only: switching the selected run (`?run=`) re-renders in
  // place (no skeleton flash), same trick /runs uses for `q`.
  return (
    <Suspense key={ticketKey} fallback={<TicketSkeleton />}>
      <TicketData ticketKey={ticketKey} run={run} />
    </Suspense>
  );
}
```

- [ ] **Step 4: Register the screen title**

In `apps/dashboard/app/(cockpit)/cockpit-shell.tsx`, add a `ticket` entry to `TITLE_FOR_SCREEN` (after the `trace` line, ~line 36):

```ts
  trace: "Run trace",
  ticket: "Ticket runs",
```

- [ ] **Step 5: Typecheck the whole dashboard (covers Tasks 3-5)**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual verification — end to end**

Run: `pnpm --filter ai-workflow-dashboard dev`, open `http://localhost:3001/ticket/<a-ticket-with-multiple-runs>`.
Expected: rollup header (key · title · Open ticket ↗ · `$total` · tokens · N runs · outcome); left rail lists all runs with per-run cost; the newest run's trace renders on the right. Clicking another run updates the right pane and the URL (`?run=…`) **without a skeleton flash**. Narrow the window below `lg` → the mobile list renders; tapping a run opens `/trace/<id>`.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/components/cockpit/screens/ticket.tsx apps/dashboard/components/cockpit/mobile/screens/ticket-mobile.tsx "apps/dashboard/app/(cockpit)/ticket" apps/dashboard/app/\(cockpit\)/cockpit-shell.tsx
git commit -m "feat(dashboard): ticket runs split master-detail view + route"
```

---

### Task 6: Dashboard — search dedupe-by-ticket + route to ticket view

Make spotlight search land on the ticket view and collapse multiple runs of one ticket into a single result row.

**Files:**
- Modify: `apps/dashboard/app/api/runs/search/route.ts` (dedupe by ticket via a helper)
- Create: `apps/dashboard/app/api/runs/search/dedupe.ts`
- Test: `apps/dashboard/app/api/runs/search/dedupe.test.ts`
- Modify: `apps/dashboard/components/cockpit/spotlight-search.tsx` (route to `/ticket`, show run count)

**Interfaces:**
- Produces:
  ```ts
  export interface SearchHit {
    id: string; ticket: string; ticketTitle: string;
    workflowName: string; status: RunStatus; startedAtMin: number; runCount: number;
  }
  export function dedupeHitsByTicket(rows: Run[]): SearchHit[]
  ```
  One hit per ticket (keeps the first/newest row's fields, counts the rest into `runCount`); ticketless rows (`ticket === ""`) stay individual with `runCount: 1`, preserving input order.
- Consumes: `Run`, `RunStatus` (`@shared/contracts`); `RunsResponse` (existing route).

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/app/api/runs/search/dedupe.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeHitsByTicket } from "./dedupe";
import type { Run } from "@shared/contracts";

function run(over: Partial<Run> & Pick<Run, "id">): Run {
  return {
    workflow: "wf_agent",
    workflowName: "Agent",
    status: "success",
    ticket: "AWT-1",
    actor: "ai-bot",
    model: "claude",
    startedAtMin: 0,
    duration: null,
    tokens: null,
    cost: null,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: "t",
    prNumber: null,
    ticketUrl: "",
    prUrl: null,
    ...over,
  };
}

test("collapses multiple runs of one ticket into a single hit with a count", () => {
  const hits = dedupeHitsByTicket([
    run({ id: "a", ticket: "AWT-9" }),
    run({ id: "b", ticket: "AWT-9" }),
    run({ id: "c", ticket: "AWT-10" }),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "a"); // keeps the first (newest) row
  assert.equal(hits[0].runCount, 2);
  assert.equal(hits[1].id, "c");
  assert.equal(hits[1].runCount, 1);
});

test("keeps ticketless rows individual", () => {
  const hits = dedupeHitsByTicket([
    run({ id: "a", ticket: "" }),
    run({ id: "b", ticket: "" }),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].runCount, 1);
  assert.equal(hits[1].runCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `apps/worker/node_modules/.bin/tsx --test apps/dashboard/app/api/runs/search/dedupe.test.ts`
Expected: FAIL — cannot find module `./dedupe`.

- [ ] **Step 3: Implement the helper**

Create `apps/dashboard/app/api/runs/search/dedupe.ts`:

```ts
import type { Run, RunStatus } from "@shared/contracts";

export interface SearchHit {
  id: string;
  ticket: string;
  ticketTitle: string;
  workflowName: string;
  status: RunStatus;
  startedAtMin: number;
  runCount: number;
}

/**
 * Collapse run rows into one hit per ticket. Input is newest-first, so the kept
 * row is the newest run of each ticket; additional runs only bump `runCount`.
 * Ticketless rows (gate runs) stay individual. Insertion order is preserved.
 */
export function dedupeHitsByTicket(rows: Run[]): SearchHit[] {
  const byTicket = new Map<string, SearchHit>();
  const out: SearchHit[] = [];
  for (const r of rows) {
    const hit: SearchHit = {
      id: r.id,
      ticket: r.ticket,
      ticketTitle: r.ticketTitle,
      workflowName: r.workflowName,
      status: r.status,
      startedAtMin: r.startedAtMin,
      runCount: 1,
    };
    if (!r.ticket) {
      out.push(hit);
      continue;
    }
    const existing = byTicket.get(r.ticket);
    if (existing) {
      existing.runCount += 1;
    } else {
      byTicket.set(r.ticket, hit);
      out.push(hit);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `apps/worker/node_modules/.bin/tsx --test apps/dashboard/app/api/runs/search/dedupe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the helper into the search route**

Replace the body of `apps/dashboard/app/api/runs/search/route.ts` with:

```ts
// apps/dashboard/app/api/runs/search/route.ts
// Same-origin proxy for the spotlight ticket search. Lets the client search as
// it types without the server-only WORKER_API_TOKEN ever reaching the browser.
// Searches across all history (the worker turns `q` into a bound, escaped
// ILIKE over ticket key + title), then collapses runs into one hit per ticket.
import { NextResponse } from "next/server";
import { getJSON, withQuery } from "@/lib/api/server";
import type { RunsResponse } from "@shared/contracts";
import { dedupeHitsByTicket } from "./dedupe";

const MAX_HITS = 8;

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ rows: [] });

  try {
    const data = await getJSON<RunsResponse>(
      withQuery("/api/v1/runs", { window: "all", q }),
    );
    const rows = dedupeHitsByTicket(data.rows).slice(0, MAX_HITS);
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ rows: [] });
  }
}
```

- [ ] **Step 6: Update the spotlight to route to the ticket view + show run count**

In `apps/dashboard/components/cockpit/spotlight-search.tsx`:

1. Add `runCount` to the `Hit` interface (after line 16):
   ```ts
   interface Hit {
     id: string;
     ticket: string;
     ticketTitle: string;
     workflowName: string;
     status: RunStatus;
     startedAtMin: number;
     runCount: number;
   }
   ```

2. Replace `go` (lines ~160-164):
   ```ts
   const go = (hit: Hit | undefined) => {
     if (!hit) return;
     close();
     if (hit.ticket) {
       router.push(`/ticket/${encodeURIComponent(hit.ticket)}`);
     } else {
       router.push(`/trace/${encodeURIComponent(hit.id)}`);
     }
   };
   ```

3. In the result row's mono sub-line (the `.filter(Boolean).join(" · ")` at line ~286), include the run count when there's more than one:
   ```tsx
   <span className="truncate font-mono text-[10px] text-neutral-500 mt-0.5">
     {[
       h.ticket,
       h.workflowName,
       h.runCount > 1 ? `${h.runCount} runs` : `${h.startedAtMin}m ago`,
     ]
       .filter(Boolean)
       .join(" · ")}
   </span>
   ```

   And update the footer hint to "open ticket" where it currently says "open trace" (line ~308):
   ```tsx
   <Kbd>↩</Kbd> open ticket
   ```

- [ ] **Step 7: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Manual verification**

Run: `pnpm --filter ai-workflow-dashboard dev`, press ⌘K, type a ticket key with multiple runs.
Expected: one row per ticket with an "N runs" hint; pressing ↩ (or clicking) lands on `/ticket/<key>` (not a single trace). A ticketless gate-run hit still opens `/trace/<id>`.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/app/api/runs/search/ apps/dashboard/components/cockpit/spotlight-search.tsx
git commit -m "feat(dashboard): search dedupes by ticket and routes to the ticket view"
```

---

## Self-Review

**Spec coverage:**
- Ticket view listing all runs for a ticket → Tasks 1 (query), 2 (route), 5 (screen). ✓
- Split master–detail with inline run inspection → Task 3 (`TraceDetail` extraction) + Task 5 (split layout). ✓
- Whole-task cost + per-run cost → Task 1 (`totals.cost`, per-run `cost` in rows) + Task 5 (header rollup + rail per-run cost). ✓
- Tokens + run count + outcome breakdown rollup → Task 1 (`totals`) + Task 5 (`outcomeSummary`). ✓
- URL-driven `?run=`, in-place switch (no skeleton flash) → Task 5 (page Suspense keyed on `ticketKey`) + Task 4 (`pickSelectedRunId`). ✓
- Search routes to `/ticket/<key>`, dedupe by ticket, ticketless → trace → Task 6. ✓
- Trace breadcrumb ticket crumb → Task 3. ✓
- Mobile fallback (list → `/trace/<id>`) → Task 5 (`TicketMobileScreen`). ✓
- DB-error degrade to empty envelope → Task 2 (route `EMPTY`) + Task 4 (`ticketRunsFallback`). ✓
- SQL injection guard (bound param) → Task 1 (`eq(...)`), exercised by the `AWT-7380` non-match test. ✓
- `/trace/[runId]` unchanged → Task 3 Step 3 manual check; existing `listRuns` tests guard the query refactor. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type consistency:** `TicketRunsResponse` (contract) ↔ `TicketRunsResult` (query) share the `{ ticket, runs, totals{cost,tokens,runCount,counts} }` shape; route composes them with `generatedAt`/`available`. `pickSelectedRunId`, `TicketScreen` props (`ticketKey/data/detail/selectedRunId`), `TicketData` props (`ticketKey/run`), and `SearchHit` (incl. `runCount`) are used consistently across Tasks 4-6. `TraceDetail({ runId, data })` is defined in Task 3 and consumed in Task 5. ✓

**Note on task ordering:** Task 4 imports `TicketScreen`/`TicketMobileScreen` (created in Task 5). Execute 4 and 5 as a pair; the only typecheck that spans both runs at the end of Task 5. Task 4's unit test (`pickSelectedRunId`) is self-contained and passes independently.
