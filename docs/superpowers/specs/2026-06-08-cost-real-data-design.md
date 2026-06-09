# `/cost` Real-Data Conversion — Design

**Date:** 2026-06-08
**Status:** Draft — has open questions (see end)
**Scope:** Convert the `/cost` (Cost & Usage) dashboard page from mock data to live worker data, mirroring the overview/runs server-component fetch pattern. Cost + token usage come from **Arthur** (the GenAI Engine), which already aggregates token counts and USD cost from the OpenInference traces the workflow ships in.

## Problem

The `/cost` page (`apps/dashboard/app/(cockpit)/cost/page.tsx`) renders a complete UI — spend / token KPIs, a daily-spend area chart, a per-model donut + breakdown table, and a per-workflow/task breakdown table — entirely from mock data (`AIWF_DATA.COST_BY_MODEL`, `AIWF_DATA.HOURS24`, `AIWF_DATA.WORKFLOWS`). The overview and `/runs` pages already fetch real data from the worker; `/cost` should do the same.

The overview's `cost24h` (`KpisResponse`), `Run.cost`, `Run.tokens`, and `WorkflowRow.costToday` are all hardcoded `null` (`collect-kpis.ts:69`, `collect-runs.ts:171-172`, `collect-workflows.ts:81`, `derive-kpis.ts:49`) because the Vercel Workflow run store carries no usage. But the workflow already ships OpenInference traces to Arthur (per-ticket task, `apps/worker/src/sandbox/arthur-tracer.ts` + `arthur-client.ts`), and **Arthur aggregates token + cost data first-class** on those traces. So the real source already exists and is queryable — no new capture or persistence is needed.

## Current state

### What the screen needs (exact data shape)

Read from `apps/dashboard/components/cockpit/screens/cost.tsx`:

| UI element | Mock source | Real source after this change |
| --- | --- | --- |
| KPI: spend | `sum(COST_BY_MODEL.cost)` | `totals.totalTokenCost` (USD) |
| KPI: Tokens | `sum(COST_BY_MODEL.tokens)` | `totals.totalTokens` |
| KPI: Cost/run avg | hardcoded `$0.41` | `totals.costPerRun` |
| KPI: Projection EoM | hardcoded `$1,184` | **removed** (no source) |
| Area chart "Daily spend" | `HOURS24.map(h => h.cost*24)` | `daily[].cost` + `daily[].date` (Arthur timeseries) |
| Donut "Model mix" | `COST_BY_MODEL[].share` + center | `byModel[].cost` → shares computed in-screen; center = `totalTokenCost` |
| Table "Per-model breakdown" | `COST_BY_MODEL[]` | `byModel[] { model, cost, tokens }` (span-level aggregation) |
| Table "Per-workflow breakdown" | `WORKFLOWS[]` sorted by `costToday` | `byWorkflow[]` (= per-Arthur-task; see mapping note) |
| Header tabs "By model / workflow / actor" | inert | **removed** |
| "Export CSV" button | inert | **removed** |
| Sparklines (`Spark`, random `sparkSeries`) | mock RNG | **removed** |
| Budget `$1,200`, MoM/WoW deltas | hardcoded | **removed** |

Mock shapes (replaced): `CostByModel { model, vendor, cost, tokens, share }` (`apps/dashboard/lib/types.ts:36`); `HourPoint` (`apps/shared/contracts/domain.ts:129`).

### How real data flows (the template — overview/runs)

1. Worker route `apps/worker/src/routes/api/v1/...` returns a typed `@shared/contracts` response; wraps the collector in try/catch and degrades to an empty payload on failure (see `runs.get.ts`, `workflows.get.ts`). Sends `Cache-Control: private, max-age=15, swr=60`.
2. Response interface declared in `apps/shared/contracts/api.ts`.
3. Dashboard fetches server-side via `getJSON<T>(path)` (`apps/dashboard/lib/api/server.ts`) — bearer `WORKER_API_TOKEN`, `cache: "no-store"`.
4. A `*-data.tsx` server component calls `getJSON`, `.catch()`s to a fallback in `apps/dashboard/lib/api/fallbacks.ts`, passes a `data` prop to the client screen.
5. The page is a thin `<Suspense fallback={<Skeleton/>}><Data/></Suspense>` route.

