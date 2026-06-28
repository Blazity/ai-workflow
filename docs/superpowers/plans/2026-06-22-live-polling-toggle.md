# Live Polling Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a navbar toggle that, when on, auto-refreshes the dashboard's current screen every 5s for near-real-time data.

**Architecture:** The dashboard is fully server-rendered (RSC) with `cache: "no-store"`, so "polling" = calling Next's `router.refresh()` on an interval — it re-runs the active screen's server components and streams fresh data in place, with no data-layer changes. The interval/visibility logic lives in a pure, DOM-free controller (`lib/live-poll.ts`) that's unit-tested with `node:test`; a thin React hook (`lib/use-live-poll.ts`) wires `document` + `router.refresh()` into it; the on/off state is one new `useTweaks` field persisted to localStorage; the toggle UI sits in the desktop sidebar (`CkSidebar`).

**Tech Stack:** Next.js 15 (App Router, RSC), React 19, TypeScript, Tailwind v4, `node:test` (built-in, Node 24).

## Global Constraints

- **Working directory for all paths:** `apps/dashboard/` (the `ai-workflow-dashboard` workspace). Paths below are relative to it.
- **No new dependencies.** Tests use Node's built-in `node:test` + `mock.timers`. UI uses Tailwind's default palette (already available).
- **Poll cadence:** 5000ms, defined once as `LIVE_POLL_MS`.
- **Default state:** Off (`livePolling: false`).
- **Scope:** Toggle control lives only in the desktop sidebar (`hidden lg:flex`); the polling effect runs from `CockpitShell` regardless of viewport.
- **Surgical:** do not modify the pre-existing dashboard `.test.ts` files, do not add a `test` script to `apps/dashboard/package.json` (it would pull the pre-existing non-runnable tests into CI), do not refactor adjacent code.
- **Typecheck baseline is clean:** `cd apps/dashboard && npx tsc --noEmit` exits 0 before and must exit 0 after.

---

### Task 1: Pure polling controller (`lib/live-poll.ts`)

The interval + tab-visibility-pause logic, framework-free and `document`-free via injected dependencies so it unit-tests with `node:test` + `mock.timers` and no browser environment.

**Files:**
- Create: `lib/live-poll.ts`
- Test: `lib/live-poll.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface LivePollDeps { intervalMs: number; onTick: () => void; isHidden: () => boolean; subscribeVisibility: (cb: () => void) => () => void }`
  - `interface LivePoll { start: () => void; stop: () => void }`
  - `function createLivePoll(deps: LivePollDeps): LivePoll`

- [ ] **Step 1: Write the failing test**

Create `lib/live-poll.test.ts`:

```ts
// apps/dashboard/lib/live-poll.test.ts
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLivePoll } from "./live-poll.ts";

// Minimal fake visibility source so the controller runs without a DOM.
function makeVisibility(initialHidden = false) {
  let hidden = initialHidden;
  const subs = new Set<() => void>();
  return {
    isHidden: () => hidden,
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(next: boolean) {
      hidden = next;
      for (const cb of subs) cb();
    },
    subscriberCount: () => subs.size,
  };
}

function setup(initialHidden = false) {
  const vis = makeVisibility(initialHidden);
  let ticks = 0;
  const poll = createLivePoll({
    intervalMs: 5000,
    onTick: () => {
      ticks++;
    },
    isHidden: vis.isHidden,
    subscribeVisibility: vis.subscribe,
  });
  return { vis, poll, ticks: () => ticks };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setInterval"] });
});
afterEach(() => {
  mock.timers.reset();
});

test("ticks every interval while started and visible", () => {
  const { poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(ticks(), 2);
});

test("stop() clears the interval", () => {
  const { poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(5000);
  poll.stop();
  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(ticks(), 1);
});

test("started while hidden does not tick until visible", () => {
  const { poll, ticks } = setup(true);
  poll.start();
  mock.timers.tick(5000);
  assert.equal(ticks(), 0);
});

test("becoming visible fires once immediately then resumes interval", () => {
  const { vis, poll, ticks } = setup(true);
  poll.start();
  vis.set(false); // immediate tick on becoming visible
  assert.equal(ticks(), 1);
  mock.timers.tick(5000); // interval resumes
  assert.equal(ticks(), 2);
});

test("becoming hidden mid-run pauses ticks", () => {
  const { vis, poll, ticks } = setup(false);
  poll.start();
  mock.timers.tick(5000); // 1
  vis.set(true); // pause
  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(ticks(), 1);
});

test("after stop(), a later visibility change does not tick (unsubscribed)", () => {
  const { vis, poll, ticks } = setup(false);
  poll.start();
  poll.stop();
  assert.equal(vis.subscriberCount(), 0);
  vis.set(true);
  vis.set(false);
  mock.timers.tick(5000);
  assert.equal(ticks(), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/dashboard && node --test lib/live-poll.test.ts`
