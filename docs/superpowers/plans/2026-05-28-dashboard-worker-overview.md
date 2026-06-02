# Dashboard ← Worker Overview Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `AIWF_DATA` mock data on the Dashboard Overview screen with HTTP calls to the worker's REST API, and set up the shared contract surface that lets the rest of the dashboard follow the same pattern later.

**Architecture:** A new `apps/shared/contracts/` folder hosts domain + API types, imported via the `@shared/*` TypeScript path alias from both apps. The worker exposes a small `/api/v1/*` Nitro file-routed surface — serving real data where it has it (live ticket → run mappings via Upstash + the Jira adapter) and field-level `null` for everything historical (KPIs, eval health, run history, workflow metrics). The dashboard uses TanStack Query to fetch from the worker; CORS is the only cross-origin gate.

**Tech Stack:** Next.js 15 + React 19 (dashboard), Nitro on Vercel (worker), Zod (env), `@tanstack/react-query`, Vitest.

**Source spec:** `docs/superpowers/specs/2026-05-28-dashboard-worker-overview-design.md`

---

## File Structure

**Create:**
- `apps/shared/contracts/domain.ts` — `RunStatus`, `SpanKind`, `Run`, `Workflow`, `HourPoint`
- `apps/shared/contracts/api.ts` — `KpisResponse`, `EvalHealthResponse`, `LiveRunsResponse`, `RunsResponse`, `WorkflowsResponse`, `WorkflowRow`, error envelope
- `apps/shared/contracts/index.ts` — barrel
- `apps/shared/tsconfig.json` — standalone typecheck target
- `apps/worker/src/plugins/cors.ts` — Nitro CORS plugin scoped to `/api/v1/*`
- `apps/worker/src/lib/overview/workflow-registry.ts` — static workflow registry
- `apps/worker/src/lib/overview/collect-live-runs.ts` — collector reading Upstash + Jira
- `apps/worker/src/lib/overview/collect-live-runs.test.ts` — unit tests
- `apps/worker/src/lib/overview/collect-workflows.ts` — wraps registry as API rows
- `apps/worker/src/routes/api/v1/overview/kpis.get.ts`
- `apps/worker/src/routes/api/v1/overview/eval-health.get.ts`
- `apps/worker/src/routes/api/v1/runs.get.ts`
- `apps/worker/src/routes/api/v1/runs/live.get.ts`
- `apps/worker/src/routes/api/v1/workflows.get.ts`
- `apps/dashboard/app/providers.tsx`
- `apps/dashboard/lib/api/client.ts`
- `apps/dashboard/lib/api/overview.ts`

**Modify:**
- `apps/worker/env.ts` — add `DASHBOARD_ORIGIN`
- `apps/worker/tsconfig.json` — add `@shared/*` path alias + include shared sources
- `apps/dashboard/tsconfig.json` — add `@shared/*` path alias
- `apps/dashboard/package.json` — remove `swr`, add `@tanstack/react-query` (+ devtools)
- `apps/dashboard/app/layout.tsx` — wrap `{children}` in `<Providers>`
- `apps/dashboard/lib/types.ts` — re-export domain types from `@shared/contracts`
- `apps/dashboard/components/ui.tsx` — add `disabled` prop to `CkKPI`
- `apps/dashboard/components/cockpit/screens/overview.tsx` — replace mock reads with queries + N/A states

**Delete:**
- `apps/dashboard/app/api/{activity,cost,evals,prompts,runs,workflows}/` (empty placeholders)

**Leave untouched:**
- `apps/dashboard/lib/data/mock.ts` — still consumed by other screens
- `apps/dashboard/lib/integrations/` — used by other screens; out of scope
- `apps/worker/src/routes/{cron,webhooks}/*` — unchanged
- All non-Overview screens (Runs, Trace, Prompts, Evals, Cost, Pre-sandbox, Post-PR)

---

## Deliberate deviations from the spec

Documented up-front so the engineer doesn't re-debate these during implementation:

1. **`Workflow` in `apps/shared/contracts/domain.ts` keeps non-null metric fields** (design §4.2 widens them to `number | null`). Widening would force narrowing changes in `apps/dashboard/components/cockpit/screens/cost.tsx` (6 sites) and any future consumer, violating spec §11 "non-Overview screens keep using AIWF_DATA". Instead the API response defines a sibling `WorkflowRow` interface in `apps/shared/contracts/api.ts` with the nullable metric fields. Only the Overview path consumes `WorkflowRow`.
2. **Route layout uses `runs.get.ts` (file)** alongside `runs/live.get.ts` (folder), not `runs/index.get.ts`. Matches the existing Nitro convention in this repo (`health.get.ts`, `webhooks/jira.post.ts`) — `index.get.ts` is unverified and may map to `GET /runs/index`.

---

## Task 1: Create the `apps/shared/contracts` folder

**Files:**
- Create: `apps/shared/tsconfig.json`
- Create: `apps/shared/contracts/domain.ts`
- Create: `apps/shared/contracts/api.ts`
- Create: `apps/shared/contracts/index.ts`

- [ ] **Step 1: Create the shared tsconfig**

`apps/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["contracts/**/*.ts"]
}
```

- [ ] **Step 2: Write the domain types**

`apps/shared/contracts/domain.ts`:

```ts
export type RunStatus = "success" | "running" | "failed" | "blocked" | "awaiting";
export type SpanKind = "workflow" | "llm" | "tool" | "guardrail" | "retrieval";

export interface Workflow {
  id: string;
  name: string;
  blurb: string;
  runs24h: number;
  p50: number;
  p95: number;
  errRate: number;
  costToday: number;
  gateway: string;
  primary?: boolean;
}

export interface Run {
  id: string;
  workflow: string;
  workflowName: string;
  status: RunStatus;
  ticket: string;
  actor: string;
  model: string;
  startedAtMin: number;
  duration: number | null;
  tokens: number;
  cost: number;
  spans: number;
  evalScore: number;
  guardrailHits: number;
  ticketTitle: string;
  prNumber: number | null;
  ticketUrl: string;
  prUrl: string | null;
  // Live — status === "running"
  currentSpan?: string;
  currentSpanKind?: SpanKind;
  progress?: number;
  spanIndex?: number;
  spansTotal?: number;
  elapsed?: number;
  etaSec?: number;
  // Human-in-the-loop — status === "awaiting"
  pausedAtSpan?: string;
  askedAtMin?: number;
  question?: string;
  questionFor?: string;
  blockingReason?: string;
  suggestedAnswers?: string[];
}

export interface HourPoint {
  h: number;
  runs: number;
  cost: number;
  p95: number;
  errors: number;
}
```

- [ ] **Step 3: Write the API contract types**

`apps/shared/contracts/api.ts`:

