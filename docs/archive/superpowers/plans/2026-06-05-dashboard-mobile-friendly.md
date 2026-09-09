# Dashboard Mobile-Friendly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commits:** The repo owner stages and authors commits (standing preference). Treat each "Commit" step as a **checkpoint**: stage the listed files and pause for the owner unless they've explicitly told you to commit directly. Work happens on a feature branch, not `dev`.

> **Verification model:** `apps/dashboard` has **no unit-test harness** (pure UI). Verification is **browser-based** via the agent-browser against the running dev server at widths **390px (phone), 768px (tablet), 1024px (desktop)**. Each task's verification step is a concrete browser check, not a unit test.

**Goal:** Make the entire dashboard usable on phones and tablets — including full touch authoring in the flow editor — without changing desktop (`≥ lg`) behavior.

**Architecture:** Phones-first responsive layering on the existing Next 15 / React 19 / Tailwind v4 cockpit. Mobile screen *presentation* is forked into `components/cockpit/mobile/` (approach B) while the data layer, types, and atomic primitives stay shared. Desktop vs. mobile is chosen by **CSS visibility** (`hidden lg:block` / `lg:hidden`) so data is fetched once and there is no hydration flash. The flow editor is migrated **in place** to Pointer Events (forking 1000+ lines would be wrong) with touch affordances gated at runtime.

**Tech Stack:** Next.js App Router, React 19, Tailwind CSS v4 (default breakpoints: `md` 768px, `lg` 1024px), TypeScript, Pointer Events API, `useSyncExternalStore` for SSR-safe `matchMedia`.

---

## Breakpoint contract (applies to every task)

- **`< lg` (< 1024px) = "mobile chrome"**: bottom tab bar + compact header, no sidebar, no activity drawer.
- **`md`–`lg` (768–1024px) = tablet content**: 2-column grids; chrome is still mobile (tab bar). (Per spec the tablet *content* loosens but chrome stays bottom-tab below `lg`. The desktop sidebar/drawer appear only at `≥ lg`.)
- **`≥ lg` = desktop**: current cockpit, untouched.
- Mobile screen variants render inside `lg:hidden`; desktop variants inside `hidden lg:block`.

## File structure

**Create:**
- `apps/dashboard/lib/use-media-query.ts` — SSR-safe `matchMedia` hook (editor runtime branching only).
- `apps/dashboard/components/cockpit/mobile/mobile-sheet.tsx` — shared bottom-sheet primitive.
- `apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx` — 4-slot nav.
- `apps/dashboard/components/cockpit/mobile/mobile-header.tsx` — compact top header.
- `apps/dashboard/components/cockpit/mobile/more-sheet.tsx` — "More" menu (Prompts/Evals/Cost).
- `apps/dashboard/components/cockpit/mobile/screens/overview-mobile.tsx`
- `apps/dashboard/components/cockpit/mobile/screens/runs-mobile.tsx`
- `apps/dashboard/components/cockpit/mobile/screens/cost-mobile.tsx`
- `apps/dashboard/components/cockpit/mobile/screens/evals-mobile.tsx`
- `apps/dashboard/components/cockpit/mobile/screens/prompts-mobile.tsx`
- `apps/dashboard/components/cockpit/mobile/screens/trace-mobile.tsx`

**Modify:**
- `apps/dashboard/app/(cockpit)/cockpit-shell.tsx` — gate desktop chrome to `lg`, add mobile chrome.
- `apps/dashboard/app/overview-data.tsx`, `runs-data.tsx`, `trace-data.tsx` — render desktop+mobile variants.
- `apps/dashboard/app/(cockpit)/prompts/page.tsx`, `evals/page.tsx`, `cost/page.tsx` — render desktop+mobile variants.
- `apps/dashboard/components/cockpit/screens/flow-editor.tsx` — Pointer Events + touch authoring.

---

## Phase 0 — Foundation

### Task 1: SSR-safe media-query hook

**Files:**
- Create: `apps/dashboard/lib/use-media-query.ts`

- [ ] **Step 1: Create the hook**

```ts
// apps/dashboard/lib/use-media-query.ts
"use client";

import { useSyncExternalStore } from "react";

/**
 * SSR-safe media-query hook. Returns `false` during SSR and first paint, then
 * the real match after hydration — no layout thrash because we only use it for
 * runtime branching (e.g. the editor's touch affordances), never for the
 * desktop/mobile *layout* split (that's CSS `lg:` visibility).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (cb: () => void) => {
    if (typeof window === "undefined") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  };
  const getSnapshot = () =>
    typeof window !== "undefined" && window.matchMedia(query).matches;
  const getServerSnapshot = () => false;
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True below the `lg` breakpoint (1024px) — i.e. mobile/tablet chrome band. */
export function useIsMobileViewport(): boolean {
  return useMediaQuery("(max-width: 1023px)");
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd apps/dashboard && pnpm exec tsc --noEmit`
Expected: no errors referencing `use-media-query.ts`.

- [ ] **Step 3: Commit (checkpoint)**

```bash
git add apps/dashboard/lib/use-media-query.ts
git commit -m "feat(dashboard): add SSR-safe useMediaQuery hook"
```

---

### Task 2: Shared bottom-sheet primitive

**Files:**
- Create: `apps/dashboard/components/cockpit/mobile/mobile-sheet.tsx`

Reuses the activity-drawer's scrim + `animate-ck-slide` language, re-oriented to slide up from the bottom.

- [ ] **Step 1: Add a slide-up keyframe**

Modify `apps/dashboard/app/globals.css` — add next to the existing `@keyframes ck-slide`:

```css
@keyframes ck-slide-up {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}
```

And register the utility inside the existing `@theme` block, beside `--animate-ck-slide`:

```css
  --animate-ck-slide-up: ck-slide-up 280ms cubic-bezier(0.2, 0, 0, 1);
```

- [ ] **Step 2: Create the sheet component**

```tsx
// apps/dashboard/components/cockpit/mobile/mobile-sheet.tsx
"use client";

import { useEffect } from "react";

export function MobileSheet({
  open,
  onClose,
  title,
  children,
  /** Tailwind max-height class for the sheet body; defaults to ~75vh. */
  heightClass = "max-h-[75vh]",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  heightClass?: string;
}) {
  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-[rgba(24,27,32,0.16)] z-[60]"
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed left-0 right-0 bottom-0 z-[61] bg-panel border-t border-neutral-200 rounded-t-[16px] shadow-[0_-6px_24px_rgba(24,27,32,0.12)] flex flex-col ${heightClass} animate-ck-slide-up`}
      >
        <div className="flex-[0_0_auto] pt-2 pb-1 flex justify-center">
          <span className="w-9 h-1 rounded-full bg-neutral-300" aria-hidden />
        </div>
        {title && (
          <div className="flex-[0_0_auto] px-[18px] pb-2.5 pt-1 flex items-center justify-between border-b border-neutral-200">
            <span className="font-mono text-[10px] text-neutral-700 tracking-[0.08em] uppercase">{title}</span>
            <button
              onClick={onClose}
              aria-label="Close"
              className="appearance-none border border-neutral-200 bg-panel w-7 h-7 rounded-[3px] cursor-pointer font-mono text-sm text-neutral-700"
            >×</button>
          </div>
        )}
        <div className="flex-1 overflow-auto overscroll-contain">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify type-check**

Run: `cd apps/dashboard && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/mobile/mobile-sheet.tsx apps/dashboard/app/globals.css
git commit -m "feat(dashboard): add MobileSheet bottom-sheet primitive"
```

---

## Phase 1 — Mobile shell & navigation

### Task 3: Bottom tab bar + mobile header + More sheet

**Files:**
- Create: `apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx`
- Create: `apps/dashboard/components/cockpit/mobile/more-sheet.tsx`
- Create: `apps/dashboard/components/cockpit/mobile/mobile-header.tsx`

- [ ] **Step 1: Create the bottom tab bar**

4 primary slots + More. Glyphs/labels mirror the existing `NAV` in `chrome.tsx`. Active state matches the sidebar (mariner).

```tsx
// apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx
"use client";

const TABS = [
  { id: "overview", label: "Overview", glyph: "◇" },
  { id: "runs",     label: "Runs",     glyph: "≡" },
  { id: "editor",   label: "Editor",   glyph: "▷" },
] as const;

export function BottomTabBar({
  active,
  onNav,
  onOpenMore,
  moreActive,
}: {
  active: string;
  onNav: (id: string) => void;
  onOpenMore: () => void;
  moreActive: boolean;
}) {
  const cell = (on: boolean) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 py-2 appearance-none bg-transparent border-none cursor-pointer ${
      on ? "text-mariner" : "text-neutral-600"
    }`;
  return (
    <nav className="flex-[0_0_auto] bg-panel border-t border-neutral-200 flex items-stretch pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tHere) => {
        const on = active === tHere.id;
        return (
          <button key={tHere.id} onClick={() => onNav(tHere.id)} aria-label={tHere.label} aria-current={on} className={cell(on)}>
            <span className="font-mono text-lg leading-none">{tHere.glyph}</span>
            <span className="font-mono text-[9px] tracking-[0.02em]">{tHere.label}</span>
          </button>
        );
      })}
      <button onClick={onOpenMore} aria-label="More" aria-current={moreActive} className={cell(moreActive)}>
        <span className="font-mono text-lg leading-none">⋯</span>
        <span className="font-mono text-[9px] tracking-[0.02em]">More</span>
      </button>
    </nav>
  );
}
```

- [ ] **Step 2: Create the More sheet**

Lists the secondary screens. Uses `MobileSheet`.

```tsx
// apps/dashboard/components/cockpit/mobile/more-sheet.tsx
"use client";

import { MobileSheet } from "./mobile-sheet";

const MORE = [
  { id: "prompts", label: "Prompts",     glyph: "❡" },
  { id: "evals",   label: "Arthur evals", glyph: "✓" },
  { id: "cost",    label: "Cost & usage", glyph: "$" },
] as const;

export function MoreSheet({
  open,
  onClose,
  active,
  onNav,
}: {
  open: boolean;
  onClose: () => void;
  active: string;
  onNav: (id: string) => void;
}) {
  return (
    <MobileSheet open={open} onClose={onClose} title="More" heightClass="max-h-[60vh]">
      <div className="flex flex-col py-1">
        {MORE.map((m) => {
          const on = active === m.id;
          return (
            <button
              key={m.id}
              onClick={() => { onNav(m.id); onClose(); }}
              className={`appearance-none text-left border-none cursor-pointer flex items-center gap-3 px-[18px] py-3.5 font-body text-[15px] ${
                on ? "bg-[#ECECFD] text-mariner font-semibold" : "bg-transparent text-neutral-900"
              }`}
            >
              <span className={`font-mono text-lg leading-none ${on ? "text-mariner" : "text-neutral-700"}`}>{m.glyph}</span>
              {m.label}
            </button>
          );
        })}
      </div>
    </MobileSheet>
  );
}
```

- [ ] **Step 3: Create the mobile header**

```tsx
// apps/dashboard/components/cockpit/mobile/mobile-header.tsx
"use client";

import { BlazityLogo } from "@/components/ui";

