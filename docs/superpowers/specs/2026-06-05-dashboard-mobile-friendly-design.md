# Dashboard Mobile-Friendly — Design

**Date:** 2026-06-05
**Status:** Approved (pending spec review)
**App:** `apps/dashboard`

## Problem

The dashboard is built desktop-first with zero responsive support. The shell is `h-screen w-screen flex` with an always-on 220px sidebar, a 56px topbar, and a fixed 420px activity drawer. Content uses hardcoded grids (`grid-cols-4`, `grid-cols-[1.5fr_1fr]`), fixed truncation widths (`max-w-[480px]`), a 2200px flow-editor canvas, and 100% mouse-driven editor interactions. On a phone (~390px) the sidebar eats ~23% of the width, KPI tiles crush to slivers, tables and the editor canvas overflow horizontally, and the drawer is wider than the screen. Nothing reflows.

## Goal

Make the entire dashboard usable on phones (~390px) and tablets, **including** the flow editor with full touch authoring. Faithfully extend the existing cockpit design system (mariner blue, burnt orange, coal, Manrope/JetBrains Mono, `ck-slide`/`ck-pop` motion) — no new visual language.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Screen scope | Everything, including the flow/workflow editors |
| Device targets | Phones-first, tablets too |
| Mobile navigation | Bottom tab bar |
| Editor depth | Full touch authoring (drag, pinch-zoom, pan, add, connect) |
| Implementation approach | **B — separate mobile components** (forked presentation, shared logic) |
| Activity stream on mobile | **Removed entirely** (tab + drawer); desktop drawer untouched |

## Approach

**Separate mobile component layer (approach B), with logic kept shared.** A parallel set of mobile presentation components lives under `components/cockpit/mobile/`. The data layer (`app/*-data.tsx` server components, `lib/` types & contracts, mock data) and the atomic UI primitives (`CkStatusPill`, `CkChip`, `CkKPI`, `CkCard`, `TicketLink`, `PRLink`) are **shared, not forked** — only layout/composition is duplicated. This is the user's chosen approach; the trade-off (two presentation trees to keep in sync) is accepted and contained to layout.

### Breakpoint strategy

Tailwind v4 default breakpoints. Three bands:

- **Mobile `< md` (< 768px):** bottom tab bar, single-column, bottom sheets, touch editor. No sidebar, no desktop drawer.
- **Tablet `md`–`lg` (768–1024px):** existing sidebar auto-collapses to the 60px icon rail; 2-column grids; activity drawer remains a side panel.
- **Desktop `≥ lg` (≥ 1024px):** current cockpit, unchanged.

### SSR-safe shell switching

The route-group layout chooses chrome by **CSS visibility**, not a JS media-query that could cause a hydration flash:

- Desktop shell wrapper: `hidden lg:flex`
- Mobile shell wrapper: `flex lg:hidden`

Both trees receive the same server-fetched data (the existing `*-data.tsx` Suspense boundaries fetch once). Tablet behavior is handled within the desktop shell (the sidebar already supports the 60px collapsed rail; default it collapsed below `lg`).

> Note: rendering both trees ships two DOMs. Acceptable here — the screens are not heavy, and it eliminates hydration mismatch. If bundle/DOM size becomes a problem, a `useSyncExternalStore`-based `matchMedia` hook can replace CSS visibility later.

## Components

### New — `components/cockpit/mobile/`

- **`mobile-shell.tsx`** — phone chrome: compact header (logo + screen title + optional search), main scroll area, bottom tab bar, and a sheet host. Owns mobile-only state. Mirrors `CockpitShell` but for `< lg`.
- **`bottom-tab-bar.tsx`** — 4-slot fixed bottom bar: **Overview · Runs · Editor · More**. Active tab in mariner with JetBrains-Mono labels (matches sidebar active treatment). Routes via the existing App Router segments. "More" opens a sheet listing Prompts, Evals, Cost.
- **`mobile-sheet.tsx`** — shared bottom-sheet primitive: grab handle, scrim, `ck-slide` entry, swipe/scrim-tap to dismiss. Used by "More", the editor palette, and the node config.
- **`mobile/screens/*`** — per-screen mobile compositions (overview, runs, prompts, evals, cost, trace) built from shared primitives.