```ts
import type { Run, Workflow } from "./domain.js";

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

export interface KpisResponse {
  generatedAt: string;
  runs24h: { value: number; deltaPct: number; spark: number[] } | null;
  p95: { valueSec: number; deltaSec: number; spark: number[] } | null;
  errors24h: { value: number; deltaPct: number; spark: number[] } | null;
  cost24h: { value: number; deltaPct: number } | null;
}

export type EvalHealthResponse =
  | {
      available: true;
      score: number;
      pass: number;
      warn: number;
      fail: number;
      spansGraded: number;
      windowHours: number;
    }
  | { available: false; reason: string };

export interface LiveRunsResponse {
  generatedAt: string;
  rows: Run[];
}

export interface RunsResponse {
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

export interface WorkflowRow extends Pick<Workflow, "id" | "name" | "blurb" | "gateway"> {
  primary?: boolean;
  runs24h: number | null;
  p50: number | null;
  p95: number | null;
  errRate: number | null;
  costToday: number | null;
  latestRun: Pick<
    Run,
    "ticket" | "ticketUrl" | "ticketTitle" | "prNumber" | "prUrl"
  > | null;
  trend24h: number[] | null;
}

export interface WorkflowsResponse {
  generatedAt: string;
  rows: WorkflowRow[];
  total: number;
}
```

- [ ] **Step 4: Write the barrel**

`apps/shared/contracts/index.ts`:

```ts
export * from "./domain.js";
export * from "./api.js";
```

- [ ] **Step 5: Typecheck the shared package alone**

Run: `cd apps/shared && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add apps/shared
git commit -m "feat(shared): add domain + API contracts package"
```

---

## Task 2: Wire `@shared/*` path alias into both apps

**Files:**
- Modify: `apps/worker/tsconfig.json`
- Modify: `apps/dashboard/tsconfig.json`

- [ ] **Step 1: Replace the worker tsconfig**

Write `apps/worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["../shared/*"]
    },
    "types": ["vitest/globals"]
  },
  "include": [
    "src/**/*.ts",
    "env.ts",
    "nitro.config.ts",
    "vitest.config.ts",
    "../shared/contracts/**/*.ts"
  ],
  "exclude": ["node_modules", "dist", ".output", ".nitro"]
}
```

- [ ] **Step 2: Patch the dashboard tsconfig**

In `apps/dashboard/tsconfig.json`, find:

```json
    "paths": { "@/*": ["./*"] }
```

Replace with:

```json
    "paths": {
      "@/*": ["./*"],
      "@shared/*": ["../shared/*"]
    }
```

- [ ] **Step 3: Verify the worker typechecks**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0. (No worker code imports `@shared/*` yet; this confirms the config is syntactically valid.)

- [ ] **Step 4: Verify the dashboard typechecks**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/tsconfig.json apps/dashboard/tsconfig.json
git commit -m "build: add @shared/* path alias in worker and dashboard"
```

---

## Task 3: Re-export shared domain types from `apps/dashboard/lib/types.ts`

**Files:**
- Modify: `apps/dashboard/lib/types.ts`

- [ ] **Step 1: Replace the top of the file**

In `apps/dashboard/lib/types.ts`, find lines 1–53 (the `RunStatus`/`SpanKind`/`SpanStatus`/`Workflow`/`Run` block):

```ts
export type RunStatus = "success" | "running" | "failed" | "blocked" | "awaiting";
export type SpanKind = "workflow" | "llm" | "tool" | "guardrail" | "retrieval";
export type SpanStatus = "ok" | "warn" | "error";

export interface Workflow {
  ...
}

export interface Run {
  ...
}
```

Replace with:

```ts
export type {
  RunStatus,
  SpanKind,
  Workflow,
  Run,
  HourPoint,
} from "@shared/contracts";

export type SpanStatus = "ok" | "warn" | "error";
```

Also delete the original `HourPoint` declaration further down the file (around the previous lines 86–92):

```ts
export interface HourPoint {
  h: number;
  ...
}
```

(It is now re-exported from `@shared/contracts`.)

- [ ] **Step 2: Verify the dashboard typechecks**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0. Existing imports `from "@/lib/types"` still resolve because the names are re-exported.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/lib/types.ts
git commit -m "refactor(dashboard): re-export domain types from @shared/contracts"
```

---

## Task 4: Worker — add `DASHBOARD_ORIGIN` env var

**Files:**
- Modify: `apps/worker/env.ts`

- [ ] **Step 1: Add the env field**

In `apps/worker/env.ts`, find the `Redis (run registry)` block at the end of the `server` object:

```ts
    // Redis (run registry)
    AI_WORKFLOW_KV_REST_API_URL: z.string().url(),
    AI_WORKFLOW_KV_REST_API_TOKEN: z.string().min(1),
```

Add a new field directly below it (still inside `server`, before the closing brace):

```ts
    // Redis (run registry)
    AI_WORKFLOW_KV_REST_API_URL: z.string().url(),
    AI_WORKFLOW_KV_REST_API_TOKEN: z.string().min(1),

    // Dashboard
    DASHBOARD_ORIGIN: z.string().url(),
```

- [ ] **Step 2: Run worker env tests**

Run: `cd apps/worker && DASHBOARD_ORIGIN=http://localhost:3001 pnpm test env.test.ts`
Expected: existing tests pass. If any test constructs env without supplying `DASHBOARD_ORIGIN`, add it to that test's input fixture so the new required field is satisfied.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/env.ts apps/worker/env.test.ts
git commit -m "feat(worker): require DASHBOARD_ORIGIN env var"
```

---

## Task 5: Worker — CORS plugin for `/api/v1/*`

**Files:**
- Create: `apps/worker/src/plugins/cors.ts`

- [ ] **Step 1: Write the plugin**

`apps/worker/src/plugins/cors.ts`:

```ts
import { defineNitroPlugin } from "nitropack/runtime";
import { setResponseHeaders, sendNoContent } from "h3";
import { env } from "../../env.js";

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", async (event) => {
    if (!event.path.startsWith("/api/v1/")) return;

    setResponseHeaders(event, {
      "Access-Control-Allow-Origin": env.DASHBOARD_ORIGIN,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
    });

    if (event.method === "OPTIONS") {
      await sendNoContent(event, 204);
    }
  });
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/plugins/cors.ts
git commit -m "feat(worker): CORS plugin for /api/v1/* scoped to DASHBOARD_ORIGIN"
```

---

## Task 6: Worker — static workflow registry

**Files:**
- Create: `apps/worker/src/lib/overview/workflow-registry.ts`

- [ ] **Step 1: Write the registry helper**

`apps/worker/src/lib/overview/workflow-registry.ts`:

```ts
import { env } from "../../../env.js";
import type { Workflow } from "@shared/contracts";

/**
 * Workflows the worker actually runs. Names and blurbs are static; metric
 * fields (runs24h/p50/p95/errRate/costToday) are not tracked per-workflow yet —
 * the API layer maps these to `null` for the response shape.
 */
