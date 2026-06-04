# Overview → Server-Component Fetch (drop React Query) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard Overview screen's client-side React Query polling with a server-side fetch that streams into the client cockpit via `<Suspense>`, remove `@tanstack/react-query` entirely, and delete the now-unneeded worker CORS layer.

**Architecture:** `app/page.tsx` becomes a Server Component that renders the client `CockpitApp` and passes it an `overviewSlot` — a `<Suspense>` boundary wrapping the async Server Component `OverviewData`. `OverviewData` fetches the 5 `/api/v1` endpoints server-side (each with a try/catch fallback) and renders the now-presentational `OverviewScreen` with the data as props. The cockpit chrome stays a client SPA; only the Overview data fetch moves server-side. Because fetches are server-to-server, the worker's CORS plugin and `DASHBOARD_ORIGIN` env var are removed.

**Tech Stack:** Next.js 15.5 (App Router, stable — no PPR), React Server Components + Suspense, TypeScript. Worker is Nitro + `@t3-oss/env-core` + Vitest. Shared types live in `@shared/contracts`.

**Reference spec:** `docs/superpowers/specs/2026-06-01-overview-rsc-server-components-design.md`

---

## File Structure

**Create:**
- `apps/dashboard/lib/api/server.ts` — server-only `getJSON<T>` fetch helper (`cache: "no-store"`, `WORKER_BASE_URL`).
- `apps/dashboard/app/cockpit-app.tsx` — the client cockpit shell (the current `page.tsx` body), accepting an `overviewSlot` prop and providing `openRun` via context.
- `apps/dashboard/app/overview-data.tsx` — async Server Component that fetches the 5 endpoints and renders `<OverviewScreen data=… />`.
- `apps/dashboard/app/overview-skeleton.tsx` — static Suspense fallback.

**Modify:**
- `apps/dashboard/app/page.tsx` — becomes a Server Component rendering `<CockpitApp overviewSlot={…}/>`.
- `apps/dashboard/app/layout.tsx` — drop `Providers`.
- `apps/dashboard/components/cockpit/context.tsx` — add `openRun` to context.
- `apps/dashboard/components/cockpit/screens/overview.tsx` — `OverviewScreen` becomes presentational (reads `data` prop + `openRun` from context; client-side pagination).
- `apps/dashboard/package.json` — remove the two `@tanstack/*` deps.
- `apps/worker/env.ts` — remove `DASHBOARD_ORIGIN`.
- `apps/worker/env.test.ts` — remove `DASHBOARD_ORIGIN` from the fixture.

**Delete:**
- `apps/dashboard/app/providers.tsx`
- `apps/dashboard/lib/api/overview.ts`
- `apps/dashboard/lib/api/client.ts`
- `apps/worker/src/plugins/cors.ts`

> **Note on TDD:** The dashboard has no test runner; its tasks are verified with `tsc --noEmit` + targeted `grep` + a live smoke check. The worker uses Vitest, so its task (Task 5) is verified with `pnpm test`. Commit after each task so each commit is independently green.

---

### Task 1: Server-only fetch helper

**Files:**
- Create: `apps/dashboard/lib/api/server.ts`

- [ ] **Step 1: Create the helper**

```ts
// apps/dashboard/lib/api/server.ts
const BASE = process.env.WORKER_BASE_URL ?? "";

/**
 * Server-only JSON fetch. Runs on the Next server (never the browser), so no
 * CORS and no NEXT_PUBLIC_ exposure. `no-store` => fresh on every full page load.
 */
export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: 0 errors. (The old `lib/api/client.ts`/`overview.ts` still exist and still compile at this point — they're removed in Task 3.)

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/lib/api/server.ts
git commit -m "feat(dashboard): add server-only getJSON fetch helper"
```

---

### Task 2: Static Suspense skeleton

**Files:**
- Create: `apps/dashboard/app/overview-skeleton.tsx`

- [ ] **Step 1: Create the skeleton**

A lightweight, server/static fallback matching the Overview layout (KPI strip + two live panels + two tables). No `"use client"`, no hooks.

