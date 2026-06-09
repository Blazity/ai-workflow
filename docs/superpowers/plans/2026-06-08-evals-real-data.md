# `/evals` Real-Data Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `/evals` dashboard page from mock data to live worker data, mirroring the overview/runs server-component fetch pattern. Because no evals list endpoint or eval-read path exists yet, this plan also builds the worker contract, route, and Arthur read path as a prerequisite.

**Architecture:** New worker route `GET /api/v1/evals` → `EvalsResponse` (discriminated union, same `available` pattern as `EvalHealthResponse`). A new collector `collect-evals.ts` calls the **confirmed** Arthur read endpoint `POST /api/v1/traces/overview` via a new `getTracesOverview()` method on `ArthurClient`, sums the per-task overviews into a fleet `score`/`spansGraded`/`traceCount`, and degrades to `available: false` when Arthur is unconfigured, unreachable, or nothing is graded. On the dashboard, a thin server route (`page.tsx`) wraps a server component (`evals-data.tsx`) in `<Suspense>`; that component fetches via `getJSON`, falls back to `evalsFallback`, and passes `data` to the client presenter `EvalsScreen`. Identical in shape to `runs-data.tsx` / `RunsScreen`.

**Scope note (read first):** Arthur's read API is confirmed (auth = same `Bearer GENAI_ENGINE_API_KEY`, org-scoped). Our trace path (`POST /api/v1/traces`) only produces `continuous_eval_success_rate`, `eval_count`, `trace_count`, and the three relevance/tool metric types — **and only if continuous evals are configured on the task.** The mock's rule families (hallucination/PII/toxicity/prompt-injection) come from Arthur's `/validate_*` write path, which **we do not call** — they are **out of scope** and dropped from this page. The first increment ships the **fleet aggregate** (score + graded count + window); the per-metric relevance/tool breakdown and trend/sparkline are optional follow-ons (Tasks 3b/3c).

**Tech Stack:** Worker = h3 + Nitro routes, `@shared/contracts` types, Vitest. Dashboard = Next.js App Router, React 19, TypeScript. Dashboard has no test framework — verification is `npx tsc --noEmit`, `next lint`, and a manual browser check.

**Spec:** `docs/superpowers/specs/2026-06-08-evals-real-data-design.md`

**Required env vars (worker):** `GENAI_ENGINE_API_KEY`, `GENAI_ENGINE_TRACE_ENDPOINT` (both already declared optional in `apps/worker/env.ts`; the base read URL is derived from the trace endpoint via `ArthurClient.fromTraceEndpoint`). Reads need the `INFERENCE_READ` permission on the key. No new dashboard env vars — `/evals` reuses `WORKER_BASE_URL` / `WORKER_API_TOKEN` via `getJSON`.

**Remaining open items (non-blocking — see spec Open Questions):** (1) `bucket_size` values for the optional timeseries call; (2) whether empty `task_ids` on `/traces/overview` means "all org tasks" (else enumerate via `/api/v2/tasks/search`); (3) whether continuous evals are actually configured on our live tasks (if not, the page legitimately shows "No graded evals"). None block the aggregate-only increment.

**Note on commits:** This repo's owner stages commits manually. Do NOT commit unless the user explicitly asks. The final task lists the commit command for when they do.

---

### Task 1: Add the `EvalsResponse` contract

**Files:**
- Modify: `apps/shared/contracts/api.ts`

- [ ] **Step 1: Add `EvalMetricRow` and `EvalsResponse`**

Append after the existing `EvalHealthResponse` union:

```ts
export interface EvalMetricRow {
  metric: string;
  metricType: "QueryRelevance" | "ResponseRelevance" | "ToolSelection";
  value: number;
  status: "pass" | "warn" | "fail";
  axis: "quality";
  trend?: number | null;   // only if timeseries wired (Task 3c)
  spark?: number[];        // only if timeseries wired (Task 3c)
}

export type EvalsResponse =
  | {
      available: true;
      generatedAt: string;
      windowHours: number;
      score: number;        // continuous_eval_success_rate × 100, fleet-wide
      spansGraded: number;  // Σ eval_count
      traceCount: number;   // Σ trace_count
      rows: EvalMetricRow[]; // [] in the aggregate-only first cut
    }
  | { available: false; generatedAt: string; reason: string };
```

