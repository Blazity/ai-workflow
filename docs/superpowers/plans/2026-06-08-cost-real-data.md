# `/cost` Real-Data Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `/cost` (Cost & Usage) dashboard page from mock data to live worker data, mirroring the overview/runs server-component fetch pattern. Cost + token usage come from **Arthur** (the GenAI Engine), which already aggregates token/cost from the OpenInference traces the workflow ships in. **Single PR** — no persistence, no capture.

**Architecture:** New Arthur read methods (`getTracesOverview`, `getTracesTimeseries`, `aggregateSpanTokensByModel`) on the existing `ArthurClient`. A worker collector `collect-cost.ts` calls them and shapes a `CostResponse` (totals, by-task breakdown, by-model breakdown, merged daily series). A new route `GET /api/v1/cost` exposes it, degrading to empty when Arthur is unconfigured/unreachable. The dashboard fetches it server-side via `getJSON`, falls back to an empty `CostResponse`, and passes `data` to the `CostScreen` client presenter. Thin `page.tsx` wraps `cost-data.tsx` in `<Suspense>`. Identical read-path shape to `overview-data.tsx` / `runs-data.tsx`.

**Tech Stack:** Next.js App Router, React, TypeScript, `@shared/contracts`, h3 worker routes, existing `ArthurClient` (fetch + Bearer). Worker has Vitest (`*.test.ts`); dashboard has none — dashboard verification is `npx tsc --noEmit`, `next lint`, and a manual browser check.

**Spec:** `docs/superpowers/specs/2026-06-08-cost-real-data-design.md`

**Note on commits:** This repo's owner stages commits manually. Do NOT commit unless the user explicitly asks. The final task lists the commit command for when they do.

