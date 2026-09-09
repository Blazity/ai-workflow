# Overview → Server-Component Fetch (drop React Query) — Design

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Supersedes (partial):** the TanStack Query wiring from `docs/superpowers/plans/2026-05-28-dashboard-worker-overview.md` (Tasks 14–16, 18). The worker REST surface and `@shared/contracts` from that plan stay.

## Goal

Replace the dashboard Overview screen's client-side React Query polling with a **Server Component data fetch** that streams into the cockpit via `<Suspense>`. Remove `@tanstack/react-query` entirely. Because the fetch is server-side, the browser never calls the worker directly, so the worker's CORS layer is removed too.

## Decisions (and why)

1. **RSC + Suspense on stable Next, NOT PPR.** `next@15.5.18` is a stable build; setting `experimental.ppr` throws `CanaryOnlyError` (`node_modules/next/dist/server/config.js:305-315`, gated by `isStableBuild()`). PPR would require pinning this **per-client production deployment** to `next@canary` (unstable channel). The wrap + Server-Component-fetch + Suspense-streaming architecture delivers the same intent (server fetch, no React Query, streaming) on stable. The only thing PPR adds is a build-time prerendered static shell — marginal here, since the "shell" is a client SPA that already prerenders to defaults. PPR remains a 1-line `experimental_ppr` opt-in later if/when it ships stable.
2. **Overview view stays a client component.** The cockpit is a single client-side SPA: `app/page.tsx` is `"use client"` and swaps screens via `useState` (`{screen === "overview" && <OverviewScreen/>}`), not routes. A Server Component cannot be conditionally rendered by client state inside a `"use client"` tree, and `OverviewScreen` needs client features (`useCockpit()` context, the `onOpenRun` click handler, pagination state). So **only the data fetch moves to the server**; the view is rendered by an async Server Component and receives data as serializable props.
3. **No polling — fetched once per full page load.** Data is fetched server-side with `cache: "no-store"` (fresh each page load) and frozen for the session. Switching screens (client-side) does not refetch; Overview updates only on a browser reload. Accepted tradeoff per requirements.
4. **Clean up CORS.** Server-side fetch never triggers browser CORS, so the worker's `cors.ts` plugin and `DASHBOARD_ORIGIN` env var are removed. The dashboard switches from `NEXT_PUBLIC_WORKER_BASE_URL` (client-exposed) to server-only `WORKER_BASE_URL`.

## Architecture

```text
Browser GET /
  └─ app/page.tsx (Server Component)
       renders <CockpitApp overviewSlot={<Suspense fallback={<OverviewSkeleton/>}>
                                            <OverviewData/>          ← async Server Component
                                          </Suspense>} />
  └─ CockpitApp (client) paints chrome immediately (sidebar/topbar/tweaks),
       renders overviewSlot where screen === "overview"
  └─ OverviewData (server) fetches the 5 /api/v1 endpoints server-side
       (per-endpoint try/catch → null/empty fallback), renders <OverviewScreen data={...}/>
  └─ OverviewScreen (client) reads data from props, openRun from context; no fetching
```

Data flow: browser → Next server → worker `/api/v1/*` (no CORS) → Suspense stream → client hydration. No further network calls after load.

## Components

### Create
- `apps/dashboard/app/cockpit-app.tsx` — **client**. The current `app/page.tsx` body verbatim (tweaks via `useTweaks`, `screen`/`activeRun`/`persona`/`range`/`env` state, hash nav effects, activity drawer, tweaks panel), with two changes:
  - Accepts `overviewSlot: React.ReactNode` prop; renders `{screen === "overview" && overviewSlot}` in place of `<OverviewScreen onOpenRun={openRun}/>`.
  - Adds `openRun` to the `CockpitCtx` provider value (so the server-rendered Overview reaches it via context, not a prop closure).
- `apps/dashboard/app/overview-data.tsx` — **async Server Component**. Fetches all 5 endpoints with `getJSON`, each wrapped in `try/catch` returning the documented fallback shape on failure:
  - kpis → `{ generatedAt: <now>, runs24h: null, p95: null, errors24h: null, cost24h: null }`
  - eval-health → `{ available: false, reason: "Worker unavailable." }`
  - runs → `{ generatedAt: <now>, available: false, rows: [], total: 0, counts: {success:0,running:0,awaiting:0,failed:0,blocked:0} }`
  - runs/live → `{ generatedAt: <now>, rows: [] }`
  - workflows (limit=100) → `{ generatedAt: <now>, rows: [], total: 0 }`
  - Renders `<OverviewScreen data={{ kpis, evalHealth, liveRuns, recentRuns, workflows }} />`.
- `apps/dashboard/app/overview-skeleton.tsx` — **server/static**. Lightweight Suspense fallback (cards + table placeholders matching the Overview layout). May be a simple muted skeleton.
- `apps/dashboard/lib/api/server.ts` — `getJSON<T>(path: string): Promise<T>` using `process.env.WORKER_BASE_URL ?? ""`, `fetch(BASE + path, { cache: "no-store" })`, throws on `!res.ok`. Server-only (no `NEXT_PUBLIC_`).