- [ ] **Step 2: Typecheck shared**

Run: `cd apps/shared && npx tsc --noEmit`
Expected: PASS.

---

### Task 2: Add the dashboard fallback

**Files:**
- Modify: `apps/dashboard/lib/api/fallbacks.ts`

- [ ] **Step 1: Import the type and add the fallback**

Add `EvalsResponse` to the existing `@shared/contracts` import block, then add:

```ts
export function evalsFallback(now: string): EvalsResponse {
  return { available: false, generatedAt: now, reason: "Worker unavailable." };
}
```

- [ ] **Step 2: Typecheck dashboard**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS (the new export is unused so far, but valid).

---

### Task 3: Build the Arthur read path + collector (fleet aggregate)

This is the first, shippable increment: fleet `score` / `spansGraded` / `traceCount`, `rows: []`. The per-metric breakdown (3b) and trend/sparkline (3c) are optional follow-ons below.

**Files:**
- Modify: `apps/worker/src/sandbox/arthur-client.ts` (add a read method)
- Create: `apps/worker/src/lib/overview/collect-evals.ts`
- Create: `apps/worker/src/lib/overview/collect-evals.test.ts`

- [ ] **Step 1: Add `getTracesOverview()` to `ArthurClient`**

Add a method reusing the existing private `request<T>` helper and bearer auth:

```ts
interface TraceOverview {
  task_id: string;
  trace_count: number;
  trace_token_count: number;
  trace_token_cost: number;
  eval_count: number;
  continuous_eval_success_rate: number;
  last_active: string;
}
interface TraceOverviewListResponse { count: number; overviews: TraceOverview[]; }

async getTracesOverview(opts: {
  taskIds: string[];          // may be empty — see Open Q2
  startTime: string;          // ISO
  endTime: string;            // ISO
}): Promise<TraceOverviewListResponse> {
  return this.request<TraceOverviewListResponse>("/api/v1/traces/overview", {
    method: "POST",
    body: JSON.stringify({
      task_ids: opts.taskIds,
      start_time: opts.startTime,
      end_time: opts.endTime,
    }),
  });
}
```

Keep the raw Arthur types local to the client; do not leak them into `@shared/contracts`.

> **Task-id enumeration (Open Q2):** if `task_ids: []` is confirmed to mean "all org tasks", pass `[]`. Otherwise enumerate the org's tasks first. The client already searches tasks via `POST /api/v2/tasks/search` (`findTicketTasks`); add a thin `listAllTasks()` if a full enumeration is needed, or have the collector accept a pre-resolved `taskIds`. Default the collector to receive `taskIds` so the route owns the enumeration policy.

- [ ] **Step 2: Write `collect-evals.ts`**

Mirror `collect-runs.ts`/`collect-kpis.ts` — accept an injected fetcher and resolve to the `available: true` fields minus `generatedAt`:

```ts
export interface CollectEvalsOptions {
  fetchOverview: (o: { taskIds: string[]; startTime: string; endTime: string })
    => Promise<{ overviews: TraceOverview[] }>;
  taskIds: string[];
  windowHours: number;
  now: Date;
}

// Returns { windowHours, score, spansGraded, traceCount, rows } OR a null-ish
// signal when nothing is graded so the route can emit available:false.
export async function collectEvals(opts: CollectEvalsOptions) {
  const endTime = opts.now.toISOString();
  const startTime = new Date(opts.now.getTime() - opts.windowHours * 3_600_000).toISOString();
  const { overviews } = await opts.fetchOverview({ taskIds: opts.taskIds, startTime, endTime });

  const spansGraded = sum(overviews, o => o.eval_count);
  const traceCount  = sum(overviews, o => o.trace_count);
  // weight success rate by eval_count; 0 graded → caller emits unavailable
  const score = spansGraded === 0
    ? 0
    : (sum(overviews, o => o.continuous_eval_success_rate * o.eval_count) / spansGraded) * 100;

  return { windowHours: opts.windowHours, score, spansGraded, traceCount, rows: [] };
}
```

