# Overview API — Requirements

REST contract for the data backing `components/cockpit/screens/overview.tsx`.
Field shapes mirror the existing types in `lib/types.ts` so the screen can be migrated from `AIWF_DATA` to live fetches with zero UI changes.

---

## 1. Scope

The Overview screen renders six logical panels:

| # | Panel | Source today | Refresh hint |
|---|-------|--------------|--------------|
| 1 | Hero KPI strip (Runs 24h, Eval health, p95, Errors) | `WORKFLOWS` aggregates + `HOURS24` sparklines | 30s |
| 2 | Eval health KPI (donut + pass/warn/fail) | hardcoded in component | 60s |
| 3 | "Now running" panel | `LIVE_RUNS` where `status === "running"` | 2–5s (live) |
| 4 | "Input needed" panel (HITL) | `LIVE_RUNS` where `status === "awaiting"` | 5–10s |
| 5 | "Recent runs" table (7/page) | `RUNS` | 15s |
| 6 | "Workflows" table (5/page) + latest ticket per workflow | `WORKFLOWS` joined with `RUNS` | 30s |

Two delivery options are documented:
- **A.** One bundled endpoint that returns everything the screen needs.
- **B.** Per-panel endpoints (recommended if any panel will be reused elsewhere).

The shared route prefix is `/api/v1`.

---

## 2. Shared types

These mirror `lib/types.ts` exactly.

```ts
type RunStatus = "success" | "running" | "failed" | "blocked" | "awaiting";
type SpanKind  = "workflow" | "llm" | "tool" | "guardrail" | "retrieval";

interface Workflow {
  id: string;
  name: string;
  blurb: string;
  runs24h: number;
  p50: number;          // seconds
  p95: number;          // seconds
  errRate: number;      // 0..1
  costToday: number;    // USD
  gateway: string;      // e.g. "ai-gateway"
  primary?: boolean;
}

interface Run {
  id: string;
  workflow: string;        // workflow id
  workflowName: string;
  status: RunStatus;
  ticket: string;          // e.g. "ENG-1234"
  actor: string;
  model: string;
  startedAtMin: number;    // minutes ago
  duration: number | null; // seconds (null while running)
  tokens: number;
  cost: number;            // USD
  spans: number;
  evalScore: number;       // 0..1
  guardrailHits: number;

  ticketTitle: string;
  prNumber: number | null;
  ticketUrl: string;
  prUrl: string | null;

  // status === "running"
  currentSpan?: string;
  currentSpanKind?: SpanKind;
  progress?: number;       // 0..1
  spanIndex?: number;
  spansTotal?: number;
  elapsed?: number;        // seconds
  etaSec?: number;         // seconds remaining

  // status === "awaiting"
  pausedAtSpan?: string;
  askedAtMin?: number;
  question?: string;
  questionFor?: string;
  blockingReason?: string;
  suggestedAnswers?: string[];
}

interface HourPoint {
  h: number;       // 0..23
  runs: number;
  cost: number;    // USD
  p95: number;     // seconds
  errors: number;
}
```

---

## 3. Option A — Bundled endpoint

### `GET /api/v1/overview`

Returns everything the screen needs in a single round trip.

**Query params**
- `window` — `"24h"` (default). Reserved for future `"7d" | "30d"`.
- `tz` — IANA timezone, default `"UTC"`. Used to bucket the 24h hourly series.

**Response 200**
```ts
{
  generatedAt: string;         // ISO 8601
  window: "24h";

  kpis: {
    runs24h:   { value: number; deltaPct: number;  spark: number[] }; // length 24
    p95:       { valueSec: number; deltaSec: number; spark: number[] };
    errors24h: { value: number; deltaPct: number;  spark: number[] };
    cost24h:   { value: number; deltaPct: number };
  };

  evalHealth: {
    score: number;             // 0..100, displayed as "92.3"
    pass: number;
    warn: number;
    fail: number;
    spansGraded: number;       // e.g. 12400
    windowHours: 24;
  };

  liveRuns: Run[];             // include both running + awaiting

  recentRuns: {
    rows: Run[];               // most recent N (e.g. 50)
    total: number;             // total available for paging
    counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
  };

  workflows: Array<Workflow & {
    latestRun: Pick<Run, "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl"> | null;
    trend24h: number[];        // length 24, normalized 0..1 or raw runs/hour
  }>;
}
```

**Notes**
- All `delta*` are vs the previous 24h window. Positive = increase.
- `spark` arrays must always be length 24 (pad zeros where needed).
- `recentRuns.rows` should be ordered by `startedAtMin` ascending (most recent first).
- The UI today shows 7/page; returning ~50 lets it page without re-fetching.

---

## 4. Option B — Per-panel endpoints (recommended)

### 4.1 `GET /api/v1/overview/kpis`

Backs the hero KPI strip (panel 1).

**Response**
```ts
{
  generatedAt: string;
  runs24h:   { value: number; deltaPct: number; spark: number[24] };
  p95:       { valueSec: number; deltaSec: number; spark: number[24] };
  errors24h: { value: number; deltaPct: number; spark: number[24] };
  cost24h:   { value: number; deltaPct: number };
}
```

