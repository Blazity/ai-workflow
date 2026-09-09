# `/evals` Real-Data Conversion — Design

**Date:** 2026-06-08
**Status:** Draft (has open questions — see end)
**Scope:** Convert the `/evals` page from mock data to live data, mirroring the overview/runs server-component fetch pattern. Unlike `/runs`, the worker does **not** yet expose an evals list endpoint and the underlying eval results are **not yet read from anywhere** — so this design also covers the prerequisite of producing/reading eval results, with the data-source decision flagged explicitly.

## Problem

The `/evals` dashboard page (`apps/dashboard/app/(cockpit)/evals/page.tsx`) is a 4-line stub that renders `EvalsScreen` with no data fetch. `EvalsScreen` (`apps/dashboard/components/cockpit/screens/evals.tsx`) is a `"use client"` component that reads the hardcoded `AIWF_DATA.EVALS` mock slice and draws synthetic sparklines via `jitterSeries`. Nothing on this page is real.

We want `/evals` to fetch real data from the worker through the same three-layer pattern the overview and runs pages use:
1. thin server route (`page.tsx`) → `<Suspense>` + server data component;
2. `evals-data.tsx` server component calling `getJSON<T>` with a `.catch()` fallback;
3. client presenter `EvalsScreen` receiving a typed `data` prop.

## Current state

### Mock (what the screen renders today)

`apps/dashboard/lib/data/mock.ts` exports `EVALS: EvalMetric[]` (the "Arthur evals" slice, lines ~82–93). The shape is `EvalMetric` from `apps/dashboard/lib/types.ts`:

```ts
export interface EvalMetric {
  metric: string;                          // "Hallucination", "PII Detection", …
  value: number;                           // numeric reading
  target: string;                          // human string, e.g. "< 0.05", "= 0", "flags"
  status: "pass" | "warn" | "fail";
  trend: number;                           // signed delta vs prior window
  axis: "safety" | "quality" | "ops";      // grouping bucket
  family: string;                          // "output" | "agent" | "input" | "rag" | "runtime"
  unit?: string;                           // optional, e.g. "flags/24h"
}
```

`EvalsScreen` renders, per `axis` group ("safety", "quality", "ops"):
- a `CkCard` with eyebrow=axis, title from a fixed map, a left-border accent color, and an action label `{list.length} evaluators`;
- one cell per metric containing: `metric` name, a `pass`/`warn`/`fail` `CkChip`, the formatted `value` (`<1` → `toFixed(3)`, else as-is), optional `unit`, a `trend` indicator (`↗`/`↘`/`→` + `Math.abs(trend).toFixed(3)`; **negative trend renders green, positive red** — i.e. "down is good" by current convention), a `Spark` sparkline, and `target {e.target}`.

Header chrome is decorative/hardcoded: the eyebrow "Arthur engine · continuous evaluation", the title "Evaluations & guardrails", a `CkChip` "Live · 12,408 spans · 24h", and a `+ New eval` button.

**The sparkline is fake:** `Spark data={jitterSeries(...)}`. There is no per-metric time series in the mock or anywhere else.

### Existing eval scaffold

`apps/shared/contracts/api.ts` already declares a discriminated union:

```ts
export type EvalHealthResponse =
  | { available: true; score: number; pass: number; warn: number; fail: number;
      spansGraded: number; windowHours: number }
  | { available: false; reason: string };
```

The worker route `apps/worker/src/routes/api/v1/overview/eval-health.get.ts` is a hardcoded stub returning `{ available: false, reason: "Eval grading not wired up yet." }`. The overview page already consumes it: `overview-data.tsx` fetches `/api/v1/overview/eval-health` (falls back to `evalHealthFallback()` → `{ available: false, reason: "Worker unavailable." }`), and `EvalHealthKPI` in `overview.tsx` renders a donut of pass/warn/fail + score + `spansGraded`/`windowHours` when `available`, else the `reason` string. This is a **summary** KPI tile, not the per-metric breakdown the `/evals` page needs.

### Where eval results actually originate (the real data source — CONFIRMED)

Arthur is integrated **write-only** today:
- `apps/worker/src/sandbox/arthur-client.ts` — a client for the Arthur GenAI Engine **tasks/prompts** API (`/api/v2/tasks*`, `/api/v1/tasks/{id}/prompts*`). It creates one task per ticket run and hosts/tags prompt versions. It has **no** read method yet.
- `apps/worker/src/sandbox/arthur-tracer.ts` — a bundled Python OpenInference tracer that **ships traces/spans into** Arthur Engine from inside each sandbox via `POST /api/v1/traces`. Data flows out of the worker; nothing reads it back.
- Wiring lives in `apps/worker/src/workflows/agent.ts` (`ensureArthurTaskForTicket`, gated on `env.GENAI_ENGINE_API_KEY` + `env.GENAI_ENGINE_TRACE_ENDPOINT`).