The injected-fetcher boundary keeps the Arthur shape isolated and unit-testable.

- [ ] **Step 3: Unit test the collector**

In `collect-evals.test.ts`, feed stubbed `overviews` and assert: `spansGraded`/`traceCount` are summed, `score` is the eval-count-weighted success rate × 100, and `spansGraded === 0` yields `score === 0` (route turns this into `available:false`). Mirror the style of the existing `collect-*` tests.

Run: `cd apps/worker && npx vitest run src/lib/overview/collect-evals.test.ts`
Expected: PASS.

- [ ] **Step 3b (optional follow-on): per-metric relevance/tool breakdown**

Only the three Arthur metric types exist on our path. To populate `rows`: list spans (`GET /api/v1/traces/spans`), fetch each span's `metric_results` (`GET /api/v1/traces/spans/{span_id}` → `SpanWithMetricsResponse.metric_results`), parse the opaque `details` JSON string per `metric_type` (e.g. relevance → `llm_relevance_score`), aggregate per metric type, and apply a worker-owned pass/warn/fail threshold. Map each to `EvalMetricRow { metric, metricType, value, status, axis: "quality" }`. Add this behind the same collector with extra fetchers; keep `rows: []` until implemented.

- [ ] **Step 3c (optional follow-on): trend/sparkline**

Wire `POST /api/v1/traces/overview/timeseries` (single task per call) to populate `EvalMetricRow.trend`/`spark` from `continuous_eval_success_rate` buckets. **Confirm `bucket_size` allowed values first (Open Q1).** Until wired, omit `trend`/`spark` entirely — no synthetic series.

---

### Task 4: Add the worker route `GET /api/v1/evals`

**Files:**
- Create: `apps/worker/src/routes/api/v1/evals.get.ts`

- [ ] **Step 1: Create the route**

Mirror `apps/worker/src/routes/api/v1/runs.get.ts`:

```ts
import { defineEventHandler, setResponseHeader } from "h3";
import type { EvalsResponse } from "@shared/contracts";
import { env } from "../../../../env.js";
import { ArthurClient } from "../../../sandbox/arthur-client.js";
import { collectEvals } from "../../../lib/overview/collect-evals.js";
import { logger } from "../../../lib/logger.js";

const WINDOW_HOURS = 24;

export default defineEventHandler(async (event): Promise<EvalsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  const generatedAt = new Date().toISOString();

  if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
    return { available: false, generatedAt, reason: "Arthur GenAI Engine not configured." };
  }

  try {
    const client = ArthurClient.fromTraceEndpoint(
      env.GENAI_ENGINE_TRACE_ENDPOINT,
      env.GENAI_ENGINE_API_KEY,
    );
    // Open Q2: pass [] if empty === all org tasks; else enumerate via tasks/search.
    const taskIds: string[] = [];
    const { windowHours, score, spansGraded, traceCount, rows } = await collectEvals({
      fetchOverview: (o) => client.getTracesOverview(o),
      taskIds,
      windowHours: WINDOW_HOURS,
      now: new Date(),
    });
    if (spansGraded === 0) {
      return { available: false, generatedAt, reason: "No graded evals in the last 24h." };
    }
    return { available: true, generatedAt, windowHours, score, spansGraded, traceCount, rows };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "evals_list_failed");
    return { available: false, generatedAt, reason: "Eval grading not wired up yet." };
  }
});
```

- [ ] **Step 2: Typecheck worker**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Hit the route**

Run the worker locally and `curl -H "Authorization: Bearer $WORKER_API_TOKEN" localhost:<port>/api/v1/evals`.
Expected:
- Arthur unconfigured → `{ available: false, ..., reason: "Arthur GenAI Engine not configured." }`.
- Configured but nothing graded → `{ available: false, ..., reason: "No graded evals in the last 24h." }`.
- Configured + graded → `available: true` with `score` / `spansGraded` / `traceCount` (and `rows` once 3b is built).

