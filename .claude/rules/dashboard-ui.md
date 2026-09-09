---
paths:
  - "apps/dashboard/**"
---

# Dashboard UI

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
  `lib/api/derive-kpis.ts` derives the tiles from the runs list as a per-field
  fallback.
