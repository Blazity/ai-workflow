# Live polling toggle — design

**Date:** 2026-06-22
**Status:** Approved (design); pending spec review → implementation plan

## Problem

The dashboard is fully server-rendered (RSC): each screen is an async server
component (`app/*-data.tsx`) that fetches the worker API via `getJSON`
(`cache: "no-store"`), so the data is only as fresh as the last full page render.
To see new runs/state the user has to manually reload. The user wants a
**polling-based "live" mode** that refreshes the data automatically, with a
**toggle to turn it on and off**, placed in the desktop top bar and mobile header
as the easiest-to-reach location for now.

## Chosen mechanism: `router.refresh()` on an interval

Because the data layer is RSC + `no-store`, the minimal correct mechanism is to
periodically call Next's `router.refresh()` from the client. That re-runs the
server component tree for whichever screen is mounted and streams fresh data
in-place — no flicker, scroll and client state preserved — and each refresh hits
the worker fresh. **No data-fetching code changes.**

Rejected alternatives:
- **Client-side SWR/polling per screen** — would require rewriting every screen
  from server-fetch to client-fetch. Large, invasive, contradicts "easiest".
- **SSE / WebSocket push** — true real-time but needs a streaming endpoint on the
  worker plus connection management. Overkill for now.

## Decisions (confirmed with user)

| Knob | Value |
| --- | --- |
| Interval | **5 seconds** (single named constant `LIVE_POLL_MS`, trivially tunable) |
| Default state | **Off** — user opts in |
| Scope | **Global** — refreshes whatever screen is currently viewed |

Note: 5s is more frequent than the underlying data changes (cron processes
tickets ~every 1 min), but running/streaming runs can update sub-minute and this
is a single-tenant per-client deployment, so the load is negligible.

## Architecture

Four small units. No new dependencies, no data-layer changes.

### 1. State — one new tweak field

Add `livePolling: boolean` to `Tweaks` (`components/cockpit/context.tsx`),
default `false` in `TWEAK_DEFAULTS`. It rides the existing `useTweaks`
machinery for free: localStorage persistence under `aiwf:tweaks`, the
known-keys merge (so it hydrates SSR-safely), and the `tweakchange` event.
No new persistence code.

### 2. Polling unit — split for testability

The dashboard has **no React-hook test infrastructure** (no jsdom /
testing-library; existing tests use `node:test` on pure functions). Adding a
hook-test stack for one tiny hook would be disproportionate. So the logic is
split into a pure, DOM-free controller (testable with `node:test`) and a thin
React adapter (untested glue, consistent with the repo not testing hooks).

#### 2a. `lib/live-poll.ts` (new) — pure controller

Framework-free and `document`-free via dependency injection, so it unit-tests
with Node's built-in `mock.timers` and no new packages:

```ts
export interface LivePollDeps {
  intervalMs: number;
  onTick: () => void;
  isHidden: () => boolean;                       // injected; hook reads document
  subscribeVisibility: (cb: () => void) => () => void; // returns unsubscribe
}
export function createLivePoll(deps: LivePollDeps): {
  start(): void;
  stop(): void;
};
```

Semantics:
- `start()`: idempotent; subscribes to visibility. If not hidden, begins the
  interval (first `onTick` at `+intervalMs`). If hidden, waits.
- On becoming **hidden**: clears the interval (pause).
- On becoming **visible** (while started, interval not running): fires `onTick`
  once immediately, then begins the interval.
- `stop()`: clears the interval, unsubscribes, marks not running.

#### 2b. `lib/use-live-poll.ts` (new) — thin React hook

```ts
useLivePoll({ enabled, intervalMs, onTick }: {
  enabled: boolean;
  intervalMs: number;
  onTick: () => void;
}): void
```

Provides the real `document`-backed `isHidden` (`document.visibilityState ===
"hidden"`) and `subscribeVisibility` (over the `visibilitychange` event), keeps
the latest `onTick` in a ref so identity changes don't reset the interval, and
maps `enabled` → `controller.start()` / `controller.stop()` (also stopping on
unmount).

### 3. Wiring — `app/(cockpit)/cockpit-shell.tsx`

`CockpitShell` already owns `useTweaks`, the `router`, and the context provider.
Add:

```ts
const LIVE_POLL_MS = 5000;
useLivePoll({
  enabled: !!t.livePolling,
  intervalMs: LIVE_POLL_MS,
  onTick: () => router.refresh(),
});
```

Expose `live` / `onToggleLive` through cockpit context so the top bar and mobile
header can render the same control (same pattern as the existing
shared cockpit state):

```ts
livePolling: !!t.livePolling,
toggleLive: () => setTweak("livePolling", !t.livePolling),
nextRefreshAt,
```

### 4. Toggle UI — `components/cockpit/controls.tsx` (`LivePollControl`)

A compact control rendered in the desktop top bar and mobile header:

- **On:** pulsing **green** dot + "Live" label.
- **Off:** static gray dot + "Live off" label.
- `aria-pressed`, `aria-label`, `title` tooltip, and a countdown ring while live.

## Scope / boundaries

- The **toggle control** lives in the desktop top bar and the mobile header
  — the "navbar, easiest" the user asked for.
- The **polling effect** lives in `CockpitShell`, so once enabled it refreshes
  regardless of viewport.
- The `CkTopbar` component in `chrome.tsx` is currently an empty shell and is not
  touched.

## Error handling

`router.refresh()` is fire-and-forget; transient worker failures are already
absorbed by each `*-data.tsx`'s `.catch(() => fallback())`, so a failed refresh
degrades to the documented fallback state rather than crashing. No extra
handling needed. Overlapping refreshes are not a concern at a 5s cadence with
Next's in-flight de-duplication.

## Testing

- **`lib/live-poll.test.ts` (new)** — `node:test` + `mock.timers`, zero new
  dependencies, run with `node --test lib/live-poll.test.ts` (Node 24 strips
  types natively; the test imports `./live-poll.ts` with an explicit extension).
  Cases:
  - ticks `onTick` every `intervalMs` while started and visible;
  - `stop()` clears the interval (no further ticks);
  - started while hidden → no ticks until visible;
  - becoming visible fires `onTick` once immediately, then resumes interval;
  - becoming hidden mid-run pauses (no ticks while hidden);
  - after `stop()`, a later visibility change does not tick (unsubscribed).
- `lib/use-live-poll.ts` (React/DOM glue) and the UI toggle + persistence are
  verified manually (dev server: toggle on → refreshes every 5s; off → stops;
  background the tab → pauses). The dashboard is **not wired into CI test runs**
  today (no `test` script; pre-existing condition, out of scope to change), so
  the new test runs via the direct command above rather than `pnpm -r test`.

## Files touched

| File | Change |
| --- | --- |
| `components/cockpit/context.tsx` | +1 field `livePolling` in `Tweaks` + default |
| `lib/live-poll.ts` | **new** — pure, DOM-free polling controller |
| `lib/live-poll.test.ts` | **new** — `node:test` unit tests |
| `lib/use-live-poll.ts` | **new** — thin React hook (document + interval glue) |
| `app/(cockpit)/cockpit-shell.tsx` | wire `useLivePoll`; pass `live`/`onToggleLive` |
| `components/cockpit/chrome.tsx` | footer "Live" toggle in `CkSidebar` |
