# Dashboard ← Worker: Overview screen wiring — Design

**Date:** 2026-05-28
**Status:** Draft for review
**Scope:** Replace `AIWF_DATA` mock-driven data in `apps/dashboard/components/cockpit/screens/overview.tsx` with HTTP calls to the worker's REST API. Set up the shared contract surface so the rest of the dashboard can follow the same pattern in later rounds.

---

## 1. Background

- The Overview screen renders six panels (hero KPI strip, Eval health donut, Now-running, Input-needed, Recent-runs table, Workflows table). Today every value comes from `apps/dashboard/lib/data/mock.ts`.
- A REST contract is already drafted in `apps/dashboard/docs/overview-api-requirements.md` (Option B, per-panel endpoints under `/api/v1`). This design adopts it with two modifications (see §4).
- The worker today only persists **in-flight** state in Upstash (`ticketKey → runId`, sandbox ids, failed-ticket markers). There is no historical store for cost, p95, eval scores, recent-runs history, or hourly sparklines.
- The dashboard already has empty placeholder folders at `apps/dashboard/app/api/{activity,cost,evals,prompts,runs,workflows}`. They will be removed — this design routes calls directly to the worker, not through dashboard route handlers.

## 2. Goals & non-goals

**Goals**
1. Dashboard Overview screen reads from the worker; mock data on Overview is removed.
2. Only the worker holds backend env vars (Jira, GitHub, Anthropic, Upstash, etc.).
3. Shared contract types (`Run`, `Workflow`, response envelopes) live in `apps/shared/` and are imported from both apps via TypeScript path aliases.
4. Panels with no real data source today render as **disabled / "N/A"** rather than displaying fake numbers.
5. Live panels (Now-running, Input-needed) show real ticket → run mappings from the Upstash registry.

**Non-goals**
- Building a runs-history persistence layer. KPIs, recent runs, eval health, and workflow trends all return `null` until that's a separate workstream.
- Migrating other screens (Runs, Trace, Evals, Cost, Prompts, Pre-sandbox, Post-PR). They continue to use `AIWF_DATA` until they're individually scheduled.
- Adding auth between dashboard and worker beyond CORS. Documented as a deferred risk in §10.
- Adding observability/tracing for the new endpoints.

## 3. Architecture

```
[Browser: Next.js Overview (client component)]
        │  fetch() — TanStack Query, refetch on interval
        │  cross-origin to worker
        ▼
[Worker: Nitro on Vercel]
        │  /api/v1/* routes
        │  CORS plugin → Allow-Origin: DASHBOARD_ORIGIN
        ▼
[Upstash run registry]  +  [adapters.issueTracker]
   (live runs + sandboxes)    (ticket titles)
```

- Dashboard fetches the worker URL directly. CORS is set per-request by a Nitro plugin scoped to `/api/v1/*`.
- Worker is the single source of secrets. Dashboard ships one public env var: `NEXT_PUBLIC_WORKER_BASE_URL`.
- The shared package is a folder, not an installed package. Both `tsconfig.json` files use a `@shared/*` path alias to `../shared/*`.

## 4. Contract: endpoint surface

The base path `/api/v1` and per-panel split follow `apps/dashboard/docs/overview-api-requirements.md §4` (Option B). Two adjustments:

1. **Null at the field level** instead of stubs that look like real data. The UI checks for `null` and renders a disabled / "N/A" state. Panels whose entire payload is unavailable use `{ available: false, reason: string }`.
2. **No bearer auth in this round.** The worker is reachable cross-origin, but only the dashboard origin is allowlisted in CORS. (This still means the data is technically public to anyone who can `curl` the worker — see §10.)

### 4.1 Endpoints