export function getWorkflowRegistry(): Workflow[] {
  const gateway = env.AGENT_KIND === "codex" ? "openai" : "anthropic";
  return [
    {
      id: "wf_agent",
      name: "Agent",
      blurb: "Ticket → tested PR (main workflow).",
      runs24h: 0,
      p50: 0,
      p95: 0,
      errRate: 0,
      costToday: 0,
      gateway,
      primary: true,
    },
    {
      id: "wf_pre_sandbox",
      name: "Pre-sandbox",
      blurb: "Validates and prepares attachments before the agent run.",
      runs24h: 0,
      p50: 0,
      p95: 0,
      errRate: 0,
      costToday: 0,
      gateway,
    },
    {
      id: "wf_post_pr_gate",
      name: "Post-PR gate",
      blurb: "Reviews the PR after the agent opens it.",
      runs24h: 0,
      p50: 0,
      p95: 0,
      errRate: 0,
      costToday: 0,
      gateway,
    },
  ];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/lib/overview/workflow-registry.ts
git commit -m "feat(worker): static workflow registry"
```

---

## Task 7: Worker — `collectLiveRuns` (TDD)

**Files:**
- Create: `apps/worker/src/lib/overview/collect-live-runs.test.ts`
- Create: `apps/worker/src/lib/overview/collect-live-runs.ts`

- [ ] **Step 1: Write the failing test**

`apps/worker/src/lib/overview/collect-live-runs.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { collectLiveRuns } from "./collect-live-runs.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";

function makeRegistry(
  entries: Array<{ ticketKey: string; runId: string }>,
): RunRegistryAdapter {
  return {
    claim: vi.fn(),
    register: vi.fn(),
    getRunId: vi.fn(),
    unregister: vi.fn(),
    listAll: vi.fn().mockResolvedValue(entries),
    registerSandbox: vi.fn(),
    getSandboxId: vi.fn(),
    getEntryCreatedAt: vi.fn(),
    markFailed: vi.fn(),
    isTicketFailed: vi.fn(),
    listAllFailed: vi.fn(),
    clearFailedMark: vi.fn(),
  };
}

function makeTracker(
  overrides: Partial<IssueTrackerAdapter> = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn(),
    moveTicket: vi.fn(),
    postComment: vi.fn().mockResolvedValue(null),
    searchTickets: vi.fn(),
    ...overrides,
  };
}