### Modify
- `apps/dashboard/app/page.tsx` → **Server Component**. Drops all client logic (moved to `cockpit-app.tsx`); renders `<CockpitApp overviewSlot={...}/>`.
- `apps/dashboard/app/layout.tsx` → remove the `Providers` import and `<Providers>` wrap; `<body>{children}</body>`.
- `apps/dashboard/components/cockpit/screens/overview.tsx` → `OverviewScreen` becomes presentational:
  - Signature: `OverviewScreen({ data }: { data: OverviewScreenData })` where `OverviewScreenData` bundles the 5 typed responses (fields: `kpis: KpisResponse`, `evalHealth: EvalHealthResponse`, `liveRuns: LiveRunsResponse`, `recentRuns: RunsResponse`, `workflows: WorkflowsResponse`). (Distinct from the `OverviewData` async Server Component in `overview-data.tsx`.)
  - Remove `import { overviewQueries }` and all `useQuery` calls; read the five values from `data`.
  - Read `openRun` from `useCockpit()` instead of an `onOpenRun` prop.
  - `NowRunningPanel`/`AwaitingInputPanel`/`EvalHealthKPI` keep their current prop-based shape; they receive values sliced from `data`.
  - Pagination (recent runs, workflows): keep `CkPagination` + local `useState` page index, but **slice client-side** over the server-fetched rows (no refetch). Workflows fetched with a generous limit so all rows are present.
  - Stays `"use client"`.
- `apps/dashboard/components/cockpit/context.tsx` → add `openRun: (run: Run) => void` to `CockpitCtxValue` and the default context (no-op) + provider value.
- `apps/dashboard/package.json` → remove `@tanstack/react-query` and `@tanstack/react-query-devtools`.
- `apps/worker/env.ts` → remove the `DASHBOARD_ORIGIN` field.
- `apps/worker/env.test.ts` → remove `DASHBOARD_ORIGIN` from the fixture.

### Delete
- `apps/dashboard/app/providers.tsx`
- `apps/dashboard/lib/api/overview.ts`
- `apps/dashboard/lib/api/client.ts`
- `apps/worker/src/plugins/cors.ts`

## Error handling

Per-endpoint `try/catch` in `overview-data.tsx` → each failed fetch falls back to its null/empty response shape, so the Overview renders its N/A / empty / "Run history coming soon" / "—" states even when the worker is down. No client retry (no polling). A worker outage produces a fully-rendered, interactive page with empty data — matching the behavior verified in the prior plan's smoke test.

## Env / config

| Before | After |
|---|---|
| `NEXT_PUBLIC_WORKER_BASE_URL` (client) | `WORKER_BASE_URL` (server-only) |
| worker `DASHBOARD_ORIGIN` (required) | removed |

Local dev: `WORKER_BASE_URL=http://localhost:3000` for the dashboard; worker boots with `pnpm dev` (no `DASHBOARD_ORIGIN` needed). Use `PORT=3001` for the dashboard (not `-- -p`, which Next 15 mis-parses).

## Out of scope (unchanged)
- The 7 non-Overview screens (Runs, Trace, Prompts, Evals, Cost, Pre-sandbox, Post-PR) — still consume `AIWF_DATA` mock.
- Worker `cron`/`webhooks` routes and the `/api/v1/*` route handlers themselves.
- Cockpit chrome behavior (sidebar, topbar, tweaks, activity drawer).
- `@shared/contracts` types — reused as-is.

## Testing / verification
1. `pnpm --dir apps/dashboard exec tsc --noEmit` → 0.
2. `pnpm --dir apps/worker exec tsc --noEmit` → 0; `pnpm --dir apps/worker test` → all pass (env test no longer references `DASHBOARD_ORIGIN`).
3. `rg -n "@tanstack/react-query|overviewQueries|useQuery|NEXT_PUBLIC_WORKER_BASE_URL" apps/dashboard -g "!node_modules"` → no source matches.
4. Live: boot worker (`pnpm dev`) + dashboard (`PORT=3001 WORKER_BASE_URL=http://localhost:3000 pnpm dev`). Confirm:
   - Overview renders server-side (view source shows the data region, not just a client loading shell).
   - N/A KPIs, eval donut, "No runs in flight", "No clarifications pending", "Run history coming soon", 3-row workflows table with "—".
   - **No** `/api/v1/*` requests in the browser Network tab (fetch is server-side now).
   - Worker-down: reload → page still renders N/A states, no crash.

## Acceptance criteria
1. Typechecks pass for both apps; worker tests pass.
2. `@tanstack/react-query` (+ devtools), `app/providers.tsx`, `lib/api/overview.ts`, `lib/api/client.ts`, worker `cors.ts`, and `DASHBOARD_ORIGIN` are all gone.
3. The browser makes **zero** direct `/api/v1/*` calls when loading Overview (verified in Network tab); data arrives server-rendered.
4. Worker-down reload renders the Overview N/A/empty states without crashing.
5. Non-Overview screens are unchanged and still build.