export function MobileHeader({ title }: { title: string }) {
  return (
    <header className="flex-[0_0_auto] h-12 bg-panel border-b border-neutral-200 flex items-center gap-2 px-4">
      <BlazityLogo size={20} color="#FD6027" wordmarkColor="#181B20" showWord={false} />
      <span className="font-display font-medium text-[15px] text-coal">{title}</span>
      <span className="ml-auto font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">/ AI Workflow</span>
    </header>
  );
}
```

- [ ] **Step 4: Verify type-check**

Run: `cd apps/dashboard && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx apps/dashboard/components/cockpit/mobile/more-sheet.tsx apps/dashboard/components/cockpit/mobile/mobile-header.tsx
git commit -m "feat(dashboard): add mobile nav chrome (tab bar, header, more sheet)"
```

---

### Task 4: Wire mobile chrome into the shell

**Files:**
- Modify: `apps/dashboard/app/(cockpit)/cockpit-shell.tsx`

The single shell renders desktop chrome at `≥ lg` and mobile chrome below it, both wrapping the **same** `{children}`. The screen content (table vs cards) is handled in Phase 2 inside the data/page components, so the scroll area is shared.

- [ ] **Step 1: Map screen id → human title (for the mobile header)**

Add near the top of `cockpit-shell.tsx`, after `screenForPath`:

```tsx
const TITLE_FOR_SCREEN: Record<string, string> = {
  overview: "Overview",
  runs: "Workflow runs",
  prompts: "Prompts",
  evals: "Arthur evals",
  cost: "Cost & usage",
  editor: "Workflow editor",
  trace: "Run trace",
};
```

- [ ] **Step 2: Add mobile state + imports**

Add imports:

```tsx
import { BottomTabBar } from "@/components/cockpit/mobile/bottom-tab-bar";
import { MobileHeader } from "@/components/cockpit/mobile/mobile-header";
import { MoreSheet } from "@/components/cockpit/mobile/more-sheet";
```

Add state inside `CockpitShell` (next to the other `useState`s):

```tsx
const [moreOpen, setMoreOpen] = useState(false);
const moreScreens = ["prompts", "evals", "cost"];
```

- [ ] **Step 3: Replace the returned JSX layout**

Replace the existing `<div className="h-screen w-screen flex overflow-hidden bg-app-bg relative">…</div>` block with this. Desktop chrome is gated to `lg`; a mobile column shows below `lg`.

```tsx
<div className="h-screen w-screen flex flex-col lg:flex-row overflow-hidden bg-app-bg relative">
  {/* Desktop sidebar — lg and up only */}
  <div className="hidden lg:flex">
    <CkSidebar
      active={screen}
      onNav={(id) => router.push(pathForScreen(id))}
      collapsed={!!t.sidebarCollapsed}
      onToggleCollapse={() => setTweak("sidebarCollapsed", !t.sidebarCollapsed)}
    />
  </div>

  <main className="flex-1 flex flex-col min-w-0 min-h-0">
    {/* Desktop topbar */}
    <div className="hidden lg:flex">
      <CkTopbar persona={persona} setPersona={setPersona} range={range} setRange={setRange} env={env} setEnv={setEnv} />
    </div>
    {/* Mobile header */}
    <div className="lg:hidden">
      <MobileHeader title={TITLE_FOR_SCREEN[screen] ?? "AI Workflow"} />
    </div>

    <div className="flex-1 overflow-auto min-h-0">{children}</div>

    {/* Mobile bottom tab bar */}
    <div className="lg:hidden">
      <BottomTabBar
        active={screen}
        moreActive={moreScreens.includes(screen)}
        onNav={(id) => router.push(pathForScreen(id))}
        onOpenMore={() => setMoreOpen(true)}
      />
    </div>
  </main>

  {/* Activity drawer — desktop only (removed on mobile by decision) */}
  <div className="hidden lg:block">
    <CkActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
  </div>

  {/* Mobile "More" menu */}
  <div className="lg:hidden">
    <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} active={screen} onNav={(id) => router.push(pathForScreen(id))} />
  </div>
</div>
```

- [ ] **Step 4: Start the dev server and verify chrome swaps**

Run: `cd apps/dashboard && pnpm dev` (note the local URL).
Then with the agent-browser:
- At **1024px**: sidebar + topbar visible, no tab bar.
- At **390px**: no sidebar; mobile header at top, 4-slot tab bar at bottom; tapping "More" opens a sheet listing Prompts/Evals/Cost; tapping a tab routes correctly; no horizontal scroll on the chrome.
- Confirm no console errors and no hydration warnings.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add "apps/dashboard/app/(cockpit)/cockpit-shell.tsx"
git commit -m "feat(dashboard): mobile shell chrome (tab bar + header) below lg"
```

---

## Phase 2 — Mobile screens

> Pattern for every screen: the existing desktop screen stays untouched; the data/page component renders **both** variants with CSS visibility:
> ```tsx
> <>
>   <div className="hidden lg:block"><XScreen … /></div>
>   <div className="lg:hidden"><XScreenMobile … /></div>
> </>
> ```
> Mobile screens reuse shared primitives from `@/components/ui` (`CkStatusPill`, `CkChip`, `CkKPI`, `TicketLink`, `PRLink`).

### Task 5: Runs — table → cards

**Files:**
- Create: `apps/dashboard/components/cockpit/mobile/screens/runs-mobile.tsx`
- Modify: `apps/dashboard/app/runs-data.tsx`

- [ ] **Step 1: Create the mobile runs screen**