### 4.2 `GET /api/v1/overview/eval-health`

Backs the Eval health donut KPI (panel 2).

**Response**
```ts
{
  score: number;          // 0..100
  pass: number;
  warn: number;
  fail: number;
  spansGraded: number;
  windowHours: number;    // typically 24
}
```

### 4.3 `GET /api/v1/runs/live`

Backs both the "Now running" and "Input needed" panels (3 + 4).

**Query params**
- `status` — `"running" | "awaiting" | "running,awaiting"` (default = both).

**Response**
```ts
{
  generatedAt: string;
  rows: Run[];           // only "running" and "awaiting" rows
}
```

**Validation**
- For `status === "running"`, the following MUST be present: `currentSpan`, `currentSpanKind`, `progress`, `spanIndex`, `spansTotal`, `elapsed`, `etaSec`.
- For `status === "awaiting"`, the following MUST be present: `question`, `questionFor`, `askedAtMin`, `suggestedAnswers` (may be `[]`).

### 4.4 `GET /api/v1/runs`

Backs the "Recent runs" table (panel 5).

**Query params**
- `limit` — default `20`, max `100`
- `offset` — default `0`
- `status` — optional comma list to filter
- `workflow` — optional workflow id
- `sort` — default `"startedAt:desc"`

**Response**
```ts
{
  rows: Run[];
  total: number;
  counts: { success: number; running: number; awaiting: number; failed: number; blocked: number };
}
```

**Validation**
- Every row MUST include the "decorated" link fields (`ticketTitle`, `ticketUrl`, and `prNumber`/`prUrl` when a PR exists).
- `evalScore` may be `0` for runs that have not been graded; the UI shows `—` when falsy.

### 4.5 `GET /api/v1/workflows`

Backs the "Workflows" table (panel 6).

**Query params**
- `limit`, `offset` — pagination (UI shows 5/page)
- `includeLatestRun` — default `true`
- `includeTrend` — default `true`

**Response**
```ts
{
  rows: Array<Workflow & {
    latestRun: Pick<Run, "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl"> | null;
    trend24h: number[];   // length 24
  }>;
  total: number;
}
```

---

## 5. Error contract

All endpoints follow a standard error envelope:

```ts
// HTTP 4xx / 5xx
{
  error: {
    code: string;        // e.g. "INVALID_QUERY", "NOT_FOUND", "INTERNAL"
    message: string;     // human-readable
    details?: unknown;   // optional structured detail
  }
}
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Invalid query params (bad `window`, bad `status`, etc.) |
| 401 | Missing/invalid auth |
| 403 | Authenticated but not allowed |
| 429 | Rate limited |
| 500 | Internal error |

---

## 6. Caching, freshness, auth

- **Auth.** All endpoints require a session cookie or `Authorization: Bearer <token>`. 401 if missing.
- **Cache headers.**
  - KPIs / Eval health / Workflows: `Cache-Control: private, max-age=15, stale-while-revalidate=60`
  - Recent runs: `Cache-Control: private, max-age=10, stale-while-revalidate=30`
  - Live runs: `Cache-Control: no-store` (always fresh).
- **ETags.** Optional, but recommended on the bundled endpoint to short-circuit polling.
- **Rate limits.** Document per-endpoint; default 60 req/min/user.

---

## 7. Pagination conventions

- All list endpoints accept `limit` and `offset`.
- Response always includes `total` so the existing `CkPagination` component can render page counts.
- `limit` is capped (typically 100) — requests over the cap return 400.

---

## 8. Timezone & windowing

- All `*24h` aggregates are over the last 24h rolling window (now − 24h, now].
- Hourly sparklines (`spark`, `trend24h`) are bucketed by the `tz` query param if supplied; otherwise UTC.
- All timestamps in payloads are ISO 8601 UTC.
- `startedAtMin` and `askedAtMin` remain "minutes ago" relative to `generatedAt` to match the UI rendering.

---

## 9. Acceptance checklist

Before swapping `AIWF_DATA` for live fetches, the API must:

- [ ] Return `Workflow`, `Run`, and `HourPoint` shapes byte-compatible with `lib/types.ts`.
- [ ] Surface `latestRun` join data so the Workflows table avoids an N+1 client lookup.
- [ ] Return `trend24h` per workflow (currently random in the UI).
- [ ] Provide live `running` rows with `progress`, `spanIndex`, `spansTotal`, `elapsed`, `etaSec`.
- [ ] Provide live `awaiting` rows with `question`, `questionFor`, `askedAtMin`, `suggestedAnswers`.
- [ ] Provide aggregate `counts` on `/runs` so the header chips render without a second request.
- [ ] Provide `deltaPct` / `deltaSec` on KPIs so the colored arrows render server-side-truth.
- [ ] Honor `Cache-Control: no-store` for live endpoints.
- [ ] Be reachable from this dashboard (CORS allowlist + auth).
