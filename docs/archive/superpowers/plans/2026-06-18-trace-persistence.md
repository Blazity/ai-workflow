# Trace Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the per-run step waterfall into Postgres on completion and read finished traces from Postgres, so trace data lives in one place alongside the rest of `workflow_runs`.

**Architecture:** Hybrid read — `world` stays the source for in-flight runs; finished runs read their persisted waterfall from a new `workflow_runs.steps` JSONB column. The agent workflow captures the waterfall (best-effort) on every exit via its existing telemetry step. Pre-migration runs with no persisted steps keep today's coarse phase-synthesis fallback.

**Tech Stack:** TypeScript, Nitro/h3, Drizzle ORM + Neon Postgres (PGlite in tests), Vitest, Vercel Workflow runtime (`getWorld()`), `@shared/contracts` types.

**Spec:** `apps/worker/docs/superpowers/specs/2026-06-18-trace-persistence-design.md`

All paths below are relative to `apps/worker/`. Run all commands from `apps/worker/`.

## Global Constraints

- Telemetry is best-effort: the capture must NEVER throw, retry, or delay the run. `recordRunTelemetryStep.maxRetries = 0` and its caller swallows errors — keep both.
- Persisted steps are the `RunStep[]` contract verbatim (string timestamps) — JSON-safe, no transformation on read.
- `recordRunUsage` and `upsertRunSnapshots` own disjoint columns of `workflow_runs`; `steps` is workflow-owned (written only by `recordRunUsage`). The cron writer must not touch it.
- The test harness (`db/test-db.ts`) replays committed `drizzle/*.sql` files into PGlite — a new column only exists in tests once its migration file is committed. Generate the migration before writing column-dependent tests.
- `RunStatus` terminal states: `"success" | "failed" | "blocked"`.

---

### Task 1: Add `steps` column + migration

**Files:**
- Modify: `src/db/schema.ts` (the `workflowRuns` table, after `phases`)
- Create: `drizzle/0003_*.sql` (generated)

**Interfaces:**
- Produces: `workflowRuns.steps` (jsonb, nullable) — the persisted `RunStep[]` waterfall.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, add `steps` immediately after the `phases` column (line ~160):

```ts
  /** Per-phase breakdown: { [phase]: { costUsd, tokens, durationMs, numTurns } }. */
  phases: jsonb("phases"),
  /** Full RunStep[] trace waterfall, captured on completion (workflow-owned). */
  steps: jsonb("steps"),
```