**The Arthur GenAI Engine DOES expose a read API** (ground-truthed from `arthur-ai/arthur-engine` + `arthur-common` on `main`). Auth is the **same** `Authorization: Bearer GENAI_ENGINE_API_KEY` used for writes; reads require the `INFERENCE_READ` permission. All reads are **org-scoped** — a deployment's key sees its whole org, which matches our single-tenant-per-deployment model. The relevant endpoints:

- **Fleet aggregate (primary source for this page) — one call, multi-task:**
  `POST /api/v1/traces/overview` body `TraceOverviewRequest { task_ids, start_time, end_time }` → `TraceOverviewListResponse { count, overviews: TraceOverviewResponse[] }`. Each `TraceOverviewResponse` = `{ task_id, trace_count, trace_token_count, trace_token_cost, eval_count, continuous_eval_success_rate, last_active }`. This yields fleet-wide eval health (success rate + trace/eval counts) over a 24h window with no per-task fan-out at the result-shaping layer.
- **Per-metric breakdown (optional):** `GET /api/v1/traces/spans` (list, metadata only) → `GET /api/v1/traces/spans/{span_id}` → `SpanWithMetricsResponse.metric_results: MetricResultResponse[]` where each = `{ id, metric_type, details, prompt_tokens, completion_tokens, latency_ms, span_id, metric_id, created_at }`. `metric_type` is an enum of **only** `QueryRelevance | ResponseRelevance | ToolSelection`. `details` is an opaque JSON string (e.g. relevance → `{ bert_f_score, reranker_relevance_score, llm_relevance_score, reason }`). **There is no flat numeric score or pass/fail on a metric result** — we parse `details` and apply our own threshold.
- **Trend/timeseries (optional):** `POST /api/v1/traces/overview/timeseries` body `{ task_id, start_time, end_time, bucket_size }` (**single task per call**) → points `{ timestamp, trace_count, trace_token_count, trace_token_cost, continuous_eval_success_rate }`.

#### CRITICAL CAVEAT — what our trace path actually yields

The rich rule-based evals the mock screen implies — **hallucination, PII, toxicity, prompt-injection** Pass/Fail — live in Arthur's **legacy inference/rule model**, populated **only** by the `/validate_prompt` + `/validate_response` write path. **We never call that path; we only ship OpenInference traces (`POST /api/v1/traces`).** Therefore `GET /api/v2/inferences/query` and those rule families are **empty for us**.

What our trace path actually produces:
- `continuous_eval_success_rate`, `eval_count` (spans graded), `trace_count` — from `/traces/overview`;
- the three relevance/tool metric types — and **only if continuous evals are configured on the task**; otherwise `eval_count = 0`.

So the realistic `/evals` page = an overall **eval-health score** (`continuous_eval_success_rate × 100`), the **graded count + window**, and a **relevance / tool-selection breakdown**. The hallucination/toxicity/PII/prompt-injection families the mock shows are **dropped** from this page. Adopting Arthur's `validate_*` API to populate them is a **separate future prerequisite, explicitly out of scope** here.

**Conclusion:** evals are now reachable via a confirmed read API, so this is no longer blocked. Conversion's prerequisite is to add a worker-side read path (`getTracesOverview()` on `ArthurClient` + a `collect-evals.ts` collector). When Arthur is unconfigured, or when `eval_count = 0` (no continuous evals configured / no graded spans in window), the page degrades to the documented unavailable state — exactly like `eval-health` does today.

## Proposed data contract

Add to `apps/shared/contracts/api.ts`. The shape now maps directly to `TraceOverviewResponse` (the fleet aggregate) plus the relevance/tool-selection breakdown. We reuse the **same discriminated-union shape** as `EvalHealthResponse` so the page handles "not wired up" / "nothing graded" identically to overview. Fields with no real source on our trace-only path are **dropped** (no synthetic sparklines, no rule families).