| Method | Path | Backs panel | Real today | `null` today |
|---|---|---|---|---|
| GET | `/api/v1/overview/kpis` | Hero KPI strip | — | all four KPI fields return `null` |
| GET | `/api/v1/overview/eval-health` | Eval health donut | — | `{ available: false, reason }` |
| GET | `/api/v1/runs/live?status=running,awaiting` | Now-running + Input-needed | ticket, runId, sandboxId, ticketTitle, askedAtMin (derived from Upstash + issue tracker) | progress, etaSec, currentSpan, cost, eval, tokens |
| GET | `/api/v1/runs?limit&offset` | Recent runs table | — | `{ rows: [], total: 0, counts: zeroed, available: false }` |
| GET | `/api/v1/workflows?limit&offset` | Workflows table | `id`, `name`, `blurb` from a static `WORKFLOW_REGISTRY` const that reflects the worker's actual workflows | `runs24h`, `p50`, `p95`, `errRate`, `costToday`, `trend24h`, `latestRun` |

Pagination uses `limit` + `offset` (capped at 100) and returns `total`. Headers:
- `/api/v1/runs/live`: `Cache-Control: no-store`
- everything else: `Cache-Control: private, max-age=15, stale-while-revalidate=60`

Errors follow the envelope in the contract doc (`{ error: { code, message, details? } }`) with the standard status-code mapping (400 / 401 / 429 / 500).

### 4.2 Response shapes

Defined in `apps/shared/contracts/api.ts` (see §5). Excerpts:

```ts
export interface KpisResponse {
  generatedAt: string;
  runs24h:   { value: number; deltaPct: number; spark: number[] } | null;
  p95:       { valueSec: number; deltaSec: number; spark: number[] } | null;
  errors24h: { value: number; deltaPct: number; spark: number[] } | null;
  cost24h:   { value: number; deltaPct: number } | null;
}

export type EvalHealthResponse =
  | { available: true; score: number; pass: number; warn: number; fail: number; spansGraded: number; windowHours: number }
  | { available: false; reason: string };

export interface LiveRunsResponse {
  generatedAt: string;
  rows: Run[]; // running + awaiting only
}

export interface RunsResponse {
  generatedAt: string;
  available: boolean;
  rows: Run[];
  total: number;
  counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
}

export interface WorkflowsResponse {
  generatedAt: string;
  rows: Array<Workflow & {
    latestRun: Pick<Run, "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl"> | null;
    trend24h: number[] | null;
  }>;
  total: number;
}
```

`Run` and `Workflow` remain field-compatible with the current `apps/dashboard/lib/types.ts`. Numeric metric fields on `Workflow` (`runs24h`, `p50`, `p95`, `errRate`, `costToday`) become `number | null` so they can be explicitly absent.

## 5. Folder layout

```
apps/
  shared/                          # NEW — TypeScript path-alias target. No package.json.
    contracts/
      domain.ts                    # Run, Workflow, HourPoint, RunStatus, SpanKind (moved from dashboard/lib/types.ts)
      api.ts                       # KpisResponse, EvalHealthResponse, LiveRunsResponse, RunsResponse, WorkflowsResponse
      index.ts                     # barrel export
    tsconfig.json                  # base config

  dashboard/
    tsconfig.json                  # paths += { "@shared/*": ["../shared/*"] }
    next.config.ts                 # transpilePackages: ["@shared/contracts"] is NOT needed for path aliases;
                                   #   verified that Next 15 resolves alias paths outside the app dir
    lib/
      types.ts                     # → re-export everything from @shared/contracts/domain
      api/
        client.ts                  # shared get<T>(path) fetcher + BASE constant
        overview.ts                # queryOptions factories: kpis, evalHealth, liveRuns, recentRuns, workflows
    app/
      providers.tsx                # NEW client component: <QueryClientProvider>
      layout.tsx                   # wraps {children} in <Providers>
      page.tsx                     # unchanged structure; Overview uses queries
      api/                         # DELETED — empty placeholder folders
    components/cockpit/screens/overview.tsx  # rewired (see §6)

  worker/
    tsconfig.json                  # paths += { "@shared/*": ["../shared/*"] }
    env.ts                         # adds DASHBOARD_ORIGIN: z.string().url()
    src/
      plugins/cors.ts              # NEW — sets CORS headers + handles OPTIONS for /api/v1/*
      routes/api/v1/
        overview/kpis.get.ts
        overview/eval-health.get.ts
        runs/live.get.ts
        runs/index.get.ts
        workflows/index.get.ts
      lib/overview/                # NEW — pure collectors (testable without HTTP)
        workflow-registry.ts       # static const + types for the real workflows
        collect-live-runs.ts       # reads Upstash listAll() + issue-tracker for titles
        collect-workflows.ts       # returns registry rows with null metrics
```