This is a **single-PR conversion** — no persistence layer, no two-step rollout.

## The real data source — Arthur GenAI Engine

The worker already holds an Arthur client. `ArthurClient.fromTraceEndpoint(env.GENAI_ENGINE_TRACE_ENDPOINT, env.GENAI_ENGINE_API_KEY)` (`arthur-client.ts:37`) builds a client whose `request<T>` helper sends `Authorization: Bearer <GENAI_ENGINE_API_KEY>`. Both env vars are optional (`apps/worker/env.ts:83-84`) → when unset, the route falls back to the empty state. Reads require the `INFERENCE_READ` permission on the key. Arthur is org-scoped (the single deployment sees its own org) — consistent with this project's single-tenant deployment model.

### Token + cost are first-class on Arthur traces

Traces/spans extend `TokenCountCostSchema`:
`{ prompt_token_count, completion_token_count, total_token_count, prompt_token_cost, completion_token_cost, total_token_cost }` (cost in USD floats, `null` if unavailable). Responses also carry `display_currency` (defaults USD).

### Endpoints used

1. **Totals + per-task breakdown (one call):** `POST /api/v1/traces/overview`
   body `{ task_ids, start_time, end_time }` →
   `{ count, overviews: [{ task_id, trace_count, trace_token_count, trace_token_cost, eval_count, continuous_eval_success_rate, last_active }] }`.
   Multi-task in one call gives fleet totals (sum across `overviews`) **and** the per-task breakdown over a window.

2. **Daily-spend chart:** `POST /api/v1/traces/overview/timeseries`
   body `{ task_id, start_time, end_time, bucket_size }` (**single task per call**) →
   points `{ timestamp, trace_count, trace_token_count, trace_token_cost, continuous_eval_success_rate }`.
   For a fleet daily-spend chart, fan out one call per task and **merge points by bucket timestamp**, summing `trace_token_cost`/`trace_token_count`. (`bucket_size` allowed values are unconfirmed — see open questions.)

3. **By-model breakdown (the one manual aggregation):** `GET /api/v1/traces/spans` (and/or `GET /api/v1/traces`) extend `TokenCountCostSchema`, and spans carry `model_name`. The overview endpoint is per-**task**, not per-model, so a by-model table requires fetching span rows for the window and **summing token/cost client-side grouped by `model_name`**. This is the only client-side aggregation; flagged below.

### How usage→cost is computed

No client-side pricing. Arthur returns USD cost directly (`*_token_cost`), already derived from the traces. The worker just sums Arthur's pre-aggregated numbers (for totals/timeseries) or groups span rows by `model_name` (for the by-model table). The pricing table (`apps/worker/src/sandbox/agents/pricing.ts`) and the Slack `usageReport` path are untouched and not on this read path.

### Reconciliation with the overview KPI (out of scope, noted)

The overview's `cost24h` / `WorkflowRow.costToday` / `Run.cost` are hardcoded `null` today. The same Arthur source could backfill those so cost is computed in exactly one place going forward (e.g. `collectKpis`/`collectWorkflows` querying `/traces/overview` for the matching task/window). Out of scope for this PR, but called out so the `null` placeholders aren't reinvented elsewhere.

## Proposed contract (`apps/shared/contracts/api.ts`)

