---
paths:
  - "apps/dashboard/**"
---

# Dashboard UI

- Browser requests use `apps/dashboard/lib/api/client.ts`. Raw `fetch` belongs
  only in that browser endpoint client and the server-only transports
  `apps/dashboard/lib/api/server.ts`, `apps/dashboard/lib/api/proxy.ts`, and
  `apps/dashboard/lib/auth/worker-core.ts`.
- The worker's store is the authority on run state. The live overlay is a view:
  when a polled overlay and the stored run disagree, the store wins. Making the
  overlay authoritative is what produced phantom "running" runs.
- A bare `1fr` grid track is `minmax(auto, 1fr)` and therefore honours its
  content's min-content, which blows the layout out and makes the cockpit shell
  scroll sideways. Any `1fr` track holding wide content needs
  `minmax(0, 1fr)`, and its grid item needs `min-w-0`.
- iOS Safari fires `pointerleave` spuriously mid-gesture, even with pointer
  capture set, so `onPointerLeave={onPointerUp}` ends a canvas drag one move
  in. Gate it to non-touch pointers. Keep the non-passive native `touchmove`
  listener with `preventDefault()`: React's `onTouchMove` is passive on iOS and
  cannot stop the page-scroll hijack.
- The dashboard reads KPIs from the deployed worker (`WORKER_BASE_URL`), so a
  worker-side fix does not show on localhost until redeploy.
  `apps/dashboard/lib/api/derive-kpis.ts` derives the tiles from the runs list as
  a per-field fallback.
- Keep data fetching in server components and state, effects, and event handlers
  in client components. Adding a hook to a data component can pass typechecking
  and still break the build. Place: `apps/dashboard/app/`.
- Keep one block form entry module per catalog type under
  `apps/dashboard/components/cockpit/flow-editor/blocks/`, shared primitives in
  support modules, and
  `apps/dashboard/components/cockpit/flow-editor/config-fields.tsx` as the stable
  compatibility facade.
- Hand-write editor forms for each block type. A new block type needs its own
  config fields as well as its worker definition and generated catalog entry.

History: docs/archive/agent-notes/dashboard.md
