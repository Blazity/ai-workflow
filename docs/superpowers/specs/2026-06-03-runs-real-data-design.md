# `/runs` Real-Data Conversion — Design

**Date:** 2026-06-03
**Status:** Approved
**Scope:** Faithful swap — convert the existing `/runs` page from mock data to live worker data, mirroring the overview page's pattern. No new features.

## Problem

The `/runs` dashboard page (`apps/dashboard/app/(cockpit)/runs/page.tsx`) has a complete table UI but is wired to mock data (`AIWF_DATA` from `@/lib/data/mock`). The overview page already fetches real data from the worker. We want `/runs` to use the same real data source.

## Existing Pattern (overview, the template)

The overview page fetches real data through three layers:

1. `app/(cockpit)/page.tsx` — thin server route: `<Suspense fallback={<OverviewSkeleton/>}><OverviewData/></Suspense>`
2. `app/overview-data.tsx` — **server component**: calls `getJSON<T>(path)` (server-only fetch with `Bearer WORKER_API_TOKEN`, `cache: "no-store"`), `.catch()` to a fallback, passes `data` prop to the client screen.
3. `components/cockpit/screens/overview.tsx` — **client presenter**: receives `data`, pulls `openRun` from `useCockpit()`, renders. Untracked metrics arrive `null` and render as `—`.

The worker already exposes `GET /api/v1/runs` → `RunsResponse` (from `@shared/contracts`):

```ts
interface RunsResponse {
  generatedAt: string;
  available: boolean;
  rows: Run[];
  total: number;
  counts: {
    success: number;
    running: number;
    awaiting: number;
    failed: number;
    blocked: number;
  };
}
```

`recentRunsFallback(now)` already exists in `lib/api/fallbacks.ts` and returns `available: false` with empty `rows`.

## Changes

### 1. `app/(cockpit)/runs/page.tsx` (rewrite)
Becomes a thin server route, drops `"use client"`:

```tsx
import { Suspense } from "react";
import { RunsData } from "@/app/runs-data";
import { RunsSkeleton } from "@/app/runs-skeleton";

export default function RunsPage() {
  return (
    <Suspense fallback={<RunsSkeleton />}>
      <RunsData />
    </Suspense>
  );
}
```

The `useCockpit()`/`openRun` wiring that lived here moves into the screen component (matching how overview does it).

### 2. `app/runs-data.tsx` (new server component)

```tsx
import { getJSON } from "@/lib/api/server";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import type { RunsResponse } from "@shared/contracts";
import { recentRunsFallback } from "@/lib/api/fallbacks";

export async function RunsData() {
  const now = new Date().toISOString();
  const data = await getJSON<RunsResponse>("/api/v1/runs").catch(() =>
    recentRunsFallback(now),
  );
  return <RunsScreen data={data} />;
}
```

### 3. `components/cockpit/screens/runs.tsx` (modify)
- Change signature from `{ onOpenRun }: { onOpenRun: (run: Run) => void }` to `{ data }: { data: RunsResponse }`.
- Pull `openRun` from `useCockpit()` internally (matching overview).
- Replace `const D = AIWF_DATA` / `D.RUNS` usage with `data.rows`.
- Header count uses `data.total` instead of `D.RUNS.length`.
- Status filter logic unchanged (filters `data.rows` by `r.status`).
- Import `Run` / `RunsResponse` from `@shared/contracts` instead of mock `@/lib/types`.
- Table markup, status tabs, and the decorative `+ Filter` / `Export ↓` buttons are left **unchanged**. The existing `null → "—"` rendering already handles untracked metrics (`tokens`, `cost`, `evalScore`, `guardrailHits`).

### 4. `app/runs-skeleton.tsx` (new)
Loading fallback styled like `overview-skeleton.tsx`: header placeholder + table-shaped placeholder rows.

## Behavior

- **Happy path:** `/runs` renders real runs from the worker, matching what overview's "Recent runs" table shows. Untracked metrics show `—`.
- **Worker down / 401:** `getJSON` throws → `recentRunsFallback` returns `available: false`, empty `rows`. Table renders empty; header shows `0 runs`. No crash. Same silent-fallback behavior as overview.

## Out of Scope

- Per-status count badges on filter tabs.
- Pagination.
- Merging live/awaiting runs (`/api/v1/runs/live`).
- Wiring up the `+ Filter` / `Export ↓` buttons.

## Verification

1. Dashboard typecheck passes (`tsc` / `pnpm typecheck`).
2. `/runs` renders real runs consistent with overview's recent-runs table.
3. With the worker unreachable, `/runs` shows an empty table (header `0 runs`), not an error.