---

### Task 5: Add the loading skeleton

**Files:**
- Create: `apps/dashboard/app/evals-skeleton.tsx`

- [ ] **Step 1: Create the skeleton**

Mirror `apps/dashboard/app/overview-skeleton.tsx` — header + one card-shaped block (the Quality group):

```tsx
// apps/dashboard/app/evals-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function EvalsSkeleton() {
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Block className="h-10 w-72" />
        <Block className="h-8 w-64" />
      </div>
      <Block className="h-[200px]" />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS.

---

### Task 6: Add the server data component

**Files:**
- Create: `apps/dashboard/app/evals-data.tsx`

- [ ] **Step 1: Create the server component**

Mirror `apps/dashboard/app/runs-data.tsx`:

```tsx
import { getJSON } from "@/lib/api/server";
import { EvalsScreen } from "@/components/cockpit/screens/evals";
import type { EvalsResponse } from "@shared/contracts";
import { evalsFallback } from "@/lib/api/fallbacks";

export async function EvalsData() {
  const now = new Date().toISOString();
  const data = await getJSON<EvalsResponse>("/api/v1/evals").catch(() =>
    evalsFallback(now),
  );
  return <EvalsScreen data={data} />;
}
```

> This will not typecheck until Task 7 changes `EvalsScreen`'s signature. Expected; full typecheck gate is Task 8.

---

### Task 7: Convert `EvalsScreen` to consume real data

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/evals.tsx`

- [ ] **Step 1: Replace imports and signature**

- Remove `import { AIWF_DATA } from "@/lib/data/mock"` and `const D = AIWF_DATA`.
- Add `import type { EvalsResponse, EvalMetricRow } from "@shared/contracts"`.
- Change `export function EvalsScreen()` → `export function EvalsScreen({ data }: { data: EvalsResponse })`.

Also remove `import { jitterSeries } from "@/lib/rng"` (synthetic sparklines are dropped) and the `groups`/`accents`/`titles` axis-map scaffolding — only the single Quality group remains.

- [ ] **Step 2: Handle the unavailable branch**

When `data.available === false`, render the existing header block (eyebrow + title) but replace the chip with a neutral one and the metric cards with a single panel showing `data.reason`. Mirror the reason path in `EvalHealthKPI` (`overview.tsx`). This covers unconfigured, "no graded evals", and worker-down.

- [ ] **Step 3: Drive the available branch**

- Drive the live chip from `data.spansGraded.toLocaleString("en-US")` + `data.windowHours` instead of the hardcoded `12,408 spans · 24h`; surface `data.score` (e.g. as the headline number).
- Render a single **Quality** `CkCard` over `data.rows` (all `axis: "quality"`). If `data.rows` is empty (aggregate-only first cut), render just the score + graded-count header, no per-metric grid.
- Per row: show `metric`, formatted `value`, and the pass/warn/fail `CkChip`.
- Trend/sparkline: render `e.trend` / `<Spark data={e.spark} ... />` **only when present**; otherwise render neither. No `jitterSeries`.

- [ ] **Step 4: Verify no mock/jitter references remain**

Run: `grep -nE "AIWF_DATA|\bD\.|jitterSeries" apps/dashboard/components/cockpit/screens/evals.tsx`
Expected: no matches.

---

### Task 8: Rewrite the route to the server pattern + verify

**Files:**
- Modify: `apps/dashboard/app/(cockpit)/evals/page.tsx`

- [ ] **Step 1: Replace the page with the Suspense + server-component pattern**