Expected: FAIL — `Cannot find module './live-poll.ts'` (the implementation does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/live-poll.ts`:

```ts
// apps/dashboard/lib/live-poll.ts
// Pure, DOM-free polling controller: owns the interval and the tab-visibility
// pause. `document` and React are injected (isHidden / subscribeVisibility) so
// this unit-tests with node:test + mock.timers and no browser environment.

export interface LivePollDeps {
  intervalMs: number;
  onTick: () => void;
  /** True when the tab is hidden; while hidden the interval is paused. */
  isHidden: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe fn. */
  subscribeVisibility: (cb: () => void) => () => void;
}

export interface LivePoll {
  start: () => void;
  stop: () => void;
}

export function createLivePoll(deps: LivePollDeps): LivePoll {
  const { intervalMs, onTick, isHidden, subscribeVisibility } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const startInterval = () => {
    if (timer === null) timer = setInterval(onTick, intervalMs);
  };
  const stopInterval = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const onVisibilityChange = () => {
    if (!started) return;
    if (isHidden()) {
      stopInterval();
    } else if (timer === null) {
      // Became visible while paused: refresh once now, then resume.
      onTick();
      startInterval();
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = subscribeVisibility(onVisibilityChange);
      if (!isHidden()) startInterval();
    },
    stop() {
      if (!started) return;
      started = false;
      stopInterval();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/dashboard && node --test lib/live-poll.test.ts`
Expected: PASS — `tests 6`, `pass 6`, `fail 0`.

- [ ] **Step 5: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/lib/live-poll.ts apps/dashboard/lib/live-poll.test.ts
git commit -m "feat(dashboard): add pure live-poll controller with tests"
```

---

### Task 2: React hook (`lib/use-live-poll.ts`)

Thin DOM/React adapter over `createLivePoll`: provides the real `document`-backed visibility deps, keeps `onTick` current via a ref, and maps `enabled` to start/stop. No automated test (no hook-test infra in this app — verified manually in Task 4).

**Files:**
- Create: `lib/use-live-poll.ts`

**Interfaces:**
- Consumes: `createLivePoll`, `LivePollDeps` from `./live-poll` (Task 1).
- Produces: `function useLivePoll(opts: { enabled: boolean; intervalMs: number; onTick: () => void }): void`

- [ ] **Step 1: Write the hook**

Create `lib/use-live-poll.ts`:

```ts
// apps/dashboard/lib/use-live-poll.ts
"use client";

import { useEffect, useRef } from "react";
import { createLivePoll } from "./live-poll";

/**
 * Calls `onTick` every `intervalMs` while `enabled`, pausing when the browser
 * tab is hidden (and firing once immediately when it becomes visible again).
 * Thin DOM/React adapter over the pure `createLivePoll` controller.
 */
export function useLivePoll({
  enabled,
  intervalMs,
  onTick,
}: {
  enabled: boolean;
  intervalMs: number;
  onTick: () => void;
}): void {
  // Keep the latest onTick without restarting the interval on its identity change.
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  useEffect(() => {
    if (!enabled) return;

    const poll = createLivePoll({
      intervalMs,
      onTick: () => onTickRef.current(),
      isHidden: () => document.visibilityState === "hidden",
      subscribeVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
    });
    poll.start();
    return () => poll.stop();
  }, [enabled, intervalMs]);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0, no errors. (The hook is not imported yet; an unused module is valid.)

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/lib/use-live-poll.ts
git commit -m "feat(dashboard): add useLivePoll hook"
```

---

### Task 3: Add `livePolling` tweak field

Add the on/off flag to the existing tweak system so it persists to localStorage and rides the existing SSR-safe hydration + `tweakchange` event for free.

**Files:**
- Modify: `components/cockpit/context.tsx`

**Interfaces:**
- Produces: `Tweaks.livePolling: boolean` (default `false`), readable as `t.livePolling`, settable via `setTweak("livePolling", boolean)`.

- [ ] **Step 1: Add the field to the `Tweaks` type**

In `components/cockpit/context.tsx`, inside the `Tweaks` type, after the `editorFlow` line (the last field), add:

```ts
  /** When on, the cockpit polls and refreshes the active screen's data. */
  livePolling: boolean;
```

- [ ] **Step 2: Add the default**

In the same file, in `TWEAK_DEFAULTS`, after the `editorFlow: "presandbox",` line, add:

```ts
  livePolling: false,
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/components/cockpit/context.tsx
git commit -m "feat(dashboard): add livePolling tweak field (default off)"
```

---

### Task 4: Wire polling + add navbar toggle

Wire `useLivePoll` into `CockpitShell` (driving `router.refresh()`), pass the live state/toggle down to `CkSidebar`, and render the footer "Live" toggle. Done as one task because the toggle is only meaningful with the wiring, and each file's change references the other's new props (splitting would break the typecheck between commits).

**Files:**
- Modify: `components/cockpit/chrome.tsx` (`CkSidebar`)
- Modify: `app/(cockpit)/cockpit-shell.tsx`

**Interfaces:**
- Consumes: `useLivePoll` (Task 2); `t.livePolling` / `setTweak` (Task 3).
- `CkSidebar` gains props: `live?: boolean`, `onToggleLive?: () => void`.

- [ ] **Step 1: Add props + footer toggle to `CkSidebar`**

In `components/cockpit/chrome.tsx`, extend the `CkSidebar` signature. Replace:

```ts
export function CkSidebar({
  active,
  onNav,
  collapsed = false,
  onToggleCollapse,
}: {
  active: string;
  onNav: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
```

with:

```ts
export function CkSidebar({
  active,
  onNav,
  collapsed = false,
  onToggleCollapse,
  live = false,
  onToggleLive,
}: {
  active: string;
  onNav: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  live?: boolean;
  onToggleLive?: () => void;
}) {
```

- [ ] **Step 2: Render the footer toggle**

In the same file, immediately before the closing `</aside>` tag (after the nav-groups `.map(...)` block), add the footer control. `mt-auto` pushes it to the bottom of the `flex flex-col` aside:

```tsx
      <div className="mt-auto px-2 pt-3">
        <button
          onClick={onToggleLive}
          title={
            live
              ? "Live updates on — click to pause"
              : "Live updates off — click to enable"
          }
          aria-label="Toggle live updates"
          aria-pressed={live}
          className={`w-full appearance-none border-none cursor-pointer flex items-center gap-[10px] py-[9px] rounded-[3px] font-body text-[13px] transition-all duration-[120ms] ease-[cubic-bezier(.2,0,0,1)] hover:bg-app-bg ${
            collapsed ? "px-0 justify-center" : "px-3"
          } ${live ? "text-emerald-700 font-semibold" : "text-neutral-700 font-medium"}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              live ? "bg-emerald-500 animate-pulse" : "bg-neutral-400"
            }`}
          />
          {!collapsed && (live ? "Live" : "Live off")}
        </button>
      </div>
```

- [ ] **Step 3: Wire `useLivePoll` and pass props in `CockpitShell`**

In `app/(cockpit)/cockpit-shell.tsx`:

(a) Add the hook import after the `runHref` import (around line 8):

```ts
import { useLivePoll } from "@/lib/use-live-poll";
```

(b) Add the cadence constant at module scope, just after the imports block (above the `pathForScreen` helper):

```ts
/** Live-mode poll cadence (ms). Single source of truth — tune here. */
const LIVE_POLL_MS = 5000;
```

(c) Inside `CockpitShell`, after the `openRun` definition and before the `return (`, add:

```ts
  useLivePoll({
    enabled: !!t.livePolling,
    intervalMs: LIVE_POLL_MS,
    onTick: () => router.refresh(),
  });
```

(d) Pass the two new props to the desktop `<CkSidebar>`. Replace:

```tsx
          <CkSidebar
            active={screen}
            onNav={(id) => router.push(pathForScreen(id))}
            collapsed={!!t.sidebarCollapsed}
            onToggleCollapse={() => setTweak("sidebarCollapsed", !t.sidebarCollapsed)}
          />
```

with:

```tsx
          <CkSidebar
            active={screen}
            onNav={(id) => router.push(pathForScreen(id))}
            collapsed={!!t.sidebarCollapsed}
            onToggleCollapse={() => setTweak("sidebarCollapsed", !t.sidebarCollapsed)}
            live={!!t.livePolling}
            onToggleLive={() => setTweak("livePolling", !t.livePolling)}
          />
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 5: Manual verification in the dev server**

Run: `pnpm dev:dashboard` (serves on http://localhost:3001).

Verify:
1. Sidebar bottom shows a gray dot + **"Live off"** on first load (default off).
2. Click it → label becomes **"Live"** with a pulsing **green** dot; in DevTools → Network, an RSC refresh request fires every ~5s.
3. Click again → returns to "Live off"; refresh requests stop.
4. With Live on, switch to another browser tab for ~15s, then return → no requests fired while hidden; one fires immediately on return, then every 5s.
5. Reload the page → toggle state persists (localStorage `aiwf:tweaks`).
6. Collapse the sidebar (chevron) → only the dot shows; hovering shows the state tooltip; toggle still works.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/components/cockpit/chrome.tsx apps/dashboard/app/\(cockpit\)/cockpit-shell.tsx
git commit -m "feat(dashboard): add live-polling navbar toggle"
```

---

## Self-Review

**Spec coverage:**
- Mechanism (`router.refresh()` on interval) → Task 4 step 3c. ✓
- State (`livePolling` tweak, default off, localStorage) → Task 3. ✓
- Pure controller `createLivePoll` (interval + visibility pause/resume) → Task 1. ✓
- Thin hook `useLivePoll` (document deps + onTick ref + enabled lifecycle) → Task 2. ✓
- Toggle UI in desktop sidebar (green pulse dot, "Live"/"Live off", aria-pressed, collapsed tooltip) → Task 4 steps 1–2. ✓
- 5s cadence as single constant `LIVE_POLL_MS` → Task 4 step 3b. ✓
- Scope: control desktop-only, effect viewport-agnostic → control in `CkSidebar` (`hidden lg:flex` parent), hook in `CockpitShell`. ✓
- Testing: `node:test` + `mock.timers`, no new deps, runnable via `node --test`; CI caveat noted → Task 1 + Global Constraints. ✓
- Error handling: `router.refresh()` failures absorbed by existing `*-data.tsx` `.catch` fallbacks → no code needed (spec). ✓

**Placeholder scan:** none — all code blocks are complete.

**Type consistency:** `createLivePoll` / `LivePollDeps` / `LivePoll` defined in Task 1 are consumed verbatim in Task 2; `useLivePoll`'s `{ enabled, intervalMs, onTick }` signature in Task 2 matches its call site in Task 4 step 3c; `live` / `onToggleLive` props defined in Task 4 step 1 match the call site in step 3d; `t.livePolling` / `setTweak("livePolling", …)` match the field added in Task 3.