```tsx
// apps/dashboard/app/overview-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function OverviewSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-5">
      {/* Hero KPIs */}
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Block key={i} className="h-[124px]" />
        ))}
      </div>
      {/* Live row */}
      <div className="grid grid-cols-2 gap-3">
        <Block className="h-[220px]" />
        <Block className="h-[220px]" />
      </div>
      {/* Recent runs */}
      <Block className="h-[360px]" />
      {/* Workflows */}
      <Block className="h-[260px]" />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/app/overview-skeleton.tsx
git commit -m "feat(dashboard): add Overview Suspense skeleton"
```

---

### Task 3: The atomic swap — server fetch, presentational Overview, client cockpit shell

This is one coherent change: changing `OverviewScreen`'s signature and the context shape forces `page.tsx`/`layout.tsx`/`cockpit-app.tsx` to land together. Apply all steps, then typecheck once at the end. This is intentionally a single commit because no intermediate subset typechecks.

**Files:**
- Modify: `apps/dashboard/components/cockpit/context.tsx`
- Modify: `apps/dashboard/components/cockpit/screens/overview.tsx`
- Create: `apps/dashboard/app/cockpit-app.tsx`
- Create: `apps/dashboard/app/overview-data.tsx`
- Modify: `apps/dashboard/app/page.tsx`
- Modify: `apps/dashboard/app/layout.tsx`
- Delete: `apps/dashboard/app/providers.tsx`, `apps/dashboard/lib/api/overview.ts`, `apps/dashboard/lib/api/client.ts`

- [ ] **Step 1: Add `openRun` to the cockpit context**

In `apps/dashboard/components/cockpit/context.tsx`, the file already imports nothing from domain types. Add a `Run` import and the `openRun` field to the interface and the default context.

Replace the import line at the top:

```tsx
import { createContext, useContext } from "react";
```

with:

```tsx
import { createContext, useContext } from "react";
import type { Run } from "@/lib/types";
```

Replace the `CockpitCtxValue` interface:

```tsx
export interface CockpitCtxValue {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  persona: Persona;
  range: TimeRange;
  env: EnvName;
}
```

with:

```tsx
export interface CockpitCtxValue {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  persona: Persona;
  range: TimeRange;
  env: EnvName;
  /** Open a run in the Trace screen. Provided by CockpitApp; no-op in the default ctx. */
  openRun: (run: Run) => void;
}
```

Replace the default context value:

```tsx
export const CockpitCtx = createContext<CockpitCtxValue>({
  t: TWEAK_DEFAULTS,
  setTweak: () => {},
  persona: "swe",
  range: "24h",
  env: "prod",
});
```

with:

```tsx
export const CockpitCtx = createContext<CockpitCtxValue>({
  t: TWEAK_DEFAULTS,
  setTweak: () => {},
  persona: "swe",
  range: "24h",
  env: "prod",
  openRun: () => {},
});
```

- [ ] **Step 2: Make `OverviewScreen` presentational**

In `apps/dashboard/components/cockpit/screens/overview.tsx`:

(a) Replace the import block (lines 1–20, ending at the `EvalHealthResponse` import) so React Query is gone and all five response types are imported:

```tsx
"use client";

import React, { useState, useEffect } from "react";
import {
  CkCard,
  CkKPI,
  CkChip,
  CkStatusPill,
  CkDot,
  TicketLink,
  PRLink,
  CkPagination,
} from "@/components/ui";
import { Spark, Donut } from "@/components/charts";
import { spanColor } from "@/lib/theme";
import { useCockpit } from "@/components/cockpit/context";
import type { Run } from "@/lib/types";
import type {
  KpisResponse,
  EvalHealthResponse,
  LiveRunsResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";

/** Bundle of the five server-fetched responses passed into the presentational Overview. */
export interface OverviewScreenData {
  kpis: KpisResponse;
  evalHealth: EvalHealthResponse;
  liveRuns: LiveRunsResponse;
  recentRuns: RunsResponse;
  workflows: WorkflowsResponse;
}
```

(b) Leave `EvalHealthKPI`, `NowRunningPanel`, and `AwaitingInputPanel` (lines 22–279) **unchanged** — their prop shapes are preserved.

(c) Replace the entire `OverviewScreen` function (from `export function OverviewScreen({` through its closing `}` at the end of the file) with this presentational version. It reads everything from `data`, gets `openRun` from context, and paginates client-side by slicing the server-fetched rows:

```tsx
export function OverviewScreen({ data }: { data: OverviewScreenData }) {
  const { t, openRun } = useCockpit();

  const PAGE_SIZE = 7;
  const [runsPage, setRunsPage] = useState(0);
  const WF_PAGE_SIZE = 5;
  const [wfPage, setWfPage] = useState(0);

  const liveRows = data.liveRuns.rows;
  const recentData = data.recentRuns;
  const wfData = data.workflows;

  // Client-side pagination over the rows fetched once on the server (no refetch).
  const recentRows = recentData.rows.slice(
    runsPage * PAGE_SIZE,
    runsPage * PAGE_SIZE + PAGE_SIZE,
  );
  const runsTotalPages = Math.max(
    1,
    Math.ceil(recentData.rows.length / PAGE_SIZE),
  );
  const wfRows = wfData.rows.slice(
    wfPage * WF_PAGE_SIZE,
    wfPage * WF_PAGE_SIZE + WF_PAGE_SIZE,
  );
  const wfTotalPages = Math.max(
    1,
    Math.ceil(wfData.rows.length / WF_PAGE_SIZE),
  );

  const heroRuns = data.kpis.runs24h;
  const heroCost = data.kpis.cost24h;
  const heroP95 = data.kpis.p95;
  const heroErrors = data.kpis.errors24h;
  const evalData = data.evalHealth;
  const heroEval: Extract<EvalHealthResponse, { available: true }> | null =
    evalData.available === true ? evalData : null;

  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-5">
      {/* Editorial hero — chrome preserved; data cells degrade to N/A */}
      {t.showEditorialHero && (
        <div className="bg-coal text-white rounded-sm p-7 grid grid-cols-[1.5fr_1fr] gap-8 relative overflow-hidden">
          <svg
            className="absolute -right-[60px] -top-[60px] opacity-[0.07]"
            width="320"
            height="320"
            viewBox="0 0 320 320"
          >
            {Array.from({ length: 8 }, (_, i) => (
              <circle
                key={i}
                cx="160"
                cy="160"
                r={16 + i * 18}
                fill="none"
                stroke="#fff"
                strokeWidth="1"
              />
            ))}
          </svg>
          <div className="relative z-[1] flex flex-col gap-3">
            <div className="font-mono text-[10px] text-white/50 tracking-[0.08em] uppercase">
              Last 24 hours
            </div>
            <div className="font-display font-medium text-[36px] leading-[1.15] tracking-[-0.025em] m-0 text-balance">
              Overview · {data.kpis.generatedAt ? new Date(data.kpis.generatedAt).toLocaleTimeString() : "—"}
            </div>
            <div className="font-body font-normal text-sm leading-[1.55] text-white/70 max-w-[540px]">
              Historical aggregates are not wired up yet. The Now-running and Workflows panels reflect the worker's live state.
            </div>
          </div>
          <div className="relative z-1 grid grid-cols-2 gap-4 content-center">
            {[
              { l: "Runs · 24h", v: heroRuns ? heroRuns.value.toLocaleString("en-US") : "N/A" },
              { l: "Cost today", v: heroCost ? "$" + heroCost.value.toFixed(0) : "N/A" },
              { l: "p95 latency", v: heroP95 ? heroP95.valueSec + "s" : "N/A" },
              { l: "Eval score", v: heroEval ? heroEval.score.toFixed(1) : "N/A" },
            ].map((k) => (
              <div key={k.l}>
                <div className="font-mono text-[10px] text-white/50 tracking-[0.06em] uppercase">
                  {k.l}
                </div>
                <div className="font-display font-medium text-[32px] leading-none tracking-[-0.02em] mt-1">
                  {k.v}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hero KPIs */}
      <div className="grid grid-cols-4 gap-3">
        <CkKPI
          label="Runs · 24h"
          value={heroRuns ? heroRuns.value.toLocaleString("en-US") : ""}
          delta={
            heroRuns
              ? `${heroRuns.deltaPct >= 0 ? "↗" : "↘"} ${Math.abs(heroRuns.deltaPct).toFixed(1)}% vs 24h ago`
              : ""
          }
          deltaTone="good"
          spark={heroRuns?.spark ?? []}
          sparkColor="#3C43E7"
          disabled={!heroRuns}
        />
        <EvalHealthKPI data={data.evalHealth} />
        <CkKPI
          label="p95 latency"
          value={heroP95 ? heroP95.valueSec + "s" : ""}
          delta={
            heroP95
              ? `${heroP95.deltaSec >= 0 ? "↗" : "↘"} ${Math.abs(heroP95.deltaSec).toFixed(1)}s vs 24h ago`
              : ""
          }
          deltaTone="good"
          spark={heroP95?.spark ?? []}
          sparkColor="#181B20"
          disabled={!heroP95}
        />
        <CkKPI
          label="Errors · 24h"
          value={heroErrors ? heroErrors.value.toString() : ""}
          delta={
            heroErrors
              ? `${heroErrors.deltaPct >= 0 ? "↗" : "↘"} ${Math.abs(heroErrors.deltaPct).toFixed(1)}% vs 24h ago`
              : ""
          }
          deltaTone="good"
          spark={heroErrors?.spark ?? []}
          sparkColor="#D14343"
          disabled={!heroErrors}
        />
      </div>

      {/* Live row */}
      <div className="grid grid-cols-2 gap-3">
        <NowRunningPanel rows={liveRows} onOpenRun={openRun} />
        <AwaitingInputPanel rows={liveRows} onOpenRun={openRun} />
      </div>

      {/* Recent runs */}
      <CkCard
        eyebrow="Run timeline · last 24h"
        title="Recent runs"
        action={
          recentData.available ? (
            <div className="flex items-center gap-2">
              <CkChip tone="success">{recentData.counts.success} shipped</CkChip>
              <CkChip tone="running">{recentData.counts.running} running</CkChip>
              <CkChip tone="awaiting">{recentData.counts.awaiting} awaiting</CkChip>
            </div>
          ) : null
        }
        pad={0}
      >
        {recentData.available === false ? (
          <div className="px-5 py-10 text-center text-neutral-500 text-sm">
            Run history coming soon
          </div>
        ) : (
          <>
            <table className="w-full border-collapse font-body text-[13px]">
              <thead>
                <tr className="bg-off-white text-neutral-700 font-mono text-[10px] tracking-[0.06em] uppercase">
                  {[
                    "Status",
                    "Ticket · title",
                    "Workflow",
                    "Model",
                    "Started",
                    "Duration",
                    "Cost",
                    "Eval",
                  ].map((h, i) => (
                    <th
                      key={i}
                      className={`px-4 py-2.5 font-medium border-b border-neutral-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentRows.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => openRun(r)}
                    className={`cursor-pointer transition-colors duration-100 hover:bg-off-white ${i < recentRows.length - 1 ? "border-b border-neutral-200" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <CkStatusPill status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="font-semibold text-neutral-900 max-w-[480px] overflow-hidden text-ellipsis whitespace-nowrap block">
                          {r.ticketTitle}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                          {r.prNumber && r.prUrl && (
                            <PRLink num={r.prNumber} url={r.prUrl} />
                          )}
                          <span className="font-mono text-[10px] text-neutral-500">
                            {r.actor}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <CkChip style={{ background: "#F2F4F6", color: "#3E444C" }}>
                        {r.workflowName}
                      </CkChip>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-neutral-700">
                      {r.model}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[11px] text-neutral-500">
                      {r.startedAtMin}m ago
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      {r.duration ? r.duration + "s" : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      ${r.cost.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.evalScore ? (
                        <span
                          className="font-mono text-xs font-semibold"
                          style={{
                            color:
                              r.evalScore > 0.9
                                ? "#3F6B1E"
                                : r.evalScore > 0.85
                                  ? "#7A5A00"
                                  : "#A2351C",
                          }}
                        >
                          {(r.evalScore * 100).toFixed(0)}
                        </span>
                      ) : (
                        <span className="font-mono text-[11px] text-[#D2D6DA]">
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <CkPagination
              page={runsPage}
              totalPages={runsTotalPages}
              total={recentData.rows.length}
              start={runsPage * PAGE_SIZE}
              shown={recentRows.length}
              onChange={setRunsPage}
            />
          </>
        )}
      </CkCard>

      {/* Workflows */}
      <CkCard
        eyebrow="Vercel workflow registry"
        title="Workflows"
        action={null}
        pad={0}
      >
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-off-white text-neutral-700 font-mono text-[10px] tracking-[0.06em] uppercase">
              <th className="px-4 py-2.5 text-left font-medium border-b border-neutral-200">
                Workflow · latest ticket
              </th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">Runs 24h</th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">p95</th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">Err</th>
              <th className="px-2 py-2.5 text-right font-medium border-b border-neutral-200">Cost</th>
              <th className="px-4 py-2.5 text-right font-medium border-b border-neutral-200">24h trend</th>
            </tr>
          </thead>
          <tbody>
            {wfRows.map((w, i) => {
              const latest = w.latestRun;
              return (
                <tr
                  key={w.id}
                  className={`transition-colors duration-100 hover:bg-off-white ${i < wfRows.length - 1 ? "border-b border-neutral-200" : ""}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900">{w.name}</span>
                        {w.primary && <CkChip tone="mariner">primary</CkChip>}
                        <span className="font-mono text-[10px] text-neutral-500">· {w.gateway}</span>
                      </div>
                      {latest ? (
                        <div className="flex items-center gap-2 text-xs text-neutral-700">
                          <TicketLink ticket={latest.ticket} url={latest.ticketUrl} />
                          <span className="text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap max-w-[560px]">
                            {latest.ticketTitle}
                          </span>
                          {latest.prNumber && latest.prUrl && (
                            <PRLink num={latest.prNumber} url={latest.prUrl} />
                          )}
                        </div>
                      ) : (
                        <div className="text-[11px] text-neutral-500">No recent tickets</div>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 text-right font-mono font-medium">
                    {w.runs24h === null ? "—" : w.runs24h.toLocaleString("en-US")}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-neutral-700">
                    {w.p95 === null ? "—" : `${w.p95}s`}
                  </td>
                  <td
                    className={`px-2 py-3 text-right font-mono ${w.errRate !== null && w.errRate > 0.02 ? "text-[#A2351C]" : "text-neutral-700"}`}
                  >
                    {w.errRate === null ? "—" : `${(w.errRate * 100).toFixed(2)}%`}
                  </td>
                  <td className="px-2 py-3 text-right font-mono font-medium">
                    {w.costToday === null ? "—" : `$${w.costToday.toFixed(2)}`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {w.trend24h && w.trend24h.length > 0 ? (
                      <div className="inline-block">
                        <Spark data={w.trend24h} w={120} h={24} stroke="#3C43E7" fill="#3C43E7" />
                      </div>
                    ) : (
                      <div className="inline-block w-[120px] h-[24px] bg-app-bg rounded-[1px]" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <CkPagination
          page={wfPage}
          totalPages={wfTotalPages}
          total={wfData.rows.length}
          start={wfPage * WF_PAGE_SIZE}
          shown={wfRows.length}
          onChange={setWfPage}
        />
      </CkCard>
    </div>
  );
}
```

- [ ] **Step 3: Create the client cockpit shell**

`apps/dashboard/app/cockpit-app.tsx` is the current `page.tsx` body with two changes: it accepts an `overviewSlot` prop (rendered where `screen === "overview"`), and it adds `openRun` to the context provider value.

```tsx
// apps/dashboard/app/cockpit-app.tsx
"use client";

import { useEffect, useState } from "react";

import { AIWF_DATA } from "@/lib/data/mock";
import { useTweaks } from "@/lib/use-tweaks";
import type { Run } from "@/lib/types";

import {
  CockpitCtx,
  TWEAK_DEFAULTS,
  type Tweaks,
} from "@/components/cockpit/context";
import { CkSidebar, CkTopbar } from "@/components/cockpit/chrome";
import { CkActivityDrawer } from "@/components/cockpit/activity-drawer";
import {
  TweaksPanel,
  TweakSection,
  TweakRadio,
  TweakToggle,
  TweakColor,
} from "@/components/cockpit/tweaks-panel";

import { RunsScreen } from "@/components/cockpit/screens/runs";
import { TraceScreen } from "@/components/cockpit/screens/trace";
import { PromptsScreen } from "@/components/cockpit/screens/prompts";
import { EvalsScreen } from "@/components/cockpit/screens/evals";
import { CostScreen } from "@/components/cockpit/screens/cost";
import { PreSandboxScreen } from "@/components/cockpit/screens/presandbox";
import { PostPRReviewScreen } from "@/components/cockpit/screens/postpr";

const VALID_SCREENS = [
  "overview",
  "runs",
  "trace",
  "prompts",
  "evals",
  "cost",
  "presandbox",
  "postpr",
] as const;

export function CockpitApp({ overviewSlot }: { overviewSlot: React.ReactNode }) {
  const [t, setTweak] = useTweaks<Tweaks>(TWEAK_DEFAULTS);

  const [screen, setScreen] = useState<string>("overview");
  const [activeRun, setActiveRun] = useState<Run>(AIWF_DATA.RUNS[0]);
  const [persona, setPersona] = useState("swe");
  const [range, setRange] = useState("24h");
  const [env, setEnv] = useState("prod");
  const [activityOpen, setActivityOpen] = useState<boolean>(
    !!t.activityDrawerOpen,
  );

  // Read the initial screen from the hash after mount (avoids SSR/client mismatch).
  useEffect(() => {
    const initial = window.location.hash ? window.location.hash.slice(1) : "";
    if ((VALID_SCREENS as readonly string[]).includes(initial)) {
      setScreen(initial);
    }
  }, []);

  useEffect(() => {
    setActivityOpen(!!t.activityDrawerOpen);
  }, [t.activityDrawerOpen]);

  useEffect(() => {
    window.location.hash = screen;
  }, [screen]);

  const openRun = (r: Run) => {
    setActiveRun(r);
    setScreen("trace");
  };

  return (
    <CockpitCtx.Provider value={{ t, setTweak, persona, range, env, openRun }}>
      <div className="h-screen w-screen flex overflow-hidden bg-app-bg relative">
        <CkSidebar active={screen} onNav={setScreen} />
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <CkTopbar
            persona={persona}
            setPersona={setPersona}
            range={range}
            setRange={setRange}
            env={env}
            setEnv={setEnv}
            activityOpen={activityOpen}
            onToggleActivity={() => setActivityOpen((v) => !v)}
          />
          <div className="flex-1 overflow-auto min-h-0">
            {screen === "overview" && overviewSlot}
            {screen === "runs" && <RunsScreen onOpenRun={openRun} />}
            {screen === "trace" && (
              <TraceScreen run={activeRun} onBack={() => setScreen("runs")} />
            )}
            {screen === "prompts" && <PromptsScreen />}
            {screen === "evals" && <EvalsScreen />}
            {screen === "cost" && <CostScreen />}
            {screen === "presandbox" && <PreSandboxScreen />}
            {screen === "postpr" && <PostPRReviewScreen />}
          </div>
        </main>

        <CkActivityDrawer
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
        />

        <TweaksPanel title="Cockpit tweaks">
          <TweakSection label="Layout" />
          <TweakRadio
            label="Density"
            value={t.density}
            options={["compact", "comfy"]}
            onChange={(v) => setTweak("density", v as Tweaks["density"])}
          />
          <TweakToggle
            label="Editorial hero on Overview"
            value={t.showEditorialHero}
            onChange={(v) => setTweak("showEditorialHero", v)}
          />
          <TweakToggle
            label="Streaming run in lists"
            value={t.showStreamingRun}
            onChange={(v) => setTweak("showStreamingRun", v)}
          />
          <TweakToggle
            label="Activity drawer open"
            value={t.activityDrawerOpen}
            onChange={(v) => setTweak("activityDrawerOpen", v)}
          />
          <TweakSection label="Brand" />
          <TweakColor
            label="Accent"
            value={t.accentColor}
            options={["#3C43E7", "#FD6027", "#181B20", "#8FC548"]}
            onChange={(v) => setTweak("accentColor", v)}
          />
        </TweaksPanel>
      </div>
    </CockpitCtx.Provider>
  );
}
```

- [ ] **Step 4: Create the async Server Component that fetches data**

`apps/dashboard/app/overview-data.tsx` — no `"use client"`. Each endpoint is wrapped in its own try/catch that falls back to the documented null/empty shape, so a worker outage still renders a fully interactive Overview.

```tsx
// apps/dashboard/app/overview-data.tsx
import { getJSON } from "@/lib/api/server";
import {
  OverviewScreen,
  type OverviewScreenData,
} from "@/components/cockpit/screens/overview";
import type {
  KpisResponse,
  EvalHealthResponse,
  LiveRunsResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";

export async function OverviewData() {
  const now = new Date().toISOString();

  let kpis: KpisResponse;
  try {
    kpis = await getJSON<KpisResponse>("/api/v1/overview/kpis");
  } catch {
    kpis = { generatedAt: now, runs24h: null, p95: null, errors24h: null, cost24h: null };
  }

  let evalHealth: EvalHealthResponse;
  try {
    evalHealth = await getJSON<EvalHealthResponse>("/api/v1/overview/eval-health");
  } catch {
    evalHealth = { available: false, reason: "Worker unavailable." };
  }

  let recentRuns: RunsResponse;
  try {
    recentRuns = await getJSON<RunsResponse>("/api/v1/runs?limit=100&offset=0");
  } catch {
    recentRuns = {
      generatedAt: now,
      available: false,
      rows: [],
      total: 0,
      counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
    };
  }

  let liveRuns: LiveRunsResponse;
  try {
    liveRuns = await getJSON<LiveRunsResponse>(
      "/api/v1/runs/live?status=running,awaiting",
    );
  } catch {
    liveRuns = { generatedAt: now, rows: [] };
  }

  let workflows: WorkflowsResponse;
  try {
    workflows = await getJSON<WorkflowsResponse>("/api/v1/workflows?limit=100&offset=0");
  } catch {
    workflows = { generatedAt: now, rows: [], total: 0 };
  }

  const data: OverviewScreenData = { kpis, evalHealth, liveRuns, recentRuns, workflows };
  return <OverviewScreen data={data} />;
}
```

- [ ] **Step 5: Rewrite `page.tsx` as a Server Component**

Replace the entire contents of `apps/dashboard/app/page.tsx`:

```tsx
// apps/dashboard/app/page.tsx
import { Suspense } from "react";

import { CockpitApp } from "./cockpit-app";
import { OverviewData } from "./overview-data";
import { OverviewSkeleton } from "./overview-skeleton";

export default function Page() {
  return (
    <CockpitApp
      overviewSlot={
        <Suspense fallback={<OverviewSkeleton />}>
          <OverviewData />
        </Suspense>
      }
    />
  );
}
```

- [ ] **Step 6: Drop `Providers` from the layout**

In `apps/dashboard/app/layout.tsx`, remove the import:

```tsx
import { Providers } from "./providers";
```

and replace the body:

```tsx
      <body>
        <Providers>{children}</Providers>
      </body>
```

with:

```tsx
      <body>{children}</body>
```

- [ ] **Step 7: Delete the React Query + client-fetch files**

```bash
git rm apps/dashboard/app/providers.tsx \
       apps/dashboard/lib/api/overview.ts \
       apps/dashboard/lib/api/client.ts
```

- [ ] **Step 8: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 9: Verify the removals**

Run: `grep -rn "overviewQueries\|useQuery\|NEXT_PUBLIC_WORKER_BASE_URL\|app/providers\|lib/api/overview\|lib/api/client" apps/dashboard --include="*.ts" --include="*.tsx"`
Expected: no matches. (`@tanstack/react-query` still appears only in `package.json` until Task 4.)

- [ ] **Step 10: Commit**

```bash
git add apps/dashboard/app/cockpit-app.tsx \
        apps/dashboard/app/overview-data.tsx \
        apps/dashboard/app/page.tsx \
        apps/dashboard/app/layout.tsx \
        apps/dashboard/components/cockpit/context.tsx \
        apps/dashboard/components/cockpit/screens/overview.tsx
git commit -m "feat(dashboard): fetch Overview server-side via Suspense, drop React Query wiring"
```

---

### Task 4: Remove the `@tanstack/react-query` dependencies

**Files:**
- Modify: `apps/dashboard/package.json`

- [ ] **Step 1: Remove both deps**

In `apps/dashboard/package.json`, delete these two lines from `dependencies`:

```json
    "@tanstack/react-query": "^5.100.14",
```
```json
    "@tanstack/react-query-devtools": "^5.100.14",
```

- [ ] **Step 2: Update the lockfile**

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` updated to drop the two packages.

- [ ] **Step 3: Verify no remaining references**

Run: `grep -rn "@tanstack/react-query" apps/dashboard --include="*.ts" --include="*.tsx" --include="*.json"`
Expected: no matches.

- [ ] **Step 4: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml
git commit -m "chore(dashboard): remove @tanstack/react-query deps"
```

---

### Task 5: Remove the worker CORS layer and `DASHBOARD_ORIGIN`

Server-side fetch never triggers browser CORS, so the plugin and env var are dead.

**Files:**
- Delete: `apps/worker/src/plugins/cors.ts`
- Modify: `apps/worker/env.ts`
- Modify: `apps/worker/env.test.ts`

- [ ] **Step 1: Delete the CORS plugin**

```bash
git rm apps/worker/src/plugins/cors.ts
```

(Nitro auto-registers plugins from `src/plugins/`; deleting the file removes it — nothing else imports it.)

- [ ] **Step 2: Remove `DASHBOARD_ORIGIN` from the env schema**

In `apps/worker/env.ts`, delete these lines (the `// Dashboard` comment and the field):

```ts
    // Dashboard
    DASHBOARD_ORIGIN: z.string().url(),
```

- [ ] **Step 3: Remove `DASHBOARD_ORIGIN` from the test fixture**

In `apps/worker/env.test.ts`, delete this line from `VALID_ENV`:

```ts
    DASHBOARD_ORIGIN: "http://localhost:3001",
```

- [ ] **Step 4: Verify no remaining references**

Run: `grep -rn "DASHBOARD_ORIGIN\|plugins/cors" apps/worker --include="*.ts"`
Expected: no matches.

- [ ] **Step 5: Typecheck the worker**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Run the worker test suite**

Run: `cd apps/worker && pnpm test`
Expected: all tests pass (the env tests no longer reference `DASHBOARD_ORIGIN`).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/env.ts apps/worker/env.test.ts
git commit -m "chore(worker): remove CORS plugin and DASHBOARD_ORIGIN (server-side fetch)"
```

---

### Task 6: Live smoke verification

Final end-to-end check from the design's verification section. No code; confirm behavior.

**Local dev env:** dashboard uses `WORKER_BASE_URL` (server-only) and `PORT=3001` (not `-- -p`, which Next 15 mis-parses); worker boots with `pnpm dev` and no longer needs `DASHBOARD_ORIGIN`.

- [ ] **Step 1: Boot both apps**

Worker: `cd apps/worker && pnpm dev`
Dashboard (separate terminal): `cd apps/dashboard && PORT=3001 WORKER_BASE_URL=http://localhost:3000 pnpm dev`

- [ ] **Step 2: Confirm server-rendered Overview**

Load `http://localhost:3001`. View source (Cmd+U) and confirm the data region (KPI/table markup) is present in the initial HTML, not just a client loading shell.
Expected: Overview content is in the source.

- [ ] **Step 3: Confirm zero direct `/api/v1/*` calls from the browser**

Open DevTools → Network, reload.
Expected: **no** `/api/v1/*` requests from the browser (the fetch is server-side now).

- [ ] **Step 4: Confirm worker-down resilience**

Stop the worker, reload `http://localhost:3001`.
Expected: page still renders — N/A KPIs, eval donut "—" with "Worker unavailable.", "No runs in flight", "No clarifications pending", "Run history coming soon", workflows table with "—" cells. No crash.

- [ ] **Step 5: Confirm non-Overview screens unchanged**

Navigate to Runs, Trace, Prompts, Evals, Cost, Pre-sandbox, Post-PR.
Expected: all render from the `AIWF_DATA` mock exactly as before.

---

## Acceptance criteria (from the design)

1. `npx tsc --noEmit` passes for both apps; worker `pnpm test` passes. (Tasks 3, 4, 5)
2. `@tanstack/react-query` (+ devtools), `app/providers.tsx`, `lib/api/overview.ts`, `lib/api/client.ts`, worker `cors.ts`, and `DASHBOARD_ORIGIN` are all gone. (Tasks 3, 4, 5)
3. The browser makes **zero** direct `/api/v1/*` calls when loading Overview; data arrives server-rendered. (Task 6)
4. Worker-down reload renders the Overview N/A/empty states without crashing. (Task 6)
5. Non-Overview screens are unchanged and still build. (Task 6)