```tsx
// apps/dashboard/app/(cockpit)/evals/page.tsx — Arthur evals ("/evals")
import { Suspense } from "react";

import { EvalsData } from "@/app/evals-data";
import { EvalsSkeleton } from "@/app/evals-skeleton";

export default function EvalsPage() {
  return (
    <Suspense fallback={<EvalsSkeleton />}>
      <EvalsData />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck the whole app**

Run: `cd apps/dashboard && npx tsc --noEmit` and `cd apps/worker && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Lint the changed dashboard files**

Run: `cd apps/dashboard && npx next lint --file app/evals-data.tsx --file app/evals-skeleton.tsx --file "app/(cockpit)/evals/page.tsx" --file components/cockpit/screens/evals.tsx`
Expected: no errors.

- [ ] **Step 4: Visual check**

Run: `cd apps/dashboard && pnpm dev` (port 3001), open `http://localhost:3001/evals`.
Expected:
- With the worker unreachable or Arthur unconfigured: header chrome renders + a single reason panel ("Worker unavailable." / "Arthur GenAI Engine not configured."), no crash.
- With Arthur configured but nothing graded (`eval_count = 0`): the "No graded evals in the last 24h." panel.
- With Arthur configured + graded: the real fleet `score` + spans-graded count over the 24h window render; the Quality breakdown appears once Task 3b is built (else just the aggregate header). No sparklines unless Task 3c is wired.

- [ ] **Step 5: Commit (ONLY if the user asks)**

```bash
git add apps/shared/contracts/api.ts \
  apps/worker/src/sandbox/arthur-client.ts \
  apps/worker/src/lib/overview/collect-evals.ts \
  apps/worker/src/lib/overview/collect-evals.test.ts \
  apps/worker/src/routes/api/v1/evals.get.ts \
  apps/dashboard/lib/api/fallbacks.ts \
  apps/dashboard/app/evals-data.tsx \
  apps/dashboard/app/evals-skeleton.tsx \
  "apps/dashboard/app/(cockpit)/evals/page.tsx" \
  apps/dashboard/components/cockpit/screens/evals.tsx
git commit -m "feat: wire /evals to real Arthur eval data"
```

---

## Self-Review

**Spec coverage:**
- `EvalsResponse` / `EvalMetricRow` contract (mapped to `TraceOverviewResponse`; rule families dropped) → Task 1. ✓
- Worker Arthur read path `getTracesOverview()` + `collect-evals.ts` (+ test) → Task 3; optional breakdown/timeseries → 3b/3c. ✓
- Worker route `GET /api/v1/evals` with config-check, `eval_count=0` degrade, error degrade → Task 4. ✓
- `evalsFallback` → Task 2. ✓
- `evals-data.tsx` server component → Task 6. ✓
- `evals-skeleton.tsx` (single Quality block) → Task 5. ✓
- `EvalsScreen` swap (signature, single Quality group, score + spansGraded chip, optional rows/trend/spark, drop `jitterSeries`) → Task 7. ✓
- `page.tsx` server route → Task 8. ✓
- Unavailable / no-graded / worker-down states → Tasks 2, 4, 7; verified in Task 8 Step 4. ✓
- Out-of-scope (New eval button, overview tile, per-span drill-down, synthetic sparklines, `/validate_*` rule families) → not in any task. ✓

**Confirmed dependency:** Arthur read API is ground-truthed (`POST /api/v1/traces/overview`, bearer auth, org-scoped). First increment ships fleet aggregate; per-metric breakdown (3b) and trend (3c) are optional follow-ons. Non-blocking open items (bucket_size, empty-task_ids semantics, whether continuous evals are configured live) noted at top and at their tasks. ✓

**Placeholder scan:** No TBD/TODO; remaining unknowns are the three non-blocking open items, explicitly flagged. ✓

**Type consistency:** `EvalsResponse` imported from `@shared/contracts` in Tasks 2, 4, 6, 7. `EvalsScreen` accepts `{ data: EvalsResponse }` (Task 7) — matches the call site in Task 6. `collectEvals` returns the `available: true` fields (`windowHours`/`score`/`spansGraded`/`traceCount`/`rows`) the route spreads in Task 4. `EvalsSkeleton` (Task 5) matches the import in Task 8. ✓