### Shared (unchanged)

- `app/*-data.tsx` server components and Suspense boundaries.
- `lib/` types, contracts, flows, mock data.
- Atomic primitives in `components/ui.tsx`.

## Per-screen reflow

- **Overview / Cost / Evals / Prompts:** KPI grids collapse 4→2 cols; the `grid-cols-[1.5fr_1fr]` hero stacks vertically; charts use full width.
- **Runs:** the 10-column table becomes a list of tappable **cards** — status pill + ticket title + ticket/PR chips on top, then a 3-up monospace metric strip (duration / cost / eval, expandable for model/tokens/started). Filter `CkTabs` become horizontally scrollable. Tap a card → `/trace/[runId]`.
- **Trace:** flame graph gets horizontal scroll + pinch; metadata stacks.
- **Activity drawer:** **not rendered on mobile** (removed). Stays on desktop unchanged.

## Editor — full touch authoring

The flow editor (`components/cockpit/screens/flow-editor.tsx`) is the largest piece. It is currently 100% mouse-driven (`onMouseDown/Move/Up`, HTML5 drag-and-drop palette, ctrl+wheel-only zoom).

1. **Pointer Events migration.** Replace `onMouse*` on `FlowCanvas`, `FlowNode`, and ports with `onPointerDown/Move/Up` (+ `setPointerCapture`). One code path serves mouse and touch. Node drag and canvas pan work unchanged through pointers.
2. **Pinch-zoom + two-finger pan.** Add a touch gesture handler tracking two active pointers: pinch distance → zoom (anchored at the gesture centroid, mirroring the existing cursor-anchored wheel-zoom math), two-finger move → pan. Keep ctrl+wheel zoom for desktop.
3. **Palette → FAB + sheet.** HTML5 drag-and-drop does not work on touch. On mobile, a **＋ floating action button** opens a palette bottom sheet (`mobile-sheet`); tapping an item adds the node at the canvas center (reuses the existing click-to-add `addNode` path). Desktop drag-and-drop stays.
4. **Connecting → tap-to-connect.** On touch, drag-a-wire is replaced by **tap source port → tap target port**. A tapped output port enters "connecting" state (highlighted); tapping a target input port calls `addEdge`; tapping empty canvas cancels. Desktop keeps drag-to-connect.
5. **Config → bottom sheet.** `NodeConfig` (320px right rail) and its sub-editors render as a `mobile-sheet` on mobile; the desktop rail is unchanged.

## Verification

No new test framework. Verify against the running dev server with the agent-browser:

- Each screen at **390 / 768 / 1024px**: no horizontal overflow, readable typography, correct chrome (tab bar vs. rail vs. sidebar) per band.
- Tab bar routing across all 4 slots + "More" sheet.
- Editor touch flows: add node (FAB sheet), tap-to-connect, drag node, pinch-zoom, two-finger pan, open/edit config sheet.
- Desktop (`≥ lg`) regression check: cockpit, sidebar, and activity drawer behave exactly as before.

## Out of scope

- No new colors, fonts, or design tokens — reuse the existing system.
- No data, API, or contract changes.
- No change to desktop (`≥ lg`) behavior.
- No PWA/offline/install features.
- Activity stream on mobile (removed by decision).

## Risks / open notes

- **Dual DOM cost** from CSS-visibility switching (see SSR note) — acceptable, revisit if measured to matter.
- **Pointer Events regression risk** on desktop editor — the migration touches the most complex component; the desktop regression check above is the guard.
- Tablet relies on the existing 60px rail behaving well at 768–1024px; confirm during verification.