```ts
export interface CostByModelEntry {
  model: string;   // Arthur span model_name
  cost: number;    // USD, summed total_token_cost over the window
  tokens: number;  // summed total_token_count over the window
}

export interface CostByWorkflowEntry {
  /** Arthur task_id (per ticket-run, e.g. "AWT-42" / "AWT-42.1"). */
  taskId: string;
  /** Arthur task name (= the ticket-run identifier). */
  name: string;
  runs: number;       // trace_count for the task
  tokens: number;     // trace_token_count
  cost: number;       // trace_token_cost (USD)
  costPerRun: number; // cost / max(1, runs)
}

export interface CostResponse {
  generatedAt: string;
  /** false when Arthur is unconfigured/unreachable or returns nothing. The
   *  screen renders its empty/N-A state. */
  available: boolean;
  /** Window the figures cover (the request's start_time/end_time). */
  window: { start: string; end: string }; // ISO
  totals: {
    totalTokenCost: number; // USD, Σ overviews[].trace_token_cost
    totalTokens: number;    // Σ overviews[].trace_token_count
    traceCount: number;     // Σ overviews[].trace_count
    costPerRun: number;     // totalTokenCost / max(1, traceCount)
  };
  byModel: CostByModelEntry[];
  /** Per-task (= per ticket-run) breakdown from /traces/overview. */
  byWorkflow: CostByWorkflowEntry[];
  /** Per-day spend, oldest→newest, merged across tasks from the timeseries. */
  daily: { date: string; cost: number; tokens: number }[]; // date = bucket ISO timestamp
}
```

Notes:
- `byWorkflow` is named to match the screen's "Per-workflow breakdown" section, but its entries are **per Arthur task** (per ticket-run), since that's the natural grain of `/traces/overview`. See the mapping open question.
- Stripped from the contract/screen (no real source, per user decision): budget, MoM/WoW deltas, EoM projection, "By actor" tab, decorative sparklines, "Export CSV".

## Fallback / unavailable state

Add `costFallback(now)` to `apps/dashboard/lib/api/fallbacks.ts`:

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

The worker route degrades to the same empty payload (`available:false`) when `GENAI_ENGINE_API_KEY`/`GENAI_ENGINE_TRACE_ENDPOINT` are unset or any Arthur call throws — matching `runs.get.ts`/`workflows.get.ts`. The screen renders `$0.00` / `0` / empty tables — never crashes.

## Behavior

- **Happy path:** `/cost` shows real spend, token totals, per-model and per-task breakdowns, and a per-day spend chart, all from Arthur over the chosen window.
- **Arthur unconfigured / unreachable / 401:** `getJSON` returns (or the worker degrades to) `available:false` → empty/zero state. No crash.

## Out of scope

- Wiring tabs / "Export CSV" (removed).
- Backfilling the overview's `cost24h`/`costToday`/`Run.cost` from Arthur (mentioned above).
- A task→workflow mapping for a true by-workflow rollup (breakdown stays per-task).

## Open questions / assumptions

1. **`bucket_size` values.** `/traces/overview/timeseries` takes a `bucket_size`, but the allowed values (e.g. `"day"` vs a duration vs an enum) are unconfirmed. **Assumption:** a day-granularity bucket exists for the daily chart; confirm the exact value.
2. **Empty `task_ids`.** Does `/traces/overview` with an empty/omitted `task_ids` return org-wide totals, or is `task_ids` required? If required, the worker must first list the org's tasks (the client already lists tasks via `/api/v2/tasks/search`) and pass their ids. **Assumption:** we enumerate tasks and pass ids explicitly.
3. **By-model client aggregation.** Per-model totals require fetching span rows and summing by `model_name` client-side (Arthur has no per-model overview). Acceptable, given span volume per window? Or drop the by-model table for v1?
4. **Task→workflow mapping.** Arthur tasks are per ticket-run (`AWT-42`, `AWT-42.1`). The "by workflow" section therefore shows **per-task** rows unless we add a task→workflow mapping. Stated, not blocking; per-task is the natural breakdown.
5. **Window.** Which window do the KPIs cover — calendar MTD, rolling 30d, or 24h? Drives `start_time`/`end_time`. **Assumption:** calendar month-to-date (matches the original "MTD" framing); confirm.

## Verification

1. Worker + dashboard typecheck pass.
2. `GET /api/v1/cost` returns non-empty `totals`/`byWorkflow` for a window with real Arthur traces.
3. `/cost` renders those figures (spend, tokens, breakdowns, daily chart).
4. With Arthur unconfigured (env unset) or unreachable, `/cost` shows the zero/empty state — no crash.