```tsx
// apps/dashboard/components/cockpit/mobile/screens/runs-mobile.tsx
"use client";

import { useState } from "react";
import { CkStatusPill, CkChip, TicketLink, PRLink } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";
import type { RunsResponse } from "@shared/contracts";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "success", label: "Success" },
  { id: "running", label: "Running" },
  { id: "awaiting", label: "Awaiting input" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
];

export function RunsMobileScreen({ data }: { data: RunsResponse }) {
  const { openRun } = useCockpit();
  const [filter, setFilter] = useState("all");
  const rows = filter === "all" ? data.rows : data.rows.filter((r) => r.status === filter);

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-6">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Workflow runs</div>
        <h2 className="font-display text-xl font-medium text-neutral-900 m-0">{data.total} runs · 24h</h2>
      </div>

      {/* Horizontally scrollable filter chips */}
      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`flex-none appearance-none cursor-pointer px-3 py-1.5 rounded-[3px] border font-mono text-[11px] uppercase tracking-[0.04em] ${
              filter === f.id ? "bg-neutral-900 text-white border-neutral-900" : "bg-panel text-neutral-700 border-neutral-200"
            }`}
          >{f.label}</button>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <button
            key={r.id}
            onClick={() => openRun(r)}
            className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm p-3.5 active:bg-neutral-100"
          >
            <div className="flex items-center gap-2">
              <CkStatusPill status={r.status} />
              <span className="ml-auto font-mono text-[10px] text-neutral-500">{r.startedAtMin}m ago</span>
            </div>
            <div className="font-semibold text-neutral-900 text-[14px] mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap">{r.ticketTitle}</div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <TicketLink ticket={r.ticket} url={r.ticketUrl} />
              {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
              <CkChip>{r.workflowName}</CkChip>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3 pt-2.5 border-t border-neutral-200 font-mono">
              <Metric label="Dur" value={r.duration === null ? "—" : `${r.duration}s`} />
              <Metric label="Cost" value={r.cost === null ? "—" : `$${r.cost.toFixed(2)}`} />
              <Metric
                label="Eval"
                value={r.evalScore === null ? "—" : `${(r.evalScore * 100).toFixed(0)}`}
                tone={r.evalScore === null ? undefined : r.evalScore > 0.9 ? "ok" : r.evalScore > 0.85 ? "warn" : "fail"}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "fail" }) {
  const color = tone === "ok" ? "text-success-fg" : tone === "warn" ? "text-[#7A5A00]" : tone === "fail" ? "text-fail-fg" : "text-neutral-900";
  return (
    <div>
      <div className="text-[9px] text-neutral-500 tracking-[0.04em] uppercase">{label}</div>
      <div className={`text-[13px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Render both variants from `runs-data.tsx`**

Modify `apps/dashboard/app/runs-data.tsx`:

```tsx
// apps/dashboard/app/runs-data.tsx
import { getJSON } from "@/lib/api/server";
import { RunsScreen } from "@/components/cockpit/screens/runs";
import { RunsMobileScreen } from "@/components/cockpit/mobile/screens/runs-mobile";
import type { RunsResponse } from "@shared/contracts";
import { recentRunsFallback } from "@/lib/api/fallbacks";

export async function RunsData() {
  const now = new Date().toISOString();
  const data = await getJSON<RunsResponse>("/api/v1/runs").catch(() =>
    recentRunsFallback(now),
  );
  return (
    <>
      <div className="hidden lg:block"><RunsScreen data={data} /></div>
      <div className="lg:hidden"><RunsMobileScreen data={data} /></div>
    </>
  );
}
```

- [ ] **Step 3: Verify in browser**

At **390px** on `/runs`: cards stack, no horizontal page scroll, filter chips scroll horizontally, status pills/chips render, tapping a card navigates to `/trace/[id]`. At **1024px**: original table unchanged.

- [ ] **Step 4: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/mobile/screens/runs-mobile.tsx apps/dashboard/app/runs-data.tsx
git commit -m "feat(dashboard): mobile runs screen (cards)"
```

---

### Task 6: Overview — stacked

**Files:**
- Create: `apps/dashboard/components/cockpit/mobile/screens/overview-mobile.tsx`
- Modify: `apps/dashboard/app/overview-data.tsx`

The mobile overview shows: 2-col KPI grid, a throughput card, and a compact recent-runs list (reusing the runs card shape conceptually but inline + simpler). It consumes the same `OverviewScreenData`.

- [ ] **Step 1: Create the mobile overview screen**

```tsx
// apps/dashboard/components/cockpit/mobile/screens/overview-mobile.tsx
"use client";

import { CkKPI, CkStatusPill, TicketLink } from "@/components/ui";
import { Spark } from "@/components/charts";
import { useCockpit } from "@/components/cockpit/context";
import type { OverviewScreenData } from "@/components/cockpit/screens/overview";

export function OverviewMobileScreen({ data }: { data: OverviewScreenData }) {
  const { openRun } = useCockpit();
  const k = data.kpis;
  const recent = data.recentRuns.rows.slice(0, 6);

  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-6">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Last 24h</div>
        <h2 className="font-display text-xl font-medium text-neutral-900 m-0">Overview</h2>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <CkKPI label="Runs 24h" value={k.runs24h ?? "—"} />
        <CkKPI label="p95" value={k.p95 == null ? "—" : `${k.p95}s`} />
        <CkKPI label="Errors 24h" value={k.errors24h ?? "—"} />
        <CkKPI label="Cost 24h" value={k.cost24h == null ? "—" : `$${k.cost24h.toFixed(0)}`} />
      </div>

      <div className="bg-coal text-white rounded-sm p-4">
        <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-white/60 mb-2">Throughput</div>
        <Spark data={data.workflows.rows?.[0]?.spark ?? []} />
      </div>

      <div>
        <div className="font-mono text-[10px] tracking-[0.06em] uppercase text-neutral-500 mb-2">Recent runs</div>
        <div className="flex flex-col gap-2">
          {recent.map((r) => (
            <button
              key={r.id}
              onClick={() => openRun(r)}
              className="appearance-none text-left cursor-pointer bg-panel border border-neutral-200 rounded-sm px-3 py-2.5 flex items-center gap-2.5 active:bg-neutral-100"
            >
              <CkStatusPill status={r.status} />
              <span className="font-semibold text-[13px] text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap flex-1">{r.ticketTitle}</span>
              <TicketLink ticket={r.ticket} url={r.ticketUrl} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

> Note: confirm the exact prop names on `CkKPI` (`label`/`value`) and `Spark` (the data prop) against `components/ui.tsx` and `components/charts.tsx`; adjust to match. `Spark`'s input is the same series the desktop overview feeds it — read the desktop `OverviewScreen` for the exact shape and mirror it. If the `workflows` spark shape differs, pass the same series the desktop hero uses.

- [ ] **Step 2: Render both variants from `overview-data.tsx`**

In `apps/dashboard/app/overview-data.tsx`, add the import and replace the final `return`:

```tsx
import { OverviewMobileScreen } from "@/components/cockpit/mobile/screens/overview-mobile";
// …
  return (
    <>
      <div className="hidden lg:block"><OverviewScreen data={data} /></div>
      <div className="lg:hidden"><OverviewMobileScreen data={data} /></div>
    </>
  );
```

- [ ] **Step 3: Verify in browser**

At **390px** on `/`: KPIs in a 2-col grid (no slivers), throughput card readable, recent-runs list tappable → trace. No horizontal scroll. At **1024px**: original overview unchanged.

- [ ] **Step 4: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/mobile/screens/overview-mobile.tsx apps/dashboard/app/overview-data.tsx
git commit -m "feat(dashboard): mobile overview screen (stacked)"
```

---

### Task 7: Cost, Evals, Prompts — stacked

**Files:**
- Create: `apps/dashboard/components/cockpit/mobile/screens/cost-mobile.tsx`
- Create: `apps/dashboard/components/cockpit/mobile/screens/evals-mobile.tsx`
- Create: `apps/dashboard/components/cockpit/mobile/screens/prompts-mobile.tsx`
- Modify: `apps/dashboard/app/(cockpit)/cost/page.tsx`, `evals/page.tsx`, `prompts/page.tsx`

These three desktop screens use multi-column grids (`grid-cols-4`, `grid-cols-[1.5fr_1fr]`, `grid-cols-2`) with mock data and no props. The mobile variants reuse the **same content/sections** but force single/two-column layout. Because they take no props, the simplest faithful mobile variant re-renders the desktop screen's sub-sections in a 1-col container.

- [ ] **Step 1: Read each desktop screen and extract its sections**

Read `components/cockpit/screens/cost.tsx`, `evals.tsx`, `prompts.tsx`. Each is small (136/69/351 lines). Identify the top-level grid containers (e.g. cost.tsx:29 `grid-cols-4`, :36 `grid-cols-[1.5fr_1fr]`; evals.tsx:39 `grid-cols-2`; prompts.tsx:144 `grid-cols-4`).

- [ ] **Step 2: Create `cost-mobile.tsx`**

Mirror `CostScreen`'s sections but with mobile grids. Concretely: KPI row → `grid grid-cols-2 gap-2.5`; the `grid-cols-[1.5fr_1fr]` split → stacked `flex flex-col gap-3`; reduce horizontal padding from `px-6`→`px-4`. Reuse the exact inner cards/components from the desktop screen (extract any inner render helpers into shared functions if needed, or copy the JSX faithfully). Wrap in:

```tsx
// apps/dashboard/components/cockpit/mobile/screens/cost-mobile.tsx
"use client";
// import the same primitives/charts the desktop CostScreen uses
export function CostMobileScreen() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-6">
      {/* header (mono label + display title, mirror CostScreen) */}
      {/* KPI strip: grid grid-cols-2 gap-2.5 — same CkKPI/CkCard children as desktop */}
      {/* breakdown: flex flex-col gap-3 — same cards as the desktop grid-cols-[1.5fr_1fr] */}
    </div>
  );
}
```

Fill the comments with the actual JSX copied from `CostScreen`, swapping only the container grid classes for the mobile ones above. (No new data — identical mock content.)

- [ ] **Step 3: Create `evals-mobile.tsx`**

Same approach: `EvalsScreen`'s `grid-cols-2` (evals.tsx:39) → `grid-cols-1` on mobile; `px-6`→`px-4`. Copy the inner cards verbatim.

- [ ] **Step 4: Create `prompts-mobile.tsx`**

`PromptsScreen`'s `grid-cols-4` (prompts.tsx:144) → `grid-cols-1`; the filter/toolbar `flex-wrap` row already wraps — keep it. Make any fixed-width input (`w-[120px]`, prompts.tsx:43) `w-full` on mobile. Copy inner content verbatim, swapping container grids.

- [ ] **Step 5: Render both variants in each page**

For each of the three pages, e.g. `cost/page.tsx`:

```tsx
// apps/dashboard/app/(cockpit)/cost/page.tsx
import { CostScreen } from "@/components/cockpit/screens/cost";
import { CostMobileScreen } from "@/components/cockpit/mobile/screens/cost-mobile";

export default function CostPage() {
  return (
    <>
      <div className="hidden lg:block"><CostScreen /></div>
      <div className="lg:hidden"><CostMobileScreen /></div>
    </>
  );
}
```

Apply the identical pattern to `evals/page.tsx` (`EvalsScreen`/`EvalsMobileScreen`) and `prompts/page.tsx` (`PromptsScreen`/`PromptsMobileScreen`).

- [ ] **Step 6: Verify in browser**

At **390px** on `/cost`, `/evals`, `/prompts` (reach via the More sheet): single-column, no horizontal scroll, all content present and readable. At **768px**: 2-col where it makes sense. At **1024px**: originals unchanged.

- [ ] **Step 7: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/mobile/screens/cost-mobile.tsx apps/dashboard/components/cockpit/mobile/screens/evals-mobile.tsx apps/dashboard/components/cockpit/mobile/screens/prompts-mobile.tsx "apps/dashboard/app/(cockpit)/cost/page.tsx" "apps/dashboard/app/(cockpit)/evals/page.tsx" "apps/dashboard/app/(cockpit)/prompts/page.tsx"
git commit -m "feat(dashboard): mobile cost/evals/prompts screens (stacked)"
```

---

### Task 8: Trace — stacked + scrollable flame graph

**Files:**
- Create: `apps/dashboard/components/cockpit/mobile/screens/trace-mobile.tsx`
- Modify: `apps/dashboard/app/trace-data.tsx`

- [ ] **Step 1: Read `TraceScreen` and `flame-graph.tsx`**

Read `components/cockpit/screens/trace.tsx` (`TraceScreen({ runId, data })`) and `components/flame-graph.tsx` to learn the props and layout.

- [ ] **Step 2: Create the mobile trace screen**

Reuse `TraceScreen`'s sections but: stack metadata into a single column (`flex flex-col gap-3`, `px-4`), and wrap the flame graph in a horizontally scrollable container so wide spans don't crush:

```tsx
// apps/dashboard/components/cockpit/mobile/screens/trace-mobile.tsx
"use client";
import { FlameGraph } from "@/components/flame-graph"; // confirm export name
import type { RunDetailResponse } from "@shared/contracts";

export function TraceMobileScreen({ runId, data }: { runId: string; data: RunDetailResponse }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-6">
      {/* header: run id + status (mirror TraceScreen) */}
      {/* metadata: flex flex-col gap-3 instead of desktop multi-col */}
      <div className="overflow-x-auto -mx-4 px-4">
        <div className="min-w-[640px]">
          {/* <FlameGraph …same props TraceScreen passes… /> */}
        </div>
      </div>
      {/* steps list: reuse desktop step rows, single column */}
    </div>
  );
}
```

Fill the comments by copying the corresponding JSX from `TraceScreen`, keeping the same child components and props; only the containers change to single-column + the flame-graph scroll wrapper.

- [ ] **Step 3: Render both variants from `trace-data.tsx`**

```tsx
import { TraceMobileScreen } from "@/components/cockpit/mobile/screens/trace-mobile";
// …
  return (
    <>
      <div className="hidden lg:block"><TraceScreen runId={runId} data={data} /></div>
      <div className="lg:hidden"><TraceMobileScreen runId={runId} data={data} /></div>
    </>
  );
```

- [ ] **Step 4: Verify in browser**

Open a run from `/runs` at **390px**: metadata stacks, flame graph scrolls horizontally (with pinch working via the browser), no page-level horizontal scroll. At **1024px**: original trace unchanged.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/mobile/screens/trace-mobile.tsx apps/dashboard/app/trace-data.tsx
git commit -m "feat(dashboard): mobile trace screen (stacked + scrollable flame graph)"
```

---

## Phase 3 — Editor touch authoring (in place)

> The editor is migrated in place (not forked). All changes are in `components/cockpit/screens/flow-editor.tsx`. Desktop behavior must be preserved: mouse drag, HTML5 palette drag-and-drop, ctrl+wheel zoom, and drag-to-connect all keep working.

### Task 9: Migrate canvas + nodes from Mouse to Pointer events

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/flow-editor.tsx`

- [ ] **Step 1: Swap the handler types and names on `FlowCanvas`**

In `FlowCanvas`'s root `<div>`, rename: `onMouseDown`→`onPointerDown`, `onMouseMove`→`onPointerMove`, `onMouseUp`→`onPointerUp`, `onMouseLeave`→`onPointerLeave`. Change handler signatures from `React.MouseEvent` to `React.PointerEvent`. `clientX/clientY` exist on both, so the math is unchanged.

- [ ] **Step 2: Capture the pointer during drags**

In `startNodeDrag` and `startPanDrag`, add `e.currentTarget.setPointerCapture?.(e.pointerId)` so a drag that leaves the element still tracks. Store `pointerId` in `DragState`:

```tsx
interface DragState { kind: "node" | "pan"; id?: string; ox: number; oy: number; startX: number; startY: number; pointerId?: number; }
```

Set `pointerId: e.pointerId` in both `setDrag(...)` calls.

- [ ] **Step 3: Update `FlowNode` and ports**

In `FlowNode`: `onMouseDown`→`onPointerDown` (node drag), ports `onMouseDown`→`onPointerDown` / `onMouseUp`→`onPointerUp`. Update the prop types in `FlowNode`'s signature and the `onDragStart`/`onPortDown`/`onPortUp` types from `React.MouseEvent` to `React.PointerEvent`.

- [ ] **Step 4: Verify desktop is unbroken**

At **1024px** in browser: drag a node, pan the canvas, drag from an output port to an input port to connect, ctrl+wheel zoom, click to select — all behave exactly as before. No console errors.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/screens/flow-editor.tsx
git commit -m "refactor(dashboard): migrate flow editor to pointer events"
```

---

### Task 10: Pinch-zoom + two-finger pan

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/flow-editor.tsx`

- [ ] **Step 1: Track active pointers**

In `FlowCanvas`, add a ref map and helpers:

```tsx
const pointers = useRef<Map<number, Point>>(new Map());
const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
```

- [ ] **Step 2: Maintain the map in pointer handlers**

In `onPointerDown` (the canvas root), before existing logic: `pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });`. In `onPointerUp`/`onPointerLeave`/cancel: `pointers.current.delete(e.pointerId); pinch.current = null;`.

- [ ] **Step 3: Handle the two-pointer gesture in `onPointerMove`**

At the top of `onPointerMove`, before the single-pointer drag logic, intercept when two pointers are down (touch pinch/pan). This mirrors the existing wheel-zoom math (anchored scaling) but anchors at the gesture centroid:

```tsx
if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
if (pointers.current.size === 2) {
  const [a, b] = Array.from(pointers.current.values());
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rect = containerRef.current?.getBoundingClientRect();
  const lx = cx - (rect?.left ?? 0), ly = cy - (rect?.top ?? 0);
  if (pinch.current) {
    // Zoom by distance ratio, anchored at centroid; pan by centroid delta.
    const ratio = dist / (pinch.current.dist || dist);
    setZoom((z) => {
      const nz = Math.max(0.4, Math.min(1.4, z * ratio));
      setPan((p) => ({ x: lx - (lx - p.x) * (nz / z), y: ly - (ly - p.y) * (nz / z) }));
      return nz;
    });
    setPan((p) => ({ x: p.x + (cx - pinch.current!.cx), y: p.y + (cy - pinch.current!.cy) }));
  }
  pinch.current = { dist, cx, cy };
  return; // don't also run node/pan drag
}
```

> Implementation note: the nested `setPan` inside `setZoom` reads the pre-update `z`; keep the anchored-scale formula identical to the existing wheel handler (`flow-editor.tsx:517-526`) for consistent feel. If batching causes jitter, refactor to compute `nz` from `viewRef.current.zoom` and call `setPan`/`setZoom` once each — `viewRef` already mirrors live pan/zoom (`flow-editor.tsx:477-478`).

- [ ] **Step 4: Verify on touch**

In the agent-browser at **390px** on `/editor`: two-finger pinch zooms the canvas (anchored under the fingers), two-finger drag pans, the zoom % overlay updates. Single-finger still drags nodes / pans. At **1024px**: ctrl+wheel zoom still works.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/screens/flow-editor.tsx
git commit -m "feat(dashboard): pinch-zoom and two-finger pan in flow editor"
```

---

### Task 11: Palette as a ＋ FAB + bottom sheet (touch)

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/flow-editor.tsx`

- [ ] **Step 1: Add the mobile branch to `FlowEditor`**

Import the hook and sheet:

```tsx
import { useIsMobileViewport } from "@/lib/use-media-query";
import { MobileSheet } from "@/components/cockpit/mobile/mobile-sheet";
```

In `FlowEditor`, add `const isMobile = useIsMobileViewport();` and `const [paletteOpen, setPaletteOpen] = useState(false);`.

- [ ] **Step 2: Hide the desktop palette rail on mobile, show a FAB**

In `FlowEditor`'s body, wrap `<NodePalette … />` so it only shows on desktop:

```tsx
{!isMobile && <NodePalette onAdd={addNode} />}
```

Add a FAB inside the editor container (positioned bottom-right, above the tab bar) shown only on mobile:

```tsx
{isMobile && (
  <button
    onClick={() => setPaletteOpen(true)}
    aria-label="Add step"
    className="fixed right-4 bottom-[72px] z-40 w-12 h-12 rounded-full bg-mariner text-white text-2xl leading-none shadow-[0_3px_10px_rgba(24,27,32,0.25)] flex items-center justify-center"
  >＋</button>
)}
```

- [ ] **Step 3: Render the palette inside a sheet on mobile**

```tsx
{isMobile && (
  <MobileSheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Add step" heightClass="max-h-[60vh]">
    <div className="flex flex-col py-1">
      {/* reuse PALETTE_ITEMS; tapping adds at canvas center via addNode(item) */}
    </div>
  </MobileSheet>
)}
```

Fill the body by mapping `PALETTE_ITEMS` (already defined in the file) to tap rows that call `addNode(item)` then `setPaletteOpen(false)`. Reuse the category color/glyph styling from `NodePalette`. `addNode` with no `at` already spawns to the right of the rightmost node and selects it (`flow-editor.tsx:946-953`).

- [ ] **Step 4: Verify**

At **390px** on `/editor`: no left palette rail; a ＋ FAB opens a sheet; tapping an item adds a node and selects it; the sheet closes. At **1024px**: the palette rail is present and HTML5 drag-and-drop still works; no FAB.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/screens/flow-editor.tsx
git commit -m "feat(dashboard): touch palette (FAB + sheet) in flow editor"
```

---

### Task 12: Tap-to-connect on touch

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/flow-editor.tsx`

On touch, dragging a wire is replaced by tap-source-port → tap-target-port. Desktop keeps drag-to-connect.

- [ ] **Step 1: Branch port handlers on pointer type**

In `FlowCanvas`, change `onPortDown` so that for touch it toggles a persistent connect state instead of starting a drag:

```tsx
const onPortDown = (e: React.PointerEvent, nodeId: string, portIdx: number) => {
  e.stopPropagation();
  if (e.pointerType === "touch") {
    // Tap-to-connect: first tap arms the source; the matching input-port tap completes.
    setConnect({ from: nodeId, fromPort: portIdx, cursor: toCanvas(e.clientX, e.clientY) });
    return;
  }
  setConnect({ from: nodeId, fromPort: portIdx, cursor: toCanvas(e.clientX, e.clientY) });
};
```

- [ ] **Step 2: Complete on input-port tap; don't cancel on touch pointerup**

`onPortUp` already completes the connection (`if (connect && connect.from !== nodeId) onAddEdge(...)`). The problem is the canvas `onPointerUp` clears `connect` on every release. Guard it for touch so an armed connection survives between taps:

```tsx
const onPointerUp = (e: React.PointerEvent) => {
  pointers.current.delete(e.pointerId); pinch.current = null;
  setDrag(null);
  // On touch, keep an armed connection alive until the user taps a target
  // input port or empty canvas; on mouse, releasing ends the drag-connect.
  if (e.pointerType !== "touch") setConnect(null);
};
```

Add an explicit cancel when tapping empty canvas on touch — in `startPanDrag`, if `e.pointerType === "touch" && connect` then `setConnect(null)` and return early (don't start a pan that frame).

- [ ] **Step 3: Make the armed source port visually obvious**

When `connect` is set, render a highlight ring on the source node's output port (e.g. add a `ring`/scale class in `FlowNode` when `connect?.from === node.id`). Pass a `connectingPort?: number | null` prop into `FlowNode` from `FlowCanvas`.

- [ ] **Step 4: Verify**

At **390px** on `/editor`: tap an output port (it highlights), tap another node's input port → an edge is created; tapping empty canvas cancels the armed state. At **1024px**: drag-to-connect still works and a normal click doesn't leave a dangling armed state.

- [ ] **Step 5: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/screens/flow-editor.tsx
git commit -m "feat(dashboard): tap-to-connect ports on touch"
```

---

### Task 13: Node config as a bottom sheet on mobile

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/flow-editor.tsx`

- [ ] **Step 1: Render `NodeConfig` in a sheet on mobile**

In `FlowEditor`, replace the trailing `{selected && (<NodeConfig … />)}` with a responsive branch:

```tsx
{selected && !isMobile && (
  <NodeConfig node={selected} onChange={updateSelected} onDelete={deleteSelected} onClose={() => setSelectedId(null)} />
)}
{isMobile && (
  <MobileSheet open={!!selected} onClose={() => setSelectedId(null)} title={selected ? `${selected.type} · ${selected.name}` : ""} heightClass="max-h-[80vh]">
    {selected && (
      <NodeConfig node={selected} onChange={updateSelected} onDelete={deleteSelected} onClose={() => setSelectedId(null)} />
    )}
  </MobileSheet>
)}
```

> `NodeConfig` is an `<aside>` with fixed width (`w-80 flex-[0_0_320px]`) and its own border. Inside the sheet those are wrong. Add an optional `embedded?: boolean` prop to `NodeConfig`; when true, drop the `w-80 flex-[0_0_320px] border-l` classes and the outer `<aside>` chrome (render a plain `<div className="flex flex-col">`). Pass `embedded` from the mobile branch. This keeps one config implementation for both layouts.

- [ ] **Step 2: Verify**

At **390px** on `/editor`: tapping a node opens a config bottom sheet with params, the step-code editor (textarea usable), and the delete/duplicate/test buttons; closing it deselects. At **1024px**: the 320px right rail is unchanged.

- [ ] **Step 3: Commit (checkpoint)**

```bash
git add apps/dashboard/components/cockpit/screens/flow-editor.tsx
git commit -m "feat(dashboard): node config as bottom sheet on mobile"
```

---

## Phase 4 — Full verification

### Task 14: End-to-end responsive sweep

**Files:** none (verification only).

- [ ] **Step 1: Build to catch type/compile errors**

Run: `cd apps/dashboard && pnpm exec tsc --noEmit && pnpm build`
Expected: clean type-check and successful build.

- [ ] **Step 2: Sweep every screen at all three widths**

With the dev server running, use the agent-browser to check **390 / 768 / 1024px** on: `/`, `/runs`, a `/trace/[id]`, `/prompts`, `/evals`, `/cost`, `/editor`. For each:
- No horizontal page scroll at 390/768.
- Correct chrome: tab bar + header below `lg`; sidebar + topbar + activity drawer at `lg`.
- Content readable; no crushed/sliver tiles; tables rendered as cards on mobile.

- [ ] **Step 3: Editor touch flows at 390px**

Add node via FAB sheet → tap-to-connect two nodes → drag a node → pinch-zoom → two-finger pan → open config sheet and edit a field → delete a node. All work without console errors.

- [ ] **Step 4: Desktop regression at 1024px**

Sidebar collapse toggle, activity drawer open/close, runs table, editor drag-connect + HTML5 palette drag + ctrl+wheel zoom — all unchanged from before this work.

- [ ] **Step 5: Final commit (checkpoint)**

```bash
git add -A
git commit -m "test(dashboard): verified responsive sweep across breakpoints"
```

---

## Self-review (completed against the spec)

- **Breakpoint strategy** → Tasks 1, 4 (CSS visibility + `useMediaQuery` for editor runtime branching). ✓
- **SSR-safe switching** → Task 4 (CSS `lg:` visibility, fetch once). ✓
- **Separate mobile components, shared logic** → Phase 2 (mobile screens reuse shared primitives + shared `*-data.tsx` fetch). ✓
- **4-slot bottom tab bar (Overview/Runs/Editor/More) + More sheet** → Tasks 3, 4. ✓
- **Activity stream removed on mobile** → Task 4 (drawer wrapped `hidden lg:block`; no mobile activity surface). ✓
- **Per-screen reflow (overview/cost/evals/prompts/runs/trace)** → Tasks 5–8. ✓
- **Editor full touch authoring (pointer events, pinch/pan, FAB palette, tap-to-connect, config sheet)** → Tasks 9–13. ✓
- **Verification at 390/768/1024 + desktop regression** → Task 14. ✓
- **Out of scope respected** (no new tokens/fonts, no data/API changes, desktop untouched) → enforced by reusing primitives and gating all desktop chrome behind `lg`. ✓

**Type consistency:** `DragState.pointerId` added in Task 9 and used in Task 10; `connect`/`onPortDown`/`onPortUp` signatures changed to `React.PointerEvent` consistently across Tasks 9/12; `NodeConfig` gains `embedded?: boolean` in Task 13 (single implementation). `useIsMobileViewport` defined in Task 1, consumed in Tasks 11/13.

**Known follow-ups (not blocking):** confirm exact `CkKPI`/`Spark`/`FlameGraph` prop names while implementing Tasks 6/8 (flagged inline); dual-DOM cost from CSS-visibility split is accepted per spec.