**Live open questions (resolve with the user; the plan assumes the spec's defaults):** `bucket_size` allowed values for the timeseries; whether empty `task_ids` means org-wide (else enumerate tasks); by-model client aggregation acceptable; task→workflow mapping (breakdown stays per-task); window = calendar MTD. See the spec's "Open questions".

---

### Task 1: Add Arthur read methods + types

**Files:**
- Modify: `apps/worker/src/sandbox/arthur-client.ts`
- Modify: `apps/worker/src/sandbox/arthur-client.test.ts`

- [ ] **Step 1: Add response types**

Add interfaces mirroring Arthur's shapes:

```ts
export interface TraceOverviewEntry {
  task_id: string;
  trace_count: number;
  trace_token_count: number;
  trace_token_cost: number | null;
  last_active?: string;
}
export interface TraceTimeseriesPoint {
  timestamp: string;
  trace_count: number;
  trace_token_count: number;
  trace_token_cost: number | null;
}
export interface SpanTokenCost {
  model_name: string | null;
  total_token_count: number | null;
  total_token_cost: number | null;
}
```

- [ ] **Step 2: Add `getTracesOverview`**

```ts
async getTracesOverview(taskIds: string[], startTime: string, endTime: string): Promise<TraceOverviewEntry[]> {
  const { overviews } = await this.request<{ count: number; overviews: TraceOverviewEntry[] }>(
    "/api/v1/traces/overview",
    { method: "POST", body: JSON.stringify({ task_ids: taskIds, start_time: startTime, end_time: endTime }) },
  );
  return overviews;
}
```

- [ ] **Step 3: Add `getTracesTimeseries`** (single task per call; caller fans out + merges)

```ts
async getTracesTimeseries(taskId: string, startTime: string, endTime: string, bucketSize: string): Promise<TraceTimeseriesPoint[]> {
  const res = await this.request<{ points?: TraceTimeseriesPoint[] } | TraceTimeseriesPoint[]>(
    "/api/v1/traces/overview/timeseries",
    { method: "POST", body: JSON.stringify({ task_id: taskId, start_time: startTime, end_time: endTime, bucket_size: bucketSize }) },
  );
  return Array.isArray(res) ? res : (res.points ?? []);
}
```

> The response envelope key is unconfirmed — handle both array and `{ points }`. Confirm against a live call.

- [ ] **Step 4: Add `aggregateSpanTokensByModel`** (the one client-side aggregation)

Fetch span rows for the window via `GET /api/v1/traces/spans` (paginate if the API requires it), then sum `total_token_count`/`total_token_cost` grouped by `model_name`. Return `Array<{ model: string; tokens: number; cost: number }>`. Skip rows with null `model_name`.

- [ ] **Step 5: Test**

Run: `cd apps/worker && pnpm vitest run src/sandbox/arthur-client.test.ts`
Expected: add tests with a stubbed `fetch` asserting each method posts the right body and parses the response (mirror the existing client tests). PASS.

---

### Task 2: Add the `CostResponse` contract

**Files:**
- Modify: `apps/shared/contracts/api.ts`

- [ ] **Step 1: Add the interfaces**

Add `CostByModelEntry`, `CostByWorkflowEntry`, and `CostResponse` exactly as specified in the spec ("Proposed contract").

- [ ] **Step 2: Typecheck shared**

Run: `cd apps/shared && npx tsc --noEmit` (or root `pnpm -w typecheck` if defined)
Expected: PASS.

---

### Task 3: Add the `collectCost` aggregator + worker route

**Files:**
- Create: `apps/worker/src/lib/overview/collect-cost.ts`
- Create: `apps/worker/src/lib/overview/collect-cost.test.ts`
- Create: `apps/worker/src/routes/api/v1/cost.get.ts`

- [ ] **Step 1: Write `collectCost`**

Signature: `collectCost(client: ArthurClient, opts: { now: Date; bucketSize: string }): Promise<Omit<CostResponse, "generatedAt">>`.

Logic:
1. Resolve the window: `start = startOfMonth(now)`, `end = now` (ISO). (Assumption: calendar MTD — see open Q5.)
2. Resolve `taskIds`: enumerate the org's tasks (assumption from open Q2 — pass ids explicitly). Reuse/extend the client's task listing (`/api/v2/tasks/search`); if a true org-wide overview via empty `task_ids` is confirmed, pass `[]` instead.
3. `overviews = await client.getTracesOverview(taskIds, start, end)`.
   - `totals`: sum `trace_token_cost` (→ `totalTokenCost`), `trace_token_count` (→ `totalTokens`), `trace_count` (→ `traceCount`); `costPerRun = totalTokenCost / max(1, traceCount)`. Treat null `trace_token_cost` as 0.
   - `byWorkflow`: one entry per overview → `{ taskId, name, runs, tokens, cost, costPerRun }`. `name` from the task listing (task name = ticket-run id).
4. `byModel = await client.aggregateSpanTokensByModel(...)` → map to `{ model, cost, tokens }`.
5. `daily`: fan out `getTracesTimeseries(taskId, start, end, bucketSize)` per task; **merge points by `timestamp`** summing cost/tokens; sort oldest→newest → `{ date, cost, tokens }[]`.

Keep I/O behind the injected `client` so the aggregation is unit-testable with a fake client (mirror how `collect-runs.ts` takes a `RunsLister`).

- [ ] **Step 2: Write the route**

Mirror `workflows.get.ts`:
```ts
setResponseHeader(event, "Cache-Control", "private, max-age=15, stale-while-revalidate=60");
const generatedAt = new Date().toISOString();
if (!env.GENAI_ENGINE_API_KEY || !env.GENAI_ENGINE_TRACE_ENDPOINT) {
  return { generatedAt, available: false, ...EMPTY };
}
try {
  const client = ArthurClient.fromTraceEndpoint(env.GENAI_ENGINE_TRACE_ENDPOINT, env.GENAI_ENGINE_API_KEY);
  const data = await collectCost(client, { now: new Date(), bucketSize: "day" });
  return { generatedAt, available: true, ...data };
} catch (err) {
  logger.warn({ err: (err as Error).message }, "cost_collect_failed");
  return { generatedAt, available: false, ...EMPTY };
}
```
`EMPTY` = the empty totals/arrays/window matching `costFallback`.

- [ ] **Step 3: Test the aggregator**

Run: `cd apps/worker && pnpm vitest run src/lib/overview/collect-cost.test.ts`
Expected: with a fake client returning fixtures (2 tasks, 2 models, multi-day timeseries), assert totals, `byWorkflow` rows + `costPerRun`, `byModel` grouping, and merged-by-timestamp `daily`. Empty/null inputs → zeros/empty arrays. PASS.

- [ ] **Step 4: Worker typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: PASS.

---

### Task 4: Add the dashboard fallback

**Files:**
- Modify: `apps/dashboard/lib/api/fallbacks.ts`

- [ ] **Step 1: Add `costFallback`**

```ts
export function costFallback(now: string): CostResponse {
  return {
    generatedAt: now,
    available: false,
    window: { start: now, end: now },
    totals: { totalTokenCost: 0, totalTokens: 0, traceCount: 0, costPerRun: 0 },
    byModel: [],
    byWorkflow: [],
    daily: [],
  };
}
```

Add `CostResponse` to the existing `@shared/contracts` import.

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS (no consumers yet).

---

### Task 5: Add the skeleton + server data component, and convert `CostScreen`

**Files:**
- Create: `apps/dashboard/app/cost-skeleton.tsx`
- Create: `apps/dashboard/app/cost-data.tsx`
- Modify: `apps/dashboard/components/cockpit/screens/cost.tsx`

- [ ] **Step 1: Create the skeleton**

Mirror `overview-skeleton.tsx`, shaped to the cost layout (after embellishments are stripped: 3 KPI blocks, a chart+donut row, two table blocks):

```tsx
// apps/dashboard/app/cost-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}
export function CostSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }, (_, i) => <Block key={i} className="h-[100px]" />)}
      </div>
      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-3">
        <Block className="h-[260px]" /><Block className="h-[260px]" />
      </div>
      <Block className="h-[300px]" />
      <Block className="h-[300px]" />
    </div>
  );
}
```

- [ ] **Step 2: Create the server data component**

```tsx
// apps/dashboard/app/cost-data.tsx
import { getJSON } from "@/lib/api/server";
import { CostScreen } from "@/components/cockpit/screens/cost";
import type { CostResponse } from "@shared/contracts";
import { costFallback } from "@/lib/api/fallbacks";

export async function CostData() {
  const now = new Date().toISOString();
  const data = await getJSON<CostResponse>("/api/v1/cost").catch(() =>
    costFallback(now),
  );
  return <CostScreen data={data} />;
}
```

> Will not typecheck until Step 3 changes `CostScreen`'s signature. The full gate is in Task 6.

- [ ] **Step 3: Convert `CostScreen` to consume `data` and strip embellishments**

In `components/cockpit/screens/cost.tsx`:
- Remove `import { AIWF_DATA } from "@/lib/data/mock"`, `import { sparkSeries } from "@/lib/rng"`, the `Spark` import (no longer used), and `const D = AIWF_DATA`.
- Add `import type { CostResponse } from "@shared/contracts";`.
- Signature → `export function CostScreen({ data }: { data: CostResponse })`.
- KPIs: `total = data.totals.totalTokenCost`; tokens = `data.totals.totalTokens`; "Cost / run avg" = `$${data.totals.costPerRun.toFixed(2)}`. **Remove** the "Projection · EoM" KPI tile, the `of $1,200 budget` sub, and all `delta`/`deltaTone` props (no source).
- Header: **remove** the `<CkTabs ... By model/workflow/actor>` and the `Export CSV` button.
- Area chart: feed `data.daily.map(d => d.cost)` and labels `data.daily.map(d => d.date)` (format the ISO date to a short label in-screen); **remove** the inner Cost/Tokens `CkTabs` action.
- Donut: shares computed in-screen from `byModel` — `const totalCost = data.byModel.reduce((a,m)=>a+m.cost,0); shares = data.byModel.map(m => totalCost ? m.cost/totalCost : 0)`; center = `"$" + Math.round(total)`.
- Per-model table: map `data.byModel` → columns `{ m.model, m.tokens, m.cost, share }`. **Remove** the `Vendor` column (not in contract) and the `Trend`/`Spark` column.
- Per-workflow table: map `data.byWorkflow` (already aggregated) → `{ w.name, w.taskId, w.runs, w.tokens, w.cost, w.costPerRun }`. **Remove** the in-component `tokens = runs24h*2400`/`perRun` derivations, the `primary` chip / `gateway` line (not in contract), and the `Trend`/`Spark` column. Header label can stay "Per-workflow breakdown" (rows are per task — see spec mapping note).

- [ ] **Step 4: Verify no mock/embellishment refs remain**

Run: `grep -nE "\bD\.|AIWF_DATA|sparkSeries|Spark|COST_BY_MODEL|HOURS24|Export CSV|deltaTone|By actor" apps/dashboard/components/cockpit/screens/cost.tsx`
Expected: no matches.

---

### Task 6: Rewrite the route + full verification

**Files:**
- Modify: `apps/dashboard/app/(cockpit)/cost/page.tsx`

- [ ] **Step 1: Replace the page with the Suspense + server-component pattern**

```tsx
// apps/dashboard/app/(cockpit)/cost/page.tsx — Cost & usage ("/cost")
import { Suspense } from "react";
import { CostData } from "@/app/cost-data";
import { CostSkeleton } from "@/app/cost-skeleton";

export default function CostPage() {
  return (
    <Suspense fallback={<CostSkeleton />}>
      <CostData />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck both apps**

Run: `cd apps/worker && npx tsc --noEmit && cd ../dashboard && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Lint the changed dashboard files**

Run: `cd apps/dashboard && npx next lint --file app/cost-data.tsx --file app/cost-skeleton.tsx --file "app/(cockpit)/cost/page.tsx" --file components/cockpit/screens/cost.tsx`
Expected: no errors.

- [ ] **Step 4: Visual check**

Run: `cd apps/dashboard && pnpm dev`, open `http://localhost:3001/cost`.
Expected:
- With Arthur configured + traces present: real spend, token totals, per-model donut/table, per-task table, and per-day spend chart render.
- With Arthur unconfigured (env unset) or unreachable: zero/empty state — KPIs `$0.00`/`0`, empty tables, empty chart — no crash.

- [ ] **Step 5: Commit (ONLY if the user asks)**

```bash
git add apps/shared/contracts/api.ts \
  apps/worker/src/sandbox/arthur-client.ts \
  apps/worker/src/lib/overview/collect-cost.ts apps/worker/src/routes/api/v1/cost.get.ts \
  apps/dashboard/lib/api/fallbacks.ts \
  apps/dashboard/app/cost-data.tsx apps/dashboard/app/cost-skeleton.tsx \
  "apps/dashboard/app/(cockpit)/cost/page.tsx" \
  apps/dashboard/components/cockpit/screens/cost.tsx
git commit -m "feat: wire /cost to real Arthur usage data"
```

---

## Self-Review

**Spec coverage:**
- Arthur read methods (`getTracesOverview`, `getTracesTimeseries`, `aggregateSpanTokensByModel`) → Task 1. ✓
- `CostResponse` contract with field-level types → Task 2 (from spec). ✓
- `collectCost` aggregator (totals / byWorkflow=per-task / byModel / merged daily) + `/api/v1/cost` route with Arthur-unconfigured degrade → Task 3. ✓
- `costFallback` empty state → Task 4. ✓
- `cost-data.tsx` + `cost-skeleton.tsx` + `CostScreen` swap with embellishments **removed** (budget, deltas, EoM projection, tabs, CSV, sparklines, vendor/primary/gateway) → Task 5. ✓
- Thin Suspense page → Task 6. ✓
- Arthur-down / unconfigured empty state → fallback (Task 4), route degrade (Task 3), verified (Task 6 Step 4). ✓
- Single PR, no Redis/persistence/capture → no such tasks. ✓

**Reuse check:** Read methods extend the existing `ArthurClient` (same `request<T>` + Bearer auth + `fromTraceEndpoint`). Cost comes straight from Arthur's `*_token_cost` — no client-side pricing, the `pricing.ts`/`usage.ts` Slack path is untouched. Read path reuses `getJSON`/fallback/Suspense. Only new infra is one collector + one route — consistent with runs/overview. ✓

**Placeholder scan:** No TBD/TODO; the only deferred items are the spec's flagged open questions (`bucket_size`, empty `task_ids`, by-model aggregation, task→workflow, window) and the explicitly-removed embellishments. ✓

**Type consistency:** `CostResponse` imported from `@shared/contracts` in `cost-data.tsx` (Task 5), `fallbacks.ts` (Task 4), and the route (Task 3). `CostScreen` accepts `{ data: CostResponse }` (Task 5) matching the call site (Task 5 Step 2). Arthur response types (Task 1) feed `collectCost` (Task 3). ✓
