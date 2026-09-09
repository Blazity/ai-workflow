# `/runs` Real-Data Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `/runs` dashboard page from mock data to live worker data, mirroring the overview page's server-component fetch pattern.

**Architecture:** Thin server route (`page.tsx`) wraps a server component (`runs-data.tsx`) in `<Suspense>`. The server component fetches `GET /api/v1/runs` via `getJSON`, falls back to an empty `RunsResponse` on failure, and passes the `data` prop to the client presenter `RunsScreen`, which pulls `openRun` from `useCockpit()`. Identical in shape to `overview-data.tsx` / `OverviewScreen`.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, `@shared/contracts` types. No test framework in this app — verification is `npx tsc --noEmit`, `next lint`, and a manual browser check.

**Spec:** `docs/superpowers/specs/2026-06-03-runs-real-data-design.md`

**Note on commits:** This repo's owner stages commits manually. Do NOT commit unless the user explicitly asks. The final task lists the commit command for when they do.

---

### Task 1: Add the loading skeleton

**Files:**
- Create: `apps/dashboard/app/runs-skeleton.tsx`

- [ ] **Step 1: Create the skeleton component**

Mirror `apps/dashboard/app/overview-skeleton.tsx` (header + a single table-shaped block, since `/runs` is one table):

```tsx
// apps/dashboard/app/runs-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function RunsSkeleton() {
  return (
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* Header (title + tabs/buttons) */}
      <div className="flex items-center justify-between">
        <Block className="h-10 w-48" />
        <Block className="h-8 w-80" />
      </div>
      {/* Runs table */}
      <Block className="h-[480px]" />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS (no new errors from this file).

---

### Task 2: Add the server data component

**Files:**
- Create: `apps/dashboard/app/runs-data.tsx`

- [ ] **Step 1: Create the server component**

Mirror `apps/dashboard/app/overview-data.tsx`, single fetch:

```tsx
// apps/dashboard/app/runs-data.tsx
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

> This will not typecheck until Task 3 changes `RunsScreen`'s signature to accept `data`. That is expected; the full typecheck gate is in Task 4.

---

### Task 3: Convert `RunsScreen` to consume real data

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/runs.tsx`

- [ ] **Step 1: Replace imports and signature**

Change the top of the file. Replace lines 1-12 (the `"use client"` block through the `filtered` declaration) with:

```tsx
"use client";

import React, { useState } from "react";
import { CkCard, CkChip, CkStatusPill, CkTabs, TicketLink, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { RunsResponse } from "@shared/contracts";

export function RunsScreen({ data }: { data: RunsResponse }) {
  const { openRun } = useCockpit();
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? data.rows : data.rows.filter((r) => r.status === filter);
```

What changed:
- Removed `import { AIWF_DATA } from "@/lib/data/mock"` and `import type { Run } from "@/lib/types"` and `const D = AIWF_DATA`.
- Added `useCockpit` + `RunsResponse` imports.
- Signature `{ onOpenRun }: { onOpenRun: (run: Run) => void }` → `{ data }: { data: RunsResponse }`.
- `openRun` now comes from context.
- `filtered` reads `data.rows` instead of `D.RUNS`.

- [ ] **Step 2: Update the header count**

On the `<h2>` line (was line 19), replace `{D.RUNS.length}` with `{data.total}`:

```tsx
          <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">{data.total} runs · last 24h</h2>
```

- [ ] **Step 3: Update the row click handler**

On the `<tr>` (was line 46), replace `onClick={() => onOpenRun(r)}` with `onClick={() => openRun(r)}`:

```tsx
              <tr key={r.id} onClick={() => openRun(r)} className={`cursor-pointer hover:bg-neutral-100 ${i < filtered.length - 1 ? "border-b border-neutral-200" : ""}`}>
```

- [ ] **Step 4: Verify nothing else references `D` or `onOpenRun`**

Run: `grep -nE "\bD\.|onOpenRun|AIWF_DATA" apps/dashboard/components/cockpit/screens/runs.tsx`
Expected: no matches.

All other rows (`r.ticketTitle`, `r.ticket`, `r.ticketUrl`, `r.prNumber`, `r.prUrl`, `r.id`, `r.workflowName`, `r.model`, `r.startedAtMin`, `r.duration`, `r.tokens`, `r.cost`, `r.evalScore`, `r.guardrailHits`) are fields on the `@shared/contracts` `Run` type and the existing `null → "—"` rendering already handles untracked metrics — no other edits needed.

---

### Task 4: Rewrite the route to the server pattern + verify

**Files:**
- Modify: `apps/dashboard/app/(cockpit)/runs/page.tsx`

- [ ] **Step 1: Replace the page with the Suspense + server-component pattern**

Full file contents (mirrors `app/(cockpit)/page.tsx`):

```tsx
// apps/dashboard/app/(cockpit)/runs/page.tsx — Workflow runs ("/runs")
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

What changed: dropped `"use client"`, the `useCockpit`/`openRun` wiring (now lives in `RunsScreen`), and the direct `<RunsScreen onOpenRun=... />` call.

- [ ] **Step 2: Typecheck the whole app**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Lint the changed files**

Run: `cd apps/dashboard && npx next lint --file app/runs-data.tsx --file app/runs-skeleton.tsx --file "app/(cockpit)/runs/page.tsx" --file components/cockpit/screens/runs.tsx`
Expected: no errors.

- [ ] **Step 4: Visual check**

Run: `cd apps/dashboard && pnpm dev` (port 3001), open `http://localhost:3001/runs`.
Expected:
- Real runs render in the table, matching the overview "Recent runs" table (untracked metrics show `—`).
- Header shows the real run total.
- Clicking a row navigates to `/trace` with that run active.
- With the worker unreachable (e.g. `WORKER_BASE_URL` unset), the table renders empty and the header shows `0 runs` — no crash.

- [ ] **Step 5: Commit (ONLY if the user asks)**

```bash
git add "apps/dashboard/app/(cockpit)/runs/page.tsx" apps/dashboard/app/runs-data.tsx apps/dashboard/app/runs-skeleton.tsx apps/dashboard/components/cockpit/screens/runs.tsx
git commit -m "feat: wire /runs to real worker data"
```

---

## Self-Review

**Spec coverage:**
- `page.tsx` server route → Task 4. ✓
- `runs-data.tsx` server component → Task 2. ✓
- `runs.tsx` screen swap (signature, `data.rows`, `data.total`, `useCockpit`, shared types) → Task 3. ✓
- `runs-skeleton.tsx` → Task 1. ✓
- Graceful `null → "—"` for untracked metrics → handled by existing markup, noted in Task 3 Step 4. ✓
- Worker-down empty state → `recentRunsFallback` in Task 2, verified in Task 4 Step 4. ✓
- Out-of-scope items (count badges, pagination, live merge, buttons) → not present in any task. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full. ✓

**Type consistency:** `RunsResponse` imported from `@shared/contracts` in both Task 2 and Task 3. `RunsScreen` accepts `{ data: RunsResponse }` (Task 3) — matches the call site in Task 2. `openRun(r)` takes a `Run` row from `data.rows`; overview already passes `RunsResponse.rows` into `openRun`, proving compatibility. `RunsSkeleton` (Task 1) matches the import in Task 4. ✓