```ts
/** One evaluator's aggregate reading over the window. Limited to the metric
 *  types Arthur computes from our OpenInference trace path:
 *  ResponseRelevance / QueryRelevance / ToolSelection. */
export interface EvalMetricRow {
  metric: string;                          // display name, e.g. "Response Relevance"
  metricType:                              // Arthur metric_type enum
    | "QueryRelevance"
    | "ResponseRelevance"
    | "ToolSelection";
  value: number;                           // aggregate score parsed from metric_results.details
  status: "pass" | "warn" | "fail";        // computed against our own threshold
  axis: "quality";                         // all three are quality-axis on our path
  // Only present when /traces/overview/timeseries is wired (see Open Q1).
  trend?: number | null;                   // signed delta vs window start; omitted if not wired
  spark?: number[];                        // success-rate buckets; omitted if not wired
}

export type EvalsResponse =
  | {
      available: true;
      generatedAt: string;
      windowHours: number;
      /** continuous_eval_success_rate × 100, fleet-wide. */
      score: number;
      /** Σ eval_count across tasks — "spans graded" in the window. */
      spansGraded: number;
      /** Σ trace_count across tasks. */
      traceCount: number;
      /** Per-metric-type breakdown; empty if no continuous evals configured. */
      rows: EvalMetricRow[];
    }
  | { available: false; generatedAt: string; reason: string };
```

Notes:
- `score`/`spansGraded`/`traceCount`/`windowHours` come straight from summing `TraceOverviewResponse` fields across the returned overviews.
- `EvalMetricRow.value`/`status` require the **optional** per-span breakdown (Open Q below). If we ship the aggregate-only first cut, `rows` is `[]` and the page renders the score + graded count without the per-metric grid. This keeps the first increment small.
- `target`/`family`/`unit` from the old draft are **removed** — they were presentation metadata for rule families we cannot populate. `axis` collapses to the single `"quality"` literal because only relevance/tool metrics exist on our path.
- `trend`/`spark` are present **only** if `/traces/overview/timeseries` is wired (Open Q1); otherwise omitted entirely (no static placeholders).

**Assumption:** the `/evals` page consumes only this trace-derived data; the existing `EvalHealthResponse` summary tile on overview is left untouched. We do **not** consolidate the two endpoints in this change (though `EvalsResponse.score`/`spansGraded` could later feed it).

## Real data source & how it's obtained (worker side)

New worker route `GET /api/v1/evals` → `EvalsResponse`, structured like `runs.get.ts`:
- sets `Cache-Control: private, max-age=15, stale-while-revalidate=60`;
- if `env.GENAI_ENGINE_API_KEY` / `env.GENAI_ENGINE_TRACE_ENDPOINT` are unset, returns `{ available: false, reason: "Arthur GenAI Engine not configured." }` (no throw);
- otherwise builds an `ArthurClient` (via the existing `ArthurClient.fromTraceEndpoint`) and calls a new read method `getTracesOverview({ taskIds, startTime, endTime })` → `POST /api/v1/traces/overview`. The new `apps/worker/src/lib/overview/collect-evals.ts` collector sums the returned `overviews` into `score`/`spansGraded`/`traceCount`, and (optionally) shapes `rows` from the per-span metric breakdown. Returns `available: true`;
- if `eval_count` sums to `0` (no continuous evals configured on our tasks, or nothing graded in window), return `{ available: false, reason: "No graded evals in the last 24h." }` — there is genuinely nothing to show;
- on any error, logs `evals_list_failed` and returns `{ available: false, reason: "Eval grading not wired up yet." }` — same degrade behavior as the other routes.

**Task-id enumeration:** `/traces/overview` takes `task_ids`. It is **unconfirmed** whether an empty/omitted `task_ids` means "all org tasks" (Open Q2). If it does, we pass none. If it does not, we first enumerate the org's tasks via the existing `/api/v2/tasks/search` path (the `ArthurClient` already does substring search there) and pass their ids. The collector boundary (`collect-evals.ts` taking an injected fetcher) keeps this isolated and testable, matching `collect-runs.ts`/`collect-kpis.ts`.

## Dashboard changes