describe("collectLiveRuns", () => {
  it("maps registry entries to Run rows with ticket titles", async () => {
    const registry = makeRegistry([
      { ticketKey: "AWT-101", runId: "run_a" },
      { ticketKey: "AWT-102", runId: "run_b" },
    ]);
    const tracker = makeTracker({
      fetchTicket: vi.fn(async (key: string) => ({
        id: key,
        identifier: key,
        projectKey: "AWT",
        title: key === "AWT-101" ? "First ticket" : "Second ticket",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
        attachments: [],
      })),
    });

    const rows = await collectLiveRuns({
      registry,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net",
      model: "claude-opus-4-7",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "run_a",
      ticket: "AWT-101",
      ticketTitle: "First ticket",
      ticketUrl: "https://example.atlassian.net/browse/AWT-101",
      status: "running",
      workflow: "wf_agent",
      workflowName: "Agent",
      actor: "ai-bot",
      model: "claude-opus-4-7",
    });
    expect(rows[1].ticket).toBe("AWT-102");
    expect(rows[1].ticketTitle).toBe("Second ticket");
  });

  it("falls back to the ticket key when issue tracker lookup fails", async () => {
    const registry = makeRegistry([{ ticketKey: "AWT-999", runId: "run_x" }]);
    const tracker = makeTracker({
      fetchTicket: vi.fn().mockRejectedValue(new Error("not found")),
    });

    const rows = await collectLiveRuns({
      registry,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net",
      model: "claude-opus-4-7",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticket: "AWT-999",
      ticketTitle: "AWT-999",
      ticketUrl: "https://example.atlassian.net/browse/AWT-999",
    });
  });

  it("returns an empty array when the registry is empty", async () => {
    const rows = await collectLiveRuns({
      registry: makeRegistry([]),
      issueTracker: makeTracker(),
      jiraBaseUrl: "https://example.atlassian.net",
      model: "claude-opus-4-7",
    });
    expect(rows).toEqual([]);
  });

  it("strips trailing slashes from the Jira base URL when building ticketUrl", async () => {
    const registry = makeRegistry([{ ticketKey: "AWT-7", runId: "run_z" }]);
    const tracker = makeTracker({
      fetchTicket: vi.fn(async () => ({
        id: "AWT-7",
        identifier: "AWT-7",
        projectKey: "AWT",
        title: "Trim slash",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
        attachments: [],
      })),
    });

    const rows = await collectLiveRuns({
      registry,
      issueTracker: tracker,
      jiraBaseUrl: "https://example.atlassian.net/",
      model: "claude-opus-4-7",
    });

    expect(rows[0].ticketUrl).toBe("https://example.atlassian.net/browse/AWT-7");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/worker && pnpm test collect-live-runs`
Expected: fail with `Cannot find module './collect-live-runs.js'` (or similar — the implementation file does not exist yet).

- [ ] **Step 3: Implement `collectLiveRuns`**

`apps/worker/src/lib/overview/collect-live-runs.ts`:

```ts
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { RunRegistryAdapter } from "../../adapters/run-registry/types.js";
import type { Run } from "@shared/contracts";

export interface CollectLiveRunsOptions {
  registry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  jiraBaseUrl: string;
  model: string;
}

/**
 * Builds the Run[] for the Overview live panels from in-flight registry state.
 *
 * Historical/aggregate fields (cost, tokens, spans, evalScore, duration) and
 * live progress fields (currentSpan, progress, etaSec) are not tracked yet —
 * returned as 0 or omitted. The dashboard renders `—` for falsy metrics.
 *
 * `status` defaults to `"running"`; a clarification-detection signal needed to
 * distinguish `"awaiting"` is a follow-up.
 */
export async function collectLiveRuns(
  opts: CollectLiveRunsOptions,
): Promise<Run[]> {
  const { registry, issueTracker, jiraBaseUrl, model } = opts;
  const entries = await registry.listAll();
  const tenantOrigin = jiraBaseUrl.replace(/\/+$/, "");

  return Promise.all(
    entries.map(async ({ ticketKey, runId }): Promise<Run> => {
      let ticketTitle = ticketKey;
      try {
        const ticket = await issueTracker.fetchTicket(ticketKey);
        if (ticket.title) ticketTitle = ticket.title;
      } catch {
        // Best-effort lookup — fall through to the key as the title.
      }

      return {
        id: runId,
        workflow: "wf_agent",
        workflowName: "Agent",
        status: "running",
        ticket: ticketKey,
        actor: "ai-bot",
        model,
        startedAtMin: 0,
        duration: null,
        tokens: 0,
        cost: 0,
        spans: 0,
        evalScore: 0,
        guardrailHits: 0,
        ticketTitle,
        prNumber: null,
        ticketUrl: `${tenantOrigin}/browse/${ticketKey}`,
        prUrl: null,
      };
    }),
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/worker && pnpm test collect-live-runs`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/overview/collect-live-runs.ts apps/worker/src/lib/overview/collect-live-runs.test.ts
git commit -m "feat(worker): collectLiveRuns reads registry + ticket titles"
```

---

## Task 8: Worker — `collectWorkflows`

**Files:**
- Create: `apps/worker/src/lib/overview/collect-workflows.ts`

- [ ] **Step 1: Write the collector**

`apps/worker/src/lib/overview/collect-workflows.ts`:

```ts
import { getWorkflowRegistry } from "./workflow-registry.js";
import type { WorkflowRow } from "@shared/contracts";

export interface CollectWorkflowsOptions {
  limit: number;
  offset: number;
}

export interface CollectWorkflowsResult {
  rows: WorkflowRow[];
  total: number;
}

/**
 * Returns the static workflow registry as API rows. Metric fields are `null`
 * — historical aggregation is a separate workstream.
 */
export function collectWorkflows(
  opts: CollectWorkflowsOptions,
): CollectWorkflowsResult {
  const registry = getWorkflowRegistry();
  const page = registry.slice(opts.offset, opts.offset + opts.limit);
  const rows: WorkflowRow[] = page.map((w) => ({
    id: w.id,
    name: w.name,
    blurb: w.blurb,
    gateway: w.gateway,
    primary: w.primary,
    runs24h: null,
    p50: null,
    p95: null,
    errRate: null,
    costToday: null,
    latestRun: null,
    trend24h: null,
  }));
  return { rows, total: registry.length };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/lib/overview/collect-workflows.ts
git commit -m "feat(worker): collectWorkflows wraps registry as API rows"
```

---

## Task 9: Worker — KPIs and Eval Health routes (no-data shapes)

**Files:**
- Create: `apps/worker/src/routes/api/v1/overview/kpis.get.ts`
- Create: `apps/worker/src/routes/api/v1/overview/eval-health.get.ts`

- [ ] **Step 1: Write the KPIs route**

`apps/worker/src/routes/api/v1/overview/kpis.get.ts`:

```ts
import { defineEventHandler, setResponseHeader } from "h3";
import type { KpisResponse } from "@shared/contracts";

export default defineEventHandler((event): KpisResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  return {
    generatedAt: new Date().toISOString(),
    runs24h: null,
    p95: null,
    errors24h: null,
    cost24h: null,
  };
});
```

- [ ] **Step 2: Write the Eval Health route**

`apps/worker/src/routes/api/v1/overview/eval-health.get.ts`:

```ts
import { defineEventHandler, setResponseHeader } from "h3";
import type { EvalHealthResponse } from "@shared/contracts";

export default defineEventHandler((event): EvalHealthResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  return { available: false, reason: "Eval grading not wired up yet." };
});
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/routes/api/v1/overview
git commit -m "feat(worker): /api/v1/overview/{kpis,eval-health} return null shapes"
```

---

## Task 10: Worker — Recent runs route (empty history)

**Files:**
- Create: `apps/worker/src/routes/api/v1/runs.get.ts`

- [ ] **Step 1: Write the route**

`apps/worker/src/routes/api/v1/runs.get.ts`:

```ts
import { defineEventHandler, setResponseHeader } from "h3";
import type { RunsResponse } from "@shared/contracts";

export default defineEventHandler((event): RunsResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );
  return {
    generatedAt: new Date().toISOString(),
    available: false,
    rows: [],
    total: 0,
    counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
  };
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/routes/api/v1/runs.get.ts
git commit -m "feat(worker): /api/v1/runs returns empty history shape"
```

---

## Task 11: Worker — Live runs route

**Files:**
- Create: `apps/worker/src/routes/api/v1/runs/live.get.ts`

- [ ] **Step 1: Write the route**

`apps/worker/src/routes/api/v1/runs/live.get.ts`:

```ts
import { defineEventHandler, setResponseHeader } from "h3";
import { env } from "../../../../../env.js";
import { createAdapters } from "../../../../lib/adapters.js";
import { collectLiveRuns } from "../../../../lib/overview/collect-live-runs.js";
import type { LiveRunsResponse } from "@shared/contracts";

export default defineEventHandler(async (event): Promise<LiveRunsResponse> => {
  setResponseHeader(event, "Cache-Control", "no-store");

  const adapters = createAdapters();
  const model =
    env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

  const rows = await collectLiveRuns({
    registry: adapters.runRegistry,
    issueTracker: adapters.issueTracker,
    jiraBaseUrl: env.JIRA_BASE_URL,
    model,
  });

  return { generatedAt: new Date().toISOString(), rows };
});
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/routes/api/v1/runs/live.get.ts
git commit -m "feat(worker): /api/v1/runs/live returns in-flight rows"
```

---

## Task 12: Worker — Workflows route

**Files:**
- Create: `apps/worker/src/routes/api/v1/workflows.get.ts`

- [ ] **Step 1: Write the route**

`apps/worker/src/routes/api/v1/workflows.get.ts`:

```ts
import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import { collectWorkflows } from "../../../lib/overview/collect-workflows.js";
import type { WorkflowsResponse } from "@shared/contracts";

const MAX_LIMIT = 100;

export default defineEventHandler((event): WorkflowsResponse => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const query = getQuery(event);
  const limit = clamp(parseInt(String(query.limit ?? "5"), 10), 1, MAX_LIMIT);
  const offset = Math.max(
    0,
    parseInt(String(query.offset ?? "0"), 10) || 0,
  );

  const { rows, total } = collectWorkflows({ limit, offset });
  return { generatedAt: new Date().toISOString(), rows, total };
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/routes/api/v1/workflows.get.ts
git commit -m "feat(worker): /api/v1/workflows returns static registry rows"
```

---

## Task 13: Worker — Smoke test the new surface

This task verifies the worker side end-to-end before touching the dashboard. No commit.

- [ ] **Step 1: Boot the worker locally**

Set `DASHBOARD_ORIGIN=http://localhost:3001` alongside the existing required env vars (Jira, Upstash, GitHub or GitLab, webhook secret, etc. — see `apps/worker/env.ts`), then:

```bash
cd apps/worker && pnpm dev
```

Leave it running. The worker listens on `http://localhost:3000` by default.

- [ ] **Step 2: Hit each endpoint and confirm the shape**

In another shell:

```bash
curl -s http://localhost:3000/api/v1/overview/kpis | jq
curl -s http://localhost:3000/api/v1/overview/eval-health | jq
curl -s http://localhost:3000/api/v1/runs | jq
curl -s http://localhost:3000/api/v1/runs/live | jq
curl -s http://localhost:3000/api/v1/workflows | jq
```

Expected:
- `kpis`: `{ "generatedAt": <iso>, "runs24h": null, "p95": null, "errors24h": null, "cost24h": null }`
- `eval-health`: `{ "available": false, "reason": "Eval grading not wired up yet." }`
- `runs`: `{ "generatedAt": <iso>, "available": false, "rows": [], "total": 0, "counts": { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 } }`
- `runs/live`: `{ "generatedAt": <iso>, "rows": [...] }` — `rows` may be empty if the registry has no tickets in flight. If any AI-column ticket is being processed, it appears with `status: "running"`, a `ticketTitle`, and a `ticketUrl`.
- `workflows`: `{ "generatedAt": <iso>, "rows": [<wf_agent>, <wf_pre_sandbox>, <wf_post_pr_gate>], "total": 3 }` — every metric field on each row is `null`.

- [ ] **Step 3: Verify CORS headers**

```bash
curl -v -H "Origin: http://localhost:3001" http://localhost:3000/api/v1/runs/live 2>&1 | grep -i -E '(access-control|vary)'
```

Expected:
- `access-control-allow-origin: http://localhost:3001`
- `vary: Origin`
- `access-control-allow-methods: GET, OPTIONS`

- [ ] **Step 4: Verify the OPTIONS short-circuit**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS http://localhost:3000/api/v1/runs/live
```

Expected: `204`.

- [ ] **Step 5: Confirm non-`/api/v1/*` routes are not CORS-tagged**

```bash
curl -v http://localhost:3000/health 2>&1 | grep -i 'access-control'
```

Expected: no output. The plugin only touches `/api/v1/*`.

- [ ] **Step 6: Stop the worker**

Press `Ctrl-C` in step 1's shell.

(No commit — verification only.)

---

## Task 14: Dashboard — Swap SWR for TanStack Query

**Files:**
- Modify: `apps/dashboard/package.json`

- [ ] **Step 1: Remove SWR + add TanStack Query**

```bash
cd apps/dashboard
pnpm remove swr
pnpm add @tanstack/react-query
pnpm add -D @tanstack/react-query-devtools
```

- [ ] **Step 2: Confirm the dependency change**

```bash
grep -E '"swr"|"@tanstack/react-query"' apps/dashboard/package.json
```

Expected: `"@tanstack/react-query": "..."` present, `"swr"` absent.

- [ ] **Step 3: Verify SWR isn't imported anywhere**

```bash
grep -rn "from ['\"]swr['\"]" apps/dashboard --include='*.ts' --include='*.tsx'
```

Expected: no output. (If anything appears, it must be migrated before the next task — but the design's §1 footnote says only `lib/data/hooks.ts` would use SWR, and we never built that file.)

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml
git commit -m "build(dashboard): swap swr for @tanstack/react-query"
```

---

## Task 15: Dashboard — Providers + layout wrap

**Files:**
- Create: `apps/dashboard/app/providers.tsx`
- Modify: `apps/dashboard/app/layout.tsx`

- [ ] **Step 1: Write the providers component**

`apps/dashboard/app/providers.tsx`:

```tsx
"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

- [ ] **Step 2: Wrap `{children}` in `layout.tsx`**

In `apps/dashboard/app/layout.tsx`, add this import after the existing imports at the top:

```tsx
import { Providers } from "./providers";
```

Find:

```tsx
      <body>{children}</body>
```

Replace with:

```tsx
      <body>
        <Providers>{children}</Providers>
      </body>
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/app/providers.tsx apps/dashboard/app/layout.tsx
git commit -m "feat(dashboard): mount QueryClientProvider in root layout"
```

---

## Task 16: Dashboard — API client + query factories

**Files:**
- Create: `apps/dashboard/lib/api/client.ts`
- Create: `apps/dashboard/lib/api/overview.ts`

- [ ] **Step 1: Write the fetcher**

`apps/dashboard/lib/api/client.ts`:

```ts
const BASE = process.env.NEXT_PUBLIC_WORKER_BASE_URL ?? "";

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "omit" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 2: Write the query factories**

`apps/dashboard/lib/api/overview.ts`:

```ts
import { queryOptions } from "@tanstack/react-query";
import type {
  KpisResponse,
  EvalHealthResponse,
  LiveRunsResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";
import { get } from "./client";

export const overviewQueries = {
  kpis: () =>
    queryOptions({
      queryKey: ["overview", "kpis"] as const,
      queryFn: () => get<KpisResponse>("/api/v1/overview/kpis"),
      refetchInterval: 30_000,
    }),
  evalHealth: () =>
    queryOptions({
      queryKey: ["overview", "evalHealth"] as const,
      queryFn: () => get<EvalHealthResponse>("/api/v1/overview/eval-health"),
      refetchInterval: 60_000,
    }),
  liveRuns: () =>
    queryOptions({
      queryKey: ["runs", "live"] as const,
      queryFn: () =>
        get<LiveRunsResponse>("/api/v1/runs/live?status=running,awaiting"),
      refetchInterval: 3_000,
    }),
  recentRuns: (page: number, pageSize = 7) =>
    queryOptions({
      queryKey: ["runs", { page, pageSize }] as const,
      queryFn: () =>
        get<RunsResponse>(
          `/api/v1/runs?limit=${pageSize}&offset=${page * pageSize}`,
        ),
      refetchInterval: 15_000,
      placeholderData: (prev) => prev,
    }),
  workflows: (page: number, pageSize = 5) =>
    queryOptions({
      queryKey: ["workflows", { page, pageSize }] as const,
      queryFn: () =>
        get<WorkflowsResponse>(
          `/api/v1/workflows?limit=${pageSize}&offset=${page * pageSize}`,
        ),
      refetchInterval: 30_000,
      placeholderData: (prev) => prev,
    }),
};
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/lib/api
git commit -m "feat(dashboard): API client + TanStack Query factories for overview"
```

---

## Task 17: Dashboard — Add `disabled` prop to `CkKPI`

**Files:**
- Modify: `apps/dashboard/components/ui.tsx`

- [ ] **Step 1: Replace the `CkKPI` function**

In `apps/dashboard/components/ui.tsx`, find the existing `CkKPI` function (starting around line 134):

```tsx
export function CkKPI({
  label,
  value,
  sub,
  delta,
  deltaTone = "good",
  spark,
  sparkColor = "#3C43E7",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: "good" | "bad" | "neutral";
  spark?: number[];
  sparkColor?: string;
}) {
  const deltaToneClass =
    deltaTone === "good" ? "text-success-fg" : deltaTone === "bad" ? "text-fail-fg" : "text-neutral-700";
  return (
    <div className="bg-panel border border-neutral-200 rounded-sm py-4 px-[18px] flex flex-col gap-1.5 min-h-[124px]">
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="font-display font-semibold text-[32px] leading-none tracking-[-0.02em] text-coal">{value}</div>
        {sub && <div className="font-body font-medium text-sm leading-none text-neutral-700">{sub}</div>}
      </div>
      <div className="flex items-center justify-between mt-auto">
        {delta != null && (
          <div className={`font-mono text-[11px] ${deltaToneClass}`}>{delta}</div>
        )}
        {spark && (
          <div className="opacity-85" style={{ color: sparkColor }}>
            <Spark data={spark} stroke={sparkColor} fill={sparkColor} w={96} h={28} />
          </div>
        )}
      </div>
    </div>
  );
}
```

Replace the entire block with:

```tsx
export function CkKPI({
  label,
  value,
  sub,
  delta,
  deltaTone = "good",
  spark,
  sparkColor = "#3C43E7",
  disabled = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: "good" | "bad" | "neutral";
  spark?: number[];
  sparkColor?: string;
  disabled?: boolean;
}) {
  const deltaToneClass =
    deltaTone === "good" ? "text-success-fg" : deltaTone === "bad" ? "text-fail-fg" : "text-neutral-700";
  return (
    <div className="bg-panel border border-neutral-200 rounded-sm py-4 px-[18px] flex flex-col gap-1.5 min-h-[124px]">
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">{label}</div>
      <div className="flex items-baseline gap-2">
        {disabled ? (
          <div className="font-display font-semibold text-[32px] leading-none tracking-[-0.02em] text-neutral-400">N/A</div>
        ) : (
          <div className="font-display font-semibold text-[32px] leading-none tracking-[-0.02em] text-coal">{value}</div>
        )}
        {!disabled && sub && (
          <div className="font-body font-medium text-sm leading-none text-neutral-700">{sub}</div>
        )}
      </div>
      <div className="flex items-center justify-between mt-auto">
        {!disabled && delta != null && (
          <div className={`font-mono text-[11px] ${deltaToneClass}`}>{delta}</div>
        )}
        {!disabled && spark && (
          <div className="opacity-85" style={{ color: sparkColor }}>
            <Spark data={spark} stroke={sparkColor} fill={sparkColor} w={96} h={28} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/components/ui.tsx
git commit -m "feat(dashboard): CkKPI gains disabled state for N/A KPIs"
```

---

## Task 18: Dashboard — Rewire the Overview screen to live queries

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/overview.tsx`

This is the largest task — `overview.tsx` is ~620 lines. The implementation strategy:

1. Remove the `AIWF_DATA` import and the `D = AIWF_DATA` alias.
2. Convert sub-components (`EvalHealthKPI`, `NowRunningPanel`, `AwaitingInputPanel`) to accept their data as props.
3. In `OverviewScreen`, call the five `useQuery` hooks via `overviewQueries.*` and pass data downward.
4. Replace mock totals (`totalRuns`, `totalCost`, `totalErrors`, `sparkP95`, `sparkRuns`, `sparkErr`) — each `CkKPI` switches to `disabled` when its KPI field is `null`.
5. Recent runs table: when `recentRuns.data?.available === false` render an empty body with "Run history coming soon" and hide pagination.
6. Workflows table: replace `D.WORKFLOWS` with `workflows.data?.rows ?? []`. For each metric column, render `"—"` if the value is `null`. Render a flat baseline if `trend24h` is `null`.

### Step 1: Replace the imports + drop the `D` alias

Find the top of `apps/dashboard/components/cockpit/screens/overview.tsx`:

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
import { AIWF_DATA } from "@/lib/data/mock";
import { sparkSeries } from "@/lib/rng";
import { useCockpit } from "@/components/cockpit/context";
import type { Run } from "@/lib/types";

const D = AIWF_DATA;
```

Replace with:

```tsx
"use client";

import React, { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { overviewQueries } from "@/lib/api/overview";
import type { Run } from "@/lib/types";
import type { EvalHealthResponse } from "@shared/contracts";
```

- [ ] **Step 1 done.**

### Step 2: Replace `EvalHealthKPI`

Find the existing `EvalHealthKPI` function and replace it with:

```tsx
function EvalHealthKPI({ data }: { data: EvalHealthResponse | undefined }) {
  if (data?.available === true) {
    const total = data.pass + data.warn + data.fail || 1;
    return (
      <div className="bg-panel border border-neutral-200 rounded-sm px-[18px] py-4 flex flex-col gap-1.5 min-h-[124px]">
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">
            Eval health
          </div>
          <a className="font-mono text-[10px] text-mariner no-underline tracking-[0.04em] uppercase cursor-pointer">
            Detail →
          </a>
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <Donut
            shares={[data.pass / total, data.warn / total, data.fail / total]}
            colors={["#5BB04A", "#FFC800", "#D14343"]}
            size={64}
            thickness={10}
            centerLabel={data.score.toFixed(1)}
          />
          <div className="flex-1 flex flex-col gap-[3px]">
            <div className="flex items-center gap-1.5 font-body text-xs">
              <CkDot color="#5BB04A" />
              <span className="flex-1 text-neutral-800">Pass</span>
              <b className="font-mono text-neutral-900">{data.pass}</b>
            </div>
            <div className="flex items-center gap-1.5 font-body text-xs">
              <CkDot color="#FFC800" />
              <span className="flex-1 text-neutral-800">Warn</span>
              <b className="font-mono text-neutral-900">{data.warn}</b>
            </div>
            <div className="flex items-center gap-1.5 font-body text-xs">
              <CkDot color="#D14343" />
              <span className="flex-1 text-neutral-800">Fail</span>
              <b className="font-mono text-neutral-900">{data.fail}</b>
            </div>
          </div>
        </div>
        <div className="mt-auto font-mono text-[10px] text-neutral-500 tracking-[0.04em]">
          {data.spansGraded.toLocaleString("en-US")} spans graded · {data.windowHours}h
        </div>
      </div>
    );
  }

  const reason = data?.available === false ? data.reason : "Loading…";

  return (
    <div className="bg-panel border border-neutral-200 rounded-sm px-[18px] py-4 flex flex-col gap-1.5 min-h-[124px]">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-neutral-700">
          Eval health
        </div>
      </div>
      <div className="flex items-center gap-3 mt-0.5">
        <Donut
          shares={[1, 0, 0]}
          colors={["#E6E8EB", "#E6E8EB", "#E6E8EB"]}
          size={64}
          thickness={10}
          centerLabel="—"
        />
        <div className="flex-1 font-body text-xs text-neutral-500 leading-snug">
          {reason}
        </div>
      </div>
      <div className="mt-auto font-mono text-[10px] text-neutral-500 tracking-[0.04em]">
        —
      </div>
    </div>
  );
}
```

- [ ] **Step 2 done.**

### Step 3: Replace `NowRunningPanel`

Replace the existing `NowRunningPanel` with:

```tsx
function NowRunningPanel({
  rows,
  onOpenRun,
}: {
  rows: Run[];
  onOpenRun: (run: Run) => void;
}) {
  const running = rows.filter((r) => r.status === "running");

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <CkCard
      eyebrow="Vercel workflow · live"
      title="Now running"
      action={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-mariner tracking-[0.04em] uppercase">
          <span className="relative w-1.5 h-1.5">
            <span className="absolute inset-0 rounded-full bg-mariner" />
            <span className="absolute -inset-[3px] rounded-full border border-mariner animate-ck-pulse" />
          </span>
          {running.length} executing
        </span>
      }
      pad={0}
    >
      {running.length === 0 ? (
        <div className="px-5 py-8 text-center text-neutral-500 text-sm">No runs in flight</div>
      ) : (
        <div className="flex flex-col">
          {running.map((r, i) => {
            const elapsed = ((r.elapsed ?? 0) + tick).toFixed(1);
            const etaLeft = Math.max(0, (r.etaSec ?? 0) - tick);
            const progress = Math.min(0.99, (r.progress ?? 0) + tick * 0.02);
            return (
              <div
                key={r.id}
                onClick={() => onOpenRun(r)}
                className={`px-5 py-[14px] cursor-pointer transition-colors duration-100 hover:bg-off-white ${i < running.length - 1 ? "border-b border-neutral-200" : ""}`}
              >
                <div className="flex items-center gap-2.5 mb-2 flex-wrap">
                  <CkStatusPill status="running" />
                  <span className="font-body text-sm font-semibold text-neutral-900">
                    {r.workflowName}
                  </span>
                  <CkChip tone="blocked">{r.ticket}</CkChip>
                  <span className="ml-auto inline-flex items-center gap-2.5 font-mono text-[11px] text-neutral-700">
                    {r.elapsed != null && <span>{elapsed}s</span>}
                    {r.etaSec != null && <span className="text-neutral-500">· ETA {etaLeft}s</span>}
                  </span>
                </div>
                {r.currentSpan && (
                  <>
                    <div className="flex items-center gap-2.5">
                      <div className="flex-1 h-1.5 bg-app-bg rounded-[1px] relative overflow-hidden">
                        <div
                          className="h-full bg-mariner rounded-[1px] transition-[width] duration-1000 ease-linear relative"
                          style={{ width: progress * 100 + "%" }}
                        >
                          <span
                            className="absolute inset-0 animate-ck-shimmer"
                            style={{
                              background:
                                "linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)",
                            }}
                          />
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-neutral-500 w-[58px] text-right">
                        {r.spanIndex ?? "—"}/{r.spansTotal ?? "—"}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px]">
                      <span
                        className="w-2 h-2 rounded-[1px]"
                        style={{ background: spanColor(r.currentSpanKind) }}
                      />
                      <span className="text-neutral-900 font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                        {r.currentSpan}
                      </span>
                      <span className="ml-auto text-neutral-500 whitespace-nowrap">
                        {r.model}
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CkCard>
  );
}
```

- [ ] **Step 3 done.**

### Step 4: Replace `AwaitingInputPanel`

Replace the existing `AwaitingInputPanel` with:

```tsx
function AwaitingInputPanel({
  rows,
  onOpenRun,
}: {
  rows: Run[];
  onOpenRun: (run: Run) => void;
}) {
  const awaiting = rows.filter((r) => r.status === "awaiting");
  return (
    <CkCard
      eyebrow="Human-in-the-loop"
      title="Input needed"
      action={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-[#A2351C] tracking-[0.04em] uppercase">
          <span className="relative w-1.5 h-1.5">
            <span className="absolute inset-0 rounded-full bg-burnt-orange" />
            <span className="absolute -inset-[3px] rounded-full border border-burnt-orange animate-ck-pulse" />
          </span>
          {awaiting.length} paused
        </span>
      }
      pad={0}
      style={{ background: "#FFFCFA", borderColor: "#FFE4D6" }}
    >
      {awaiting.length === 0 ? (
        <div className="px-5 py-8 text-center text-neutral-500 text-sm">No clarifications pending</div>
      ) : (
        <div className="flex flex-col">
          {awaiting.map((r, i) => (
            <div
              key={r.id}
              className={`px-5 py-[14px] ${i < awaiting.length - 1 ? "border-b border-[#FFE4D6]" : ""}`}
            >
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <CkStatusPill status="awaiting" />
                <span
                  onClick={() => onOpenRun(r)}
                  className="font-body text-sm font-semibold text-neutral-900 cursor-pointer"
                >
                  {r.workflowName}
                </span>
                <CkChip
                  style={{
                    background: "#fff",
                    color: "#5F666F",
                    border: "1px solid #E6E8EB",
                  }}
                >
                  {r.ticket}
                </CkChip>
                {r.questionFor && <CkChip tone="warn">@{r.questionFor}</CkChip>}
                {typeof r.askedAtMin === "number" && (
                  <span className="ml-auto font-mono text-[11px] text-neutral-500 whitespace-nowrap">
                    {r.askedAtMin}m ago
                  </span>
                )}
              </div>
              {r.question && (
                <p className="font-body font-normal text-[13px] leading-[1.55] text-neutral-800 m-0 mb-2.5 border-l-2 border-burnt-orange pl-3">
                  {r.question}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5 items-center">
                {r.suggestedAnswers?.map((a, j) => (
                  <button
                    key={j}
                    className="appearance-none border border-neutral-200 bg-panel px-2.5 py-[5px] rounded-[3px] cursor-pointer font-body text-xs text-neutral-900 transition-all duration-100 hover:bg-coal hover:text-white"
                  >
                    {a}
                  </button>
                ))}
                <button className="ml-auto appearance-none border border-coal bg-coal text-white px-3 py-[5px] rounded-[3px] cursor-pointer font-mono text-[11px] font-medium uppercase tracking-[0.04em]">
                  Reply →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </CkCard>
  );
}
```

- [ ] **Step 4 done.**

### Step 5: Replace the `OverviewScreen` body

Replace the entire body of `OverviewScreen` (everything after `export function OverviewScreen({...}: {...}) {` up to its closing `}`) with:

```tsx
  const { t } = useCockpit();

  const PAGE_SIZE = 7;
  const [runsPage, setRunsPage] = useState(0);
  const WF_PAGE_SIZE = 5;
  const [wfPage, setWfPage] = useState(0);

  const kpis = useQuery(overviewQueries.kpis());
  const evalHealth = useQuery(overviewQueries.evalHealth());
  const liveRuns = useQuery(overviewQueries.liveRuns());
  const recentRuns = useQuery(overviewQueries.recentRuns(runsPage, PAGE_SIZE));
  const workflows = useQuery(overviewQueries.workflows(wfPage, WF_PAGE_SIZE));

  const liveRows = liveRuns.data?.rows ?? [];
  const recentData = recentRuns.data;
  const wfData = workflows.data;
  const wfRows = wfData?.rows ?? [];
  const wfTotalPages = Math.max(
    1,
    Math.ceil((wfData?.total ?? 0) / WF_PAGE_SIZE),
  );

  const heroRuns = kpis.data?.runs24h;
  const heroCost = kpis.data?.cost24h;
  const heroP95 = kpis.data?.p95;
  const heroErrors = kpis.data?.errors24h;
  const heroEval = evalHealth.data?.available === true ? evalHealth.data : null;

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
              Overview · {kpis.data?.generatedAt ? new Date(kpis.data.generatedAt).toLocaleTimeString() : "—"}
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
        <EvalHealthKPI data={evalHealth.data} />
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
        <NowRunningPanel rows={liveRows} onOpenRun={onOpenRun} />
        <AwaitingInputPanel rows={liveRows} onOpenRun={onOpenRun} />
      </div>

      {/* Recent runs */}
      <CkCard
        eyebrow="Run timeline · last 24h"
        title="Recent runs"
        action={
          recentData?.available ? (
            <div className="flex items-center gap-2">
              <CkChip tone="success">{recentData.counts.success} shipped</CkChip>
              <CkChip tone="running">{recentData.counts.running} running</CkChip>
              <CkChip tone="awaiting">{recentData.counts.awaiting} awaiting</CkChip>
            </div>
          ) : null
        }
        pad={0}
      >
        {!recentData || recentData.available === false ? (
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
                {recentData.rows.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => onOpenRun(r)}
                    className={`cursor-pointer transition-colors duration-100 hover:bg-off-white ${i < recentData.rows.length - 1 ? "border-b border-neutral-200" : ""}`}
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
              totalPages={Math.max(1, Math.ceil(recentData.total / PAGE_SIZE))}
              total={recentData.total}
              start={runsPage * PAGE_SIZE}
              shown={recentData.rows.length}
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
          total={wfData?.total ?? 0}
          start={wfPage * WF_PAGE_SIZE}
          shown={wfRows.length}
          onChange={setWfPage}
        />
      </CkCard>
    </div>
  );
```

- [ ] **Step 5 done.**

### Step 6: Type-check the dashboard

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: exit 0. If anything still references `D` (the deleted `AIWF_DATA` alias) or `sparkSeries`, fix those references before continuing — those should have been replaced by query data above.

### Step 7: Commit

```bash
git add apps/dashboard/components/cockpit/screens/overview.tsx
git commit -m "feat(dashboard): Overview reads from worker via TanStack Query"
```

---

## Task 19: Dashboard — Delete empty `app/api/` placeholders

**Files:**
- Delete: `apps/dashboard/app/api/`

- [ ] **Step 1: Confirm every subfolder is empty**

```bash
find apps/dashboard/app/api -type f
```

Expected: no output. If any file appears, **stop**. The folder is no longer purely a placeholder; ask the user how to proceed.

- [ ] **Step 2: Delete the folder**

```bash
rm -rf apps/dashboard/app/api
```

- [ ] **Step 3: Commit**

```bash
git add -A apps/dashboard/app
git commit -m "chore(dashboard): remove unused app/api placeholder folders"
```

---

## Task 20: Verification — end-to-end smoke

No commit; this task confirms the wiring.

- [ ] **Step 1: Repo-wide typecheck**

Run: `cd /Users/kacper/Desktop/blazity/ai-workflow && pnpm -w typecheck`
Expected: exit 0 for both apps.

- [ ] **Step 2: Worker unit tests**

Run: `cd apps/worker && pnpm test`
Expected: all suites pass, including `src/lib/overview/collect-live-runs.test.ts`.

- [ ] **Step 3: Boot the worker on :3000**

```bash
cd apps/worker && DASHBOARD_ORIGIN=http://localhost:3001 pnpm dev
```

Leave it running.

- [ ] **Step 4: Boot the dashboard on :3001**

In a second shell:

```bash
cd apps/dashboard && NEXT_PUBLIC_WORKER_BASE_URL=http://localhost:3000 pnpm dev -- -p 3001
```

(`-p 3001` keeps the dashboard off the worker's port.)

- [ ] **Step 5: Browser checks at http://localhost:3001**

Confirm:
- The three numeric KPI cards (Runs · 24h, p95, Errors · 24h) render `N/A` with muted styling, no sparkline, no delta.
- The Eval Health card shows an outlined donut + the "Eval grading not wired up yet." caption.
- The "Now running" card shows either a real in-flight ticket row (with ticketTitle and ticket key) or the "No runs in flight" empty state.
- The "Input needed" card shows "No clarifications pending".
- The Recent runs card body shows "Run history coming soon" with no pagination controls.
- The Workflows card shows three rows in order: `Agent` (with the `primary` chip), `Pre-sandbox`, `Post-PR gate`. Every metric column shows `—`. The sparkline cell is a flat baseline.

- [ ] **Step 6: DevTools network checks**

Open the browser's Network tab and confirm:
- Periodic GET requests to `http://localhost:3000/api/v1/{overview/kpis, overview/eval-health, runs, runs/live, workflows}` at roughly the expected intervals (3s for `runs/live`, 15s for `runs`, 30s for `kpis`/`workflows`, 60s for `eval-health`).
- All responses are `200` JSON.
- Response headers include `access-control-allow-origin: http://localhost:3001` and `vary: Origin`.

- [ ] **Step 7: Worker-down fallback**

In the worker's shell, press `Ctrl-C`. Reload the dashboard. Confirm:
- No crash; panels remain in their N/A states.
- The console logs fetch errors but the page is interactive.

- [ ] **Step 8: Restart and re-confirm**

Restart the worker (re-run the command in step 3). Confirm the dashboard re-fetches and the live panels populate again.

(No commit — verification only.)

---

## Acceptance

This plan is complete when:

1. `pnpm -w typecheck` passes.
2. `cd apps/worker && pnpm test` passes (including the new `collect-live-runs.test.ts` suite).
3. The Overview screen at `http://localhost:3001` renders against a live worker with the documented `N/A` and empty states, and any real in-flight ticket appears in "Now running".
4. No code on the Overview path imports `apps/dashboard/lib/data/mock.ts`.