## 6. Dashboard data fetching (TanStack Query)

`apps/dashboard/package.json`:
- remove `"swr"`
- add `"@tanstack/react-query"` (and `@tanstack/react-query-devtools` only in dev)

`apps/dashboard/app/providers.tsx` (new client component):

```tsx
"use client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

`apps/dashboard/lib/api/overview.ts`:

```ts
import { queryOptions } from "@tanstack/react-query";
import type {
  KpisResponse,
  EvalHealthResponse,
  LiveRunsResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";
import { get } from "./client";

export const overviewQueries = {
  kpis: () =>
    queryOptions({
      queryKey: ["overview", "kpis"],
      queryFn: () => get<KpisResponse>("/api/v1/overview/kpis"),
      refetchInterval: 30_000,
    }),
  evalHealth: () =>
    queryOptions({
      queryKey: ["overview", "evalHealth"],
      queryFn: () => get<EvalHealthResponse>("/api/v1/overview/eval-health"),
      refetchInterval: 60_000,
    }),
  liveRuns: () =>
    queryOptions({
      queryKey: ["runs", "live"],
      queryFn: () =>
        get<LiveRunsResponse>("/api/v1/runs/live?status=running,awaiting"),
      refetchInterval: 3_000,
    }),
  recentRuns: (page: number, pageSize = 7) =>
    queryOptions({
      queryKey: ["runs", { page, pageSize }],
      queryFn: () =>
        get<RunsResponse>(
          `/api/v1/runs?limit=${pageSize}&offset=${page * pageSize}`,
        ),
      refetchInterval: 15_000,
      placeholderData: (prev) => prev,
    }),
  workflows: (page: number, pageSize = 5) =>
    queryOptions({
      queryKey: ["workflows", { page, pageSize }],
      queryFn: () =>
        get<WorkflowsResponse>(
          `/api/v1/workflows?limit=${pageSize}&offset=${page * pageSize}`,
        ),
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    }),
};
```

Refetch intervals match the "refresh hint" column in `overview-api-requirements.md §1`.

### 6.1 UI changes — disabled/N/A handling

Components in `apps/dashboard/components/cockpit/screens/overview.tsx` (and the few shared UI components they pull from) get small additions:

- **`CkKPI`** gains a `disabled?: boolean` prop. When true: value is replaced with `"N/A"`, delta and sparkline are hidden, the card background/foreground render muted.
- **`EvalHealthKPI`** is converted to accept `data: EvalHealthResponse`. When `available: false`, it renders an outlined (no fill) donut and the `reason` string in the caption row.
- **`NowRunningPanel` / `AwaitingInputPanel`** lose their `D.LIVE_RUNS.filter(...)` calls and accept `rows: Run[]` props. When the array is empty, they render an empty state ("No runs in flight" / "No clarifications pending") instead of hiding the card.
- **Recent runs table** renders an empty body with the message "Run history coming soon" when `RunsResponse.available === false`. Pagination chrome is hidden.
- **Workflows table** renders workflow rows but shows `"—"` in every metric column for which `workflow.runs24h == null`. The sparkline area renders a flat baseline.
- The editorial hero (`t.showEditorialHero`) is unchanged — it still uses the four headline numbers, which become "N/A" when KPI data is null.

The cockpit topbar `persona` / `range` / `env` selectors continue to function but, for Overview, are cosmetic in this round (they do not change query params yet).

## 7. Worker — endpoint implementation

### 7.1 CORS plugin

`apps/worker/src/plugins/cors.ts` (Nitro plugin):

- Triggers on `event.path.startsWith("/api/v1/")`.
- Sets `Access-Control-Allow-Origin: ${env.DASHBOARD_ORIGIN}`, `Vary: Origin`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: content-type`, `Access-Control-Max-Age: 600`.
- Short-circuits `OPTIONS` requests with a 204 response.
- Strict equality on origin — no wildcard, no `*.example.com` matching.

### 7.2 Routes

Each route is a thin Nitro handler that calls a `collect-*` function from `src/lib/overview/`. Handlers set the response `Cache-Control` header per §4.1.

- `routes/api/v1/runs/live.get.ts` — calls `collectLiveRuns({ registry, issueTracker })`. Returns running + awaiting rows. `status` query param filters between them.
- `routes/api/v1/workflows/index.get.ts` — calls `collectWorkflows({ page, pageSize })`. Returns the static registry with null metrics + `latestRun: null`.
- The three "no data" endpoints (`kpis`, `eval-health`, `runs/index`) are small handlers that return the documented `null` / `available: false` shape directly. No collector module needed.

### 7.3 `collect-live-runs.ts`

```ts
// Reads Upstash registry, joins ticket titles from the issue tracker.
// Returns a Run[] with the fields we can actually fill from in-flight state.
// All historical/aggregate fields default to 0 or null and the UI ignores them.
```

The mapping:

| `Run` field | Source | Notes |
|---|---|---|
| `id` | `runId` from registry | the registry's stored value |
| `ticket` | `ticketKey` from registry | uppercase, project-prefixed |
| `ticketTitle` | `issueTracker.getTicket(ticketKey).summary` | falls back to `ticketKey` on lookup failure |
| `ticketUrl` | `issueTracker.getTicket(ticketKey).url` | falls back to `null` |
| `status` | derived: `"awaiting"` if a clarification record exists, otherwise `"running"` | clarification detection: TBD adapter call; if not detectable yet, default to `"running"` |
| `actor` | `"ai-bot"` (constant) | the worker doesn't track per-run actors |
| `workflow` / `workflowName` | inferred from the active workflow's static registry entry | single-tenant for now; if multiple workflows are in flight, this needs richer registry data — flagged as a follow-up |
| `model` | `env.CLAUDE_MODEL` (or codex equivalent) | reads from env, not per-run |
| `cost`, `tokens`, `spans`, `evalScore`, `guardrailHits`, `duration`, `startedAtMin` | `0` / `null` | not tracked per-run yet |
| live-only fields (`currentSpan`, `progress`, `etaSec`, …) | omitted (undefined) | UI gracefully handles undefined |

**Open question for implementation:** the awaiting/running distinction needs a clarification-detection signal from the messaging or issue-tracker adapter. If we can't tell them apart in the first round, every live row becomes `running` and the Input-needed panel renders empty.

### 7.4 `workflow-registry.ts`

Static `WORKFLOW_REGISTRY: Workflow[]` defined in the worker. Reflects the worker's actual workflows:

- `wf_post_pr_gate` — "Post-PR gate", blurb from `post-pr-gate-spec.md`
- `wf_pre_sandbox` — "Pre-sandbox", blurb from `pre-sandbox-plan.md`
- `wf_agent` — "Agent", blurb describing the main ticket-to-PR flow

All metric fields (`runs24h`, `p50`, `p95`, `errRate`, `costToday`) are `null`. `primary` is set on `wf_agent`.

## 8. Environment variables

### Worker (`apps/worker/env.ts`)

Adds one field to the existing schema:
```ts
DASHBOARD_ORIGIN: z.string().url()
```
No default; required at startup. Setting it is part of the deployment runbook for this change.

### Dashboard

Adds one public env var:
```
NEXT_PUBLIC_WORKER_BASE_URL=https://worker.example.com
```
Public on purpose — the value is the worker's URL, not a secret. The dashboard ships no other backend env (no Jira, no GitHub, no Anthropic credentials).

`apps/dashboard/lib/api/client.ts`:
```ts
const BASE = process.env.NEXT_PUBLIC_WORKER_BASE_URL ?? "";

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "omit" });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
```

## 9. Verification plan

1. **Unit:** `apps/worker/src/lib/overview/collect-live-runs.test.ts` — given a fake registry adapter with two entries and an issue-tracker stub, asserts the output `Run[]` has correct `id`/`ticket`/`ticketTitle` and the documented defaults for unfilled fields.
2. **Type-level:** `apps/shared/contracts/index.ts` compiles cleanly under both apps' `tsconfig`. Add a `pnpm -w typecheck` step that exercises both apps.
3. **Worker dev:**
   ```
   pnpm --filter worker dev
   curl http://localhost:3000/api/v1/runs/live | jq
   curl http://localhost:3000/api/v1/overview/kpis | jq
   curl http://localhost:3000/api/v1/workflows | jq
   ```
   Each returns shape-conforming JSON.
4. **Dashboard dev:**
   ```
   NEXT_PUBLIC_WORKER_BASE_URL=http://localhost:3000 pnpm --filter dashboard dev
   ```
   Load `/`. Confirm:
   - KPI cards render "N/A" in muted state
   - Eval donut renders empty outline with the "no data" caption
   - If there's an AI-column ticket in the issue tracker, it appears in "Now running"
   - Recent runs table shows the empty state
   - Workflows table shows three rows (`wf_post_pr_gate`, `wf_pre_sandbox`, `wf_agent`) with "—" in every metric column
5. **CORS smoke:** `curl -v -H "Origin: http://localhost:3001" http://localhost:3000/api/v1/runs/live` — confirm `Access-Control-Allow-Origin` matches the dashboard origin.
6. **Worker-down fallback:** stop the worker. Confirm the dashboard renders the same N/A state plus TanStack Query's error state (logged in the React Query devtools, not a crash).

## 10. Risks & deferred work

- **No auth between dashboard and worker.** Anyone who knows the worker URL can hit the endpoints directly. Acceptable for this round because: (a) the only data exposed today is workflow names + in-flight ticket keys; (b) the worker's webhooks already accept un-fronted traffic and rely on signature verification, so the attack surface is unchanged. Hardening to a bearer token or signed cookie is a follow-up if real data lands in these endpoints later.
- **No runs-history persistence.** Most panels show "N/A" until a follow-up adds it. The contract is structured so adding real data later is a server-side change only — the dashboard contract doesn't move.
- **Running vs awaiting distinction** depends on a worker signal we haven't pinned down. If the first implementation can't separate them, the Input-needed panel will always be empty. Captured as an explicit implementation TODO in §7.3.
- **Multiple in-flight workflows per ticket** would need richer registry data than `ticketKey → runId`. Single-workflow today; flagged for the same follow-up that adds run history.
- **Path-alias resolution under Vercel monorepo builds.** Next 15 and Nitro both follow `tsconfig` `paths`, but the build needs both apps to see `apps/shared/` on disk. With pnpm workspaces this happens automatically. If Vercel's auto-monorepo build root-detection drops the shared folder, the workaround is to set the project's `rootDirectory` to the repo root for both apps. To be confirmed during the first Vercel preview build.

## 11. Out of scope (not changing)

- All non-Overview screens (Runs, Trace, Prompts, Evals, Cost, Pre-sandbox, Post-PR) keep using `AIWF_DATA`.
- `apps/dashboard/lib/data/mock.ts` stays. It's not imported by the new Overview path.
- The dashboard's existing `@octokit/*` deps stay (used by other screens / future routes).
- The worker's existing routes (cron, webhooks, health) are unchanged.
- No new observability instrumentation on the new endpoints.

---

**Acceptance**: this design is ready to hand off to writing-plans when:
1. The contract types compile under both apps from `apps/shared/contracts`.
2. Overview renders against a running worker with the documented null/N/A behavior.
3. `pnpm -w typecheck` and `pnpm --filter worker test` pass.