### 1. `app/(cockpit)/evals/page.tsx` (rewrite)
Thin server route, drops the direct screen import:
```tsx
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

### 2. `app/evals-data.tsx` (new server component)
Mirrors `runs-data.tsx`:
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

### 3. `lib/api/fallbacks.ts` (add)
```ts
export function evalsFallback(now: string): EvalsResponse {
  return { available: false, generatedAt: now, reason: "Worker unavailable." };
}
```

### 4. `components/cockpit/screens/evals.tsx` (modify)
- Signature `EvalsScreen()` → `EvalsScreen({ data }: { data: EvalsResponse })`.
- Remove `import { AIWF_DATA } from "@/lib/data/mock"`, `const D = AIWF_DATA`, and `import { jitterSeries } from "@/lib/rng"` (synthetic sparklines are dropped — no static placeholders).
- Import `EvalsResponse`/`EvalMetricRow` from `@shared/contracts` (drop the mock `EvalMetric` reliance).
- When `data.available === false`, render the existing header chrome but replace the metric cards with a single empty/unavailable panel showing `data.reason` (mirroring `EvalHealthKPI`'s reason path). This is also the state when nothing is graded.
- When `available`:
  - Drive the "Live · N spans · 24h" chip from `data.spansGraded` / `data.windowHours` instead of the hardcoded "12,408 spans · 24h"; optionally show `data.score`.
  - The mock's three axis groups (safety/quality/ops) collapse to a single **Quality** group, since only relevance/tool metrics exist on our path. Render `data.rows` (all `axis: "quality"`) in one card.
  - Each row shows `metric`, the formatted `value`, and the pass/warn/fail `CkChip`.
  - Sparkline / trend: render `e.spark` / `e.trend` **only when present** (timeseries wired); otherwise render neither. Drop the `Spark`/`jitterSeries` usage when not wired.
  - If `rows` is empty (aggregate-only first cut), render just the score + graded-count header — no per-metric grid.

### 5. `app/evals-skeleton.tsx` (new)
Loading fallback styled like `overview-skeleton.tsx` — header placeholder + one card-shaped block (the Quality group).

## Behavior

- **Happy path (Arthur configured, continuous evals graded):** `/evals` renders the fleet eval-health score + spans-graded count over the real 24h window, and (if the per-span breakdown is wired) a Quality card of relevance/tool-selection metrics. Trend/sparkline appear only when the timeseries call is wired.
- **Arthur not configured:** worker returns `available: false`, reason "Arthur GenAI Engine not configured." Page shows header chrome + reason panel. No crash.
- **Nothing graded (`eval_count = 0`):** worker returns `available: false`, reason "No graded evals in the last 24h." Same panel.
- **Worker down / 401:** `getJSON` throws → `evalsFallback` → `available: false`, reason "Worker unavailable." Same silent-degrade as overview/runs.

## Out of scope

- Wiring up the `+ New eval` button.
- The `EvalHealthResponse` overview tile (left as-is; could later be derived from `EvalsResponse` but not in this change).
- **Adopting Arthur's `/validate_prompt` + `/validate_response` write path** to populate the legacy rule families (hallucination, PII, toxicity, prompt-injection). This is the prerequisite for those metrics and is a **separate future effort** — those families are simply absent from this page.
- Per-span drill-down / individual inference detail views.
- Synthetic sparklines — removed entirely (no static placeholders).

## Open questions / assumptions (need user decision)

The Arthur read API is now **confirmed** (see "Where eval results actually originate"). Remaining genuinely-open items:

1. **`/traces/overview/timeseries` `bucket_size` values.** The allowed `bucket_size` values are unconfirmed. Needed only if we wire trend/sparkline; the aggregate-only first cut does not require it. **Assumption:** trend/sparkline are deferred to a second increment.
2. **Empty `task_ids` semantics.** Does `POST /api/v1/traces/overview` treat an empty/omitted `task_ids` as "all org tasks"? If yes, one call with no ids suffices. If no, the collector must first enumerate tasks via `/api/v2/tasks/search`. **Assumption:** unconfirmed → plan covers both paths; default to enumerating tasks if empty-means-all is not verified.
3. **Are continuous evals actually configured on our tasks in the live instance?** If continuous evals are not enabled on the per-ticket tasks, `eval_count = 0` and the page legitimately shows the "No graded evals" state. Confirming this is what determines whether the happy path ever fires today.

Resolved (no longer open): read-API existence/shape, auth, org-scope/single-tenant aggregation, and the metric-family set (only relevance/tool on our path; rule families dropped).

## Verification

1. Shared + worker + dashboard typecheck pass (`npx tsc --noEmit`) with `EvalsResponse` imported in the route, `evals-data.tsx`, and `evals.tsx`.
2. With the worker unreachable (or Arthur unconfigured), `/evals` renders header chrome + the reason panel, no crash.
3. With Arthur configured and continuous evals graded, `/evals` renders the real fleet score + spans-graded count over the 24h window (and the Quality breakdown if wired).
4. With Arthur configured but `eval_count = 0`, `/evals` shows the "No graded evals in the last 24h." panel.