(`jsonb` is already imported — it backs `phases`.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `drizzle/0003_<random-name>.sql` containing
`ALTER TABLE "workflow_runs" ADD COLUMN "steps" jsonb;`, plus an updated `drizzle/meta/` snapshot.

- [ ] **Step 3: Verify the existing suite still applies the migration cleanly**

Run: `pnpm test`
Expected: PASS (PGlite replays `0000`→`0003`; no existing test references `steps` yet, so all stay green). This proves the migration is valid SQL.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add workflow_runs.steps jsonb column for trace persistence"
```

---

### Task 2: Persist `steps` in `recordRunUsage`

**Files:**
- Modify: `src/lib/telemetry/run-telemetry.ts` (`RunUsage`, `recordRunUsage`)
- Test: `src/lib/telemetry/run-telemetry.test.ts`

**Interfaces:**
- Consumes: `workflowRuns.steps` (Task 1).
- Produces: `RunUsage.steps: RunStep[] | null` — written on insert; preserved on conflict.

- [ ] **Step 1: Add `steps` to the `usage()` test factory default**

In `src/lib/telemetry/run-telemetry.test.ts`, add to the `usage()` factory object (after `prNumber: 7,`):

```ts
  steps: null,
```

- [ ] **Step 2: Write the failing tests**

Append inside the `describe("recordRunUsage", ...)` block in `src/lib/telemetry/run-telemetry.test.ts`:

```ts
  it("persists the captured step waterfall", async () => {
    const steps = [
      {
        stepId: "s1",
        name: "provisionSandbox",
        rawName: "step//provisionSandbox",
        status: "completed" as const,
        attempt: 1,
        createdAt: "2026-06-15T10:00:00Z",
        startedAt: "2026-06-15T10:00:00Z",
        completedAt: "2026-06-15T10:00:15Z",
        startOffsetMs: 0,
        durationMs: 15_000,
        error: null,
      },
    ];
    await recordRunUsage(db, usage({ steps }));
    expect((await row("wrun_1")).steps).toEqual(steps);
  });

  it("does not erase a captured waterfall when a later write has null steps", async () => {
    const steps = [
      {
        stepId: "s1",
        name: "doThing",
        rawName: "step//doThing",
        status: "completed" as const,
        attempt: 1,
        createdAt: "2026-06-15T10:00:00Z",
        startedAt: "2026-06-15T10:00:00Z",
        completedAt: "2026-06-15T10:00:05Z",
        startOffsetMs: 0,
        durationMs: 5_000,
        error: null,
      },
    ];
    await recordRunUsage(db, usage({ steps }));
    await recordRunUsage(db, usage({ steps: null }));
    expect((await row("wrun_1")).steps).toEqual(steps);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- run-telemetry`
Expected: FAIL — `steps` is not yet a field on `RunUsage` (type error) / persisted value is `null`.

- [ ] **Step 4: Implement**

In `src/lib/telemetry/run-telemetry.ts`:

Add the contract import at the top:

```ts
import type { RunStep } from "@shared/contracts";
```

Add the field to `RunUsage` (after `phases: unknown;`):

```ts
  /** Full step waterfall captured from the world on completion; null if capture failed. */
  steps: RunStep[] | null;
```

In `recordRunUsage`, add to the `.values({ ... })` object (after `phases: usage.phases,`):

```ts
      steps: usage.steps,
```

In the same function's `.onConflictDoUpdate({ set: { ... } })` (after `phases: sql\`excluded.phases\`,`):

```ts
        // Workflow-owned and capture is best-effort: never erase a good
        // waterfall with a later null (a re-record whose world capture failed).
        steps: keepIfNull(workflowRuns.steps, workflowRuns.steps),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- run-telemetry`
Expected: PASS (new tests + all existing `recordRunUsage`/`upsertRunSnapshots` tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/telemetry/run-telemetry.ts src/lib/telemetry/run-telemetry.test.ts
git commit -m "feat(telemetry): persist captured step waterfall in recordRunUsage"
```

---

### Task 3: Read real steps from the DB (prefer + normalize + `hasRealSteps`)

**Files:**
- Modify: `src/db/queries/run-detail-read.ts` (`fetchRunDetailFromDb`)
- Test: `src/db/queries/run-detail-read.test.ts`

**Interfaces:**
- Consumes: `workflowRuns.steps` (Task 1).
- Produces: `fetchRunDetailFromDb(...)` now returns `{ run: RunDetail; steps: RunStep[]; hasRealSteps: boolean } | null`. `hasRealSteps` is `true` only when persisted real steps were used (vs coarse phase synthesis). For finished runs, any still-running/pending persisted step is normalized to `completed`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("fetchRunDetailFromDb", ...)` in `src/db/queries/run-detail-read.test.ts`:

```ts
  it("prefers persisted real steps over phase synthesis", async () => {
    const steps = [
      {
        stepId: "s1",
        name: "provisionSandbox",
        rawName: "step//provisionSandbox",
        status: "completed",
        attempt: 1,
        createdAt: "2026-06-16T10:00:00Z",
        startedAt: "2026-06-16T10:00:00Z",
        completedAt: "2026-06-16T10:00:15Z",
        startOffsetMs: 0,
        durationMs: 15_000,
        error: null,
      },
    ];
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      completedAt: new Date("2026-06-16T10:05:00Z"),
      steps,
      phases: { Setup: { durationMs: 10_000 } }, // present but must be ignored
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.hasRealSteps).toBe(true);
    expect(res?.steps.map((s) => s.name)).toEqual(["provisionSandbox"]);
  });

  it("normalizes a still-running step in a finished run to completed", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      status: "success",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      completedAt: new Date("2026-06-16T10:05:00Z"),
      steps: [
        {
          stepId: "s1",
          name: "recordRunTelemetry",
          rawName: "step//recordRunTelemetry",
          status: "running",
          attempt: 1,
          createdAt: "2026-06-16T10:04:50Z",
          startedAt: "2026-06-16T10:04:50Z",
          completedAt: null,
          startOffsetMs: 290_000,
          durationMs: null,
          error: null,
        },
      ],
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.steps[0].status).toBe("completed");
    expect(res?.steps[0].completedAt).toBe("2026-06-16T10:05:00.000Z");
    expect(res?.steps[0].durationMs).toBe(10_000);
  });

  it("reports hasRealSteps=false when falling back to phase synthesis", async () => {
    await db.insert(workflowRuns).values({
      runId: "r1",
      startedAt: new Date("2026-06-16T10:00:00Z"),
      phases: { Setup: { durationMs: 10_000 } },
    });
    const res = await fetchRunDetailFromDb({ db, runId: "r1", ...base });
    expect(res?.hasRealSteps).toBe(false);
    expect(res?.steps.map((s) => s.name)).toEqual(["Setup"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- run-detail-read`
Expected: FAIL — `hasRealSteps` is `undefined`; real steps not returned.

- [ ] **Step 3: Implement**

In `src/db/queries/run-detail-read.ts`:

Add a terminal-status set and a normalizer near the top (after the imports / `PHASE_ORDER`):

```ts
const TERMINAL = new Set(["success", "failed", "blocked"]);

/**
 * A finished run's persisted waterfall may contain the telemetry step itself,
 * captured mid-flight (status "running"). Present it as completed at the run's
 * completion so a finished trace shows no dangling in-progress step.
 */
function normalizeFinishedSteps(steps: RunStep[], completedAtIso: string | null): RunStep[] {
  return steps.map((s) => {
    if (s.status !== "running" && s.status !== "pending") return s;
    const completedAt = s.completedAt ?? completedAtIso;
    const durationMs =
      s.durationMs ??
      (s.startedAt && completedAt
        ? Math.max(0, new Date(completedAt).getTime() - new Date(s.startedAt).getTime())
        : null);
    return { ...s, status: "completed" as const, completedAt, durationMs };
  });
}
```

Change the `fetchRunDetailFromDb` return type:

```ts
export async function fetchRunDetailFromDb(
  opts: FetchRunDetailFromDbOptions,
): Promise<{ run: RunDetail; steps: RunStep[]; hasRealSteps: boolean } | null> {
```

Replace the final `return { run, steps: phasesToSteps(row.phases, base) };` with:

```ts
  const persisted = Array.isArray(row.steps) ? (row.steps as RunStep[]) : null;
  if (persisted && persisted.length > 0) {
    const steps = TERMINAL.has(run.status)
      ? normalizeFinishedSteps(persisted, run.completedAt)
      : persisted;
    return { run, steps, hasRealSteps: true };
  }
  return { run, steps: phasesToSteps(row.phases, base), hasRealSteps: false };
```

(`RunStep` is already imported on line 2; `run.completedAt` is the ISO string already built into the `run` header.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- run-detail-read`
Expected: PASS (new tests + all existing `fetchRunDetailFromDb`/`fetchRunRefs` tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/run-detail-read.ts src/db/queries/run-detail-read.test.ts
git commit -m "feat(db): prefer persisted real steps in fetchRunDetailFromDb"
```

---

### Task 4: `captureRunStepsBestEffort` helper

**Files:**
- Modify: `src/lib/overview/collect-run-detail.ts` (add export)
- Test: `src/lib/overview/collect-run-detail.test.ts`

**Interfaces:**
- Consumes: `collectRunDetail`, `RunDetailSource` (existing).
- Produces: `captureRunStepsBestEffort(world: RunDetailSource, runId: string): Promise<RunStep[] | null>` — reuses `collectRunDetail` for an identical mapping, discards the header, returns `null` on any world failure (never throws).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/overview/collect-run-detail.test.ts`. First extend the import at the top of the file to include the new symbol:

```ts
import {
  collectRunDetail,
  captureRunStepsBestEffort,
  type RunDetailSource,
  type WorkflowRunRecord,
  type WorkflowStepRecord,
} from "./collect-run-detail.js";
```

Then add a new describe block at the end:

```ts
describe("captureRunStepsBestEffort", () => {
  it("returns the mapped step waterfall", async () => {
    const source = makeSource({ runId: "run_a", startedAt: RUN_START }, [
      step({
        stepId: "s1",
        stepName: STEP("provisionSandbox"),
        startedAt: RUN_START,
        completedAt: new Date("2026-06-02T11:00:15.000Z"),
      }),
    ]);
    const steps = await captureRunStepsBestEffort(source, "run_a");
    expect(steps?.map((s) => s.name)).toEqual(["provisionSandbox"]);
  });

  it("returns null when the world throws", async () => {
    const source: RunDetailSource = {
      runs: { get: vi.fn().mockRejectedValue(new Error("expired")) },
      steps: { list: vi.fn().mockResolvedValue({ data: [] }) },
    };
    expect(await captureRunStepsBestEffort(source, "run_a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- collect-run-detail`
Expected: FAIL — `captureRunStepsBestEffort` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/overview/collect-run-detail.ts` (after `collectRunDetail`):

```ts
/**
 * Capture just the step waterfall for a run, reusing collectRunDetail so the
 * persisted shape is identical to the live read. Best-effort: returns null on
 * any world failure (expired run / world unavailable) so the caller — the
 * agent's telemetry step — never throws. The header is discarded, so the model
 * arg is irrelevant.
 */
export async function captureRunStepsBestEffort(
  world: RunDetailSource,
  runId: string,
): Promise<RunStep[] | null> {
  try {
    const { steps } = await collectRunDetail({ world, model: "", runId });
    return steps;
  } catch {
    return null;
  }
}
```

(`RunStep` is already imported on line 2.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- collect-run-detail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/overview/collect-run-detail.ts src/lib/overview/collect-run-detail.test.ts
git commit -m "feat(trace): add captureRunStepsBestEffort helper"
```

---

### Task 5: `resolveRunDetail` source-selection function

**Files:**
- Create: `src/lib/overview/resolve-run-detail.ts`
- Test: `src/lib/overview/resolve-run-detail.test.ts`

**Interfaces:**
- Produces: `resolveRunDetail(opts: { dbDetail: RunDetailParts | null; loadWorld: () => Promise<{ run: RunDetail; steps: RunStep[] }> }): Promise<{ run: RunDetail; steps: RunStep[] } | null>`, where `RunDetailParts = { run: RunDetail; steps: RunStep[]; hasRealSteps: boolean }`.
- Behavior: real persisted steps → return them WITHOUT calling `loadWorld`; else call `loadWorld`; if `loadWorld` throws → coarse `dbDetail` if present, else `null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/overview/resolve-run-detail.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { RunDetail, RunStep } from "@shared/contracts";
import { resolveRunDetail, type RunDetailParts } from "./resolve-run-detail.js";

const RUN = (id: string): RunDetail => ({
  id,
  workflow: "wf_agent",
  workflowName: "Agent",
  status: "success",
  ticket: "",
  ticketTitle: "",
  ticketUrl: "",
  prNumber: null,
  prUrl: null,
  model: "m",
  createdAt: "2026-06-16T10:00:00Z",
  startedAt: "2026-06-16T10:00:00Z",
  completedAt: "2026-06-16T10:05:00Z",
  durationSec: 300,
  error: null,
  deploymentId: null,
});
const STEPS = (name: string): RunStep[] => [
  {
    stepId: name,
    name,
    rawName: name,
    status: "completed",
    attempt: 1,
    createdAt: "2026-06-16T10:00:00Z",
    startedAt: "2026-06-16T10:00:00Z",
    completedAt: "2026-06-16T10:00:01Z",
    startOffsetMs: 0,
    durationMs: 1000,
    error: null,
  },
];
const parts = (hasRealSteps: boolean): RunDetailParts => ({
  run: RUN("db"),
  steps: STEPS("db"),
  hasRealSteps,
});

describe("resolveRunDetail", () => {
  it("returns persisted steps and never touches the world when hasRealSteps", async () => {
    const loadWorld = vi.fn();
    const res = await resolveRunDetail({ dbDetail: parts(true), loadWorld });
    expect(loadWorld).not.toHaveBeenCalled();
    expect(res?.steps[0].name).toBe("db");
  });

  it("loads the world when there are no real persisted steps", async () => {
    const res = await resolveRunDetail({
      dbDetail: parts(false),
      loadWorld: async () => ({ run: RUN("world"), steps: STEPS("world") }),
    });
    expect(res?.steps[0].name).toBe("world");
  });

  it("falls back to coarse db detail when the world load throws", async () => {
    const res = await resolveRunDetail({
      dbDetail: parts(false),
      loadWorld: async () => {
        throw new Error("expired");
      },
    });
    expect(res?.steps[0].name).toBe("db");
  });

  it("returns null when the world throws and there is no db detail", async () => {
    const res = await resolveRunDetail({
      dbDetail: null,
      loadWorld: async () => {
        throw new Error("expired");
      },
    });
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- resolve-run-detail`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/overview/resolve-run-detail.ts`:

```ts
import type { RunDetail, RunStep } from "@shared/contracts";

export interface RunDetailParts {
  run: RunDetail;
  steps: RunStep[];
  hasRealSteps: boolean;
}

/**
 * Pick the trace source. Persisted real steps (a finished run) win and skip the
 * world entirely — this is the "one place" read. Otherwise load the live world
 * waterfall (an in-flight run); if that fails (run aged out of the ~24h window,
 * or world unavailable) fall back to the coarse db detail, or null if there is
 * no row at all.
 */
export async function resolveRunDetail(opts: {
  dbDetail: RunDetailParts | null;
  loadWorld: () => Promise<{ run: RunDetail; steps: RunStep[] }>;
}): Promise<{ run: RunDetail; steps: RunStep[] } | null> {
  const { dbDetail, loadWorld } = opts;
  if (dbDetail?.hasRealSteps) {
    return { run: dbDetail.run, steps: dbDetail.steps };
  }
  try {
    return await loadWorld();
  } catch {
    return dbDetail ? { run: dbDetail.run, steps: dbDetail.steps } : null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- resolve-run-detail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/overview/resolve-run-detail.ts src/lib/overview/resolve-run-detail.test.ts
git commit -m "feat(trace): add resolveRunDetail source-selection"
```

---

### Task 6: Capture the waterfall in the agent's telemetry step

**Files:**
- Modify: `src/workflows/agent.ts` (`recordRunTelemetryStep`)

**Interfaces:**
- Consumes: `captureRunStepsBestEffort` (Task 4), `RunUsage.steps` (Task 2), `getWorld()` from `workflow/runtime`.
- Produces: every run records its captured `steps` (or `null`) via `recordRunUsage`.

> No new unit test: this is runtime glue around `getWorld()`, which cannot be exercised without the workflow runtime. The capture logic is covered by Task 4's helper tests; the gate here is typecheck + the full suite staying green. The `runId`-self-capture assumption (`getWorld().runs.get(<own runId>)` while the run executes) is verified end-to-end on deploy by opening a finished run's trace.

- [ ] **Step 1: Capture steps inside `recordRunTelemetryStep`**

In `src/workflows/agent.ts`, inside `recordRunTelemetryStep`, after the existing dynamic imports of `getDb` and `recordRunUsage` (around line 548), add the capture:

```ts
  const { getWorld } = await import("workflow/runtime");
  const { captureRunStepsBestEffort, type RunDetailSource } = await import(
    "../lib/overview/collect-run-detail.js"
  );
  const steps = await captureRunStepsBestEffort(
    getWorld() as unknown as RunDetailSource,
    payload.runId,
  );
```

> If `import { ..., type RunDetailSource }` in a dynamic import is rejected by the TS config, split it: `const mod = await import("../lib/overview/collect-run-detail.js");` then `mod.captureRunStepsBestEffort(getWorld() as unknown as import("../lib/overview/collect-run-detail.js").RunDetailSource, payload.runId)`.

- [ ] **Step 2: Pass `steps` into `recordRunUsage`**

In the same function's `await recordRunUsage(getDb(), { ... })` call, add (after `prNumber: payload.pr?.number ?? null,`):

```ts
    steps,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/agent.ts
git commit -m "feat(agent): capture step waterfall into telemetry on completion"
```

---

### Task 7: Wire the read path (`[runId]` route)

**Files:**
- Modify: `src/routes/api/v1/runs/[runId].get.ts`

**Interfaces:**
- Consumes: `fetchRunDetailFromDb` (Task 3), `resolveRunDetail` (Task 5), `collectRunDetail`/`RunDetailSource`/`fetchRunRefs` (existing), `getWorld`, `getDb`.
- Behavior: finished run with persisted steps → Postgres (no world call); in-flight → world (refs enriched as today); world failure → coarse db fallback / EMPTY.

> No new unit test: the handler is h3 glue. Its decision logic is unit-tested in Task 5 (`resolveRunDetail`) and Task 3 (`fetchRunDetailFromDb`); the gate is typecheck + the full suite.

- [ ] **Step 1: Add the import**

In `src/routes/api/v1/runs/[runId].get.ts`, add to the imports:

```ts
import { resolveRunDetail } from "../../../../lib/overview/resolve-run-detail.js";
```

- [ ] **Step 2: Replace the handler body**

Replace the body of the `try` block (the `const [{ run, steps }, refs] = ...` block through `return { generatedAt, available: true, run, steps };`, lines ~31-54) with:

```ts
    const model =
      env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;

    // Read the durable row first: it carries the persisted waterfall (finished
    // runs) plus the ticket/PR refs the world lacks, and is the coarse fallback.
    const dbDetail = await fetchRunDetailFromDb({
      db: getDb(),
      runId,
      jiraBaseUrl: env.JIRA_BASE_URL,
      modelFallback: model,
    }).catch(() => null);

    const result = await resolveRunDetail({
      dbDetail,
      // In-flight runs: the world carries the live lifecycle + step waterfall but
      // not the ticket (encrypted input) or PR — merge those from the durable row.
      loadWorld: async () => {
        const [{ run, steps }, refs] = await Promise.all([
          collectRunDetail({
            world: getWorld() as unknown as RunDetailSource,
            model,
            runId,
          }),
          fetchRunRefs(getDb(), runId, env.JIRA_BASE_URL).catch(() => null),
        ]);
        run.prNumber = refs?.prNumber ?? null;
        run.prUrl = refs?.prUrl ?? null;
        if (refs?.ticketKey) {
          run.ticket = refs.ticketKey;
          run.ticketUrl = refs.ticketUrl ?? "";
          run.ticketTitle = refs.ticketTitle || refs.ticketKey;
        }
        return { run, steps };
      },
    });

    if (!result) return { generatedAt, ...EMPTY };
    return { generatedAt, available: true, run: result.run, steps: result.steps };
```

The outer `catch (err) { ... }` block stays as-is (defensive: logs `run_detail_failed` and returns its own db fallback / EMPTY on any unexpected throw). `resolveRunDetail` already handles the expected world-vs-db selection, so this catch now only fires on truly unexpected errors.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (Confirm `collectRunDetail`, `RunDetailSource`, `fetchRunDetailFromDb`, `fetchRunRefs`, `getWorld`, `getDb`, `logger`, `errorMessage` are all still imported/used — none should be orphaned.)

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/v1/runs/\[runId\].get.ts
git commit -m "feat(api): read finished traces from Postgres, world for in-flight"
```

---

## Final verification

- [ ] Run `pnpm typecheck && pnpm test` from `apps/worker/` — all green.
- [ ] Confirm no orphaned imports/functions: `fetchRunRefs` is still used (inside `loadWorld`); `errorMessage` still used by the outer catch.
- [ ] Manual/deploy check: open a finished run's trace — it renders the real waterfall from Postgres (verify by confirming the run is older than the world window, or temporarily disabling the world read locally). Open an in-flight run — it still updates near-real-time from the world.

## Self-review (plan vs spec)

- Spec §Storage → Task 1. §Write path → Tasks 2, 4, 6. §Shared/capture helper → Task 4. §Read path → Tasks 5, 7. §Backward compatibility → Task 3 (`hasRealSteps=false` phase fallback). §Known limitation (normalization) → Task 3 (`normalizeFinishedSteps`). §Testing → Tasks 2–5 (unit) + 6, 7 (typecheck+suite gates, rationale stated). No spec requirement left without a task.
- Type consistency: `RunDetailParts` (Task 5) matches `fetchRunDetailFromDb`'s return shape (Task 3: `{ run, steps, hasRealSteps }`). `RunUsage.steps: RunStep[] | null` (Task 2) matches `captureRunStepsBestEffort`'s return (Task 4). `resolveRunDetail`'s `loadWorld` returns `{ run, steps }`, matching what the route provides (Task 7).
