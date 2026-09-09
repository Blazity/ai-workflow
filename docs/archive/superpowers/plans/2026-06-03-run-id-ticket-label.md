# Run-ID Ticket Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a durable `run:<runId>` Jira label to each ticket on dispatch, and read those labels back in the dashboard so every run can be mapped to its ticket — even after the run completes and its workflow input is no longer decodable.

**Architecture:** Producer side adds the label in `dispatchTicket` right after the run is registered (best-effort, never fails the dispatch, labels accumulate). Consumer side, in `collectRuns`, issues one JQL query for the listed runs' labels, fetches the matching tickets, and builds a `runId → {ticketKey, title}` map used to resolve each run's ticket (falling back to the existing `extractTicket` for unlabeled/legacy runs).

**Tech Stack:** TypeScript, Nitro/h3 worker, Vitest, Jira REST v3, Vercel Workflow DevKit.

---

## File Structure

- `apps/worker/src/lib/labels.ts` — **Modify.** Add `RUN_LABEL_PREFIX` and `runLabel(runId)` helper alongside the existing `NEEDS_CLARIFICATION_LABEL`. Single home for label string construction, shared by producer and consumer.
- `apps/worker/src/lib/labels.test.ts` — **Create.** Unit test for `runLabel`.
- `apps/worker/src/lib/dispatch.ts` — **Modify.** Producer: add the label after `runRegistry.register(...)`.
- `apps/worker/src/lib/dispatch.test.ts` — **Modify.** Add producer tests.
- `apps/worker/src/lib/overview/collect-runs.ts` — **Modify.** Consumer: add `projectKey` option, `buildRunLabelMap`, and label-first ticket resolution.
- `apps/worker/src/lib/overview/collect-runs.test.ts` — **Modify.** Thread `projectKey` through existing calls; add resolution/fallback/empty tests.
- `apps/worker/src/routes/api/v1/runs.get.ts` — **Modify.** Pass `projectKey: env.JIRA_PROJECT_KEY` into `collectRuns`.

**Test command (run from repo root):** `pnpm --filter worker exec vitest run <path>`
**Full worker suite:** `pnpm --filter worker test`
**Typecheck:** `pnpm --filter worker typecheck`

---

## Task 1: Run-label helper

**Files:**
- Modify: `apps/worker/src/lib/labels.ts`
- Test: `apps/worker/src/lib/labels.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/lib/labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RUN_LABEL_PREFIX, runLabel } from "./labels.js";

describe("runLabel", () => {
  it("prefixes the run id with the run-label prefix", () => {
    expect(runLabel("run_123")).toBe("run:run_123");
    expect(runLabel("run_123").startsWith(RUN_LABEL_PREFIX)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/lib/labels.test.ts`
Expected: FAIL — `RUN_LABEL_PREFIX`/`runLabel` are not exported from `./labels.js`.

- [ ] **Step 3: Add the helper**

Append to `apps/worker/src/lib/labels.ts` (after the existing `NEEDS_CLARIFICATION_LABEL` export):

```ts
/**
 * Label prefix + builder for the run-id tag the dispatcher attaches to a ticket
 * when it starts a workflow. The dashboard reads these back to map a ticket to
 * the run(s) that processed it (see overview/collect-runs). Labels accumulate
 * (add-only), so a re-processed ticket carries one `run:<id>` label per run.
 */
export const RUN_LABEL_PREFIX = "run:";
export const runLabel = (runId: string): string =>
  `${RUN_LABEL_PREFIX}${runId}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/lib/labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/labels.ts apps/worker/src/lib/labels.test.ts
git commit -m "feat: add runLabel helper for run-id ticket labels"
```

---

## Task 2: Producer — write the label on dispatch

**Files:**
- Modify: `apps/worker/src/lib/dispatch.ts` (import + insert after line 159)
- Test: `apps/worker/src/lib/dispatch.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the `describe("dispatchTicket", ...)` block in `apps/worker/src/lib/dispatch.test.ts` (e.g. right after the first test, the one titled "dispatches agentWorkflow for a ticket in configured project + AI column"):

```ts
it("adds a run:<id> label to the ticket after registering the run", async () => {
  const updateLabels = vi.fn().mockResolvedValue(undefined);
  const adapters = makeAdapters();
  adapters.issueTracker.updateLabels = updateLabels;
  const { dispatchTicket } = await import("./dispatch.js");

  const result = await dispatchTicket("PROJ-42", adapters, 5);

  expect(result).toEqual({ started: true, runId: "run_123" });
  expect(adapters.runRegistry.register).toHaveBeenCalledWith(
    "PROJ-42",
    "run_123",
  );
  expect(updateLabels).toHaveBeenCalledWith("PROJ-42", {
    add: ["run:run_123"],
  });
});

it("still succeeds when adding the run label fails", async () => {
  const updateLabels = vi.fn().mockRejectedValue(new Error("Jira down"));
  const adapters = makeAdapters();
  adapters.issueTracker.updateLabels = updateLabels;
  const { dispatchTicket } = await import("./dispatch.js");

  const result = await dispatchTicket("PROJ-42", adapters, 5);

  expect(result).toEqual({ started: true, runId: "run_123" });
  expect(updateLabels).toHaveBeenCalledWith("PROJ-42", {
    add: ["run:run_123"],
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter worker exec vitest run src/lib/dispatch.test.ts -t "run:"`
Expected: FAIL — `updateLabels` is never called (the production code does not add the label yet). The "still succeeds" test may pass for the wrong reason; both must pass after Step 3.

- [ ] **Step 3: Add the import**

In `apps/worker/src/lib/dispatch.ts`, add to the imports at the top (after the existing `import { logger } from "./logger.js";`):

```ts
import { runLabel } from "./labels.js";
```

- [ ] **Step 4: Add the label write after register**

In `apps/worker/src/lib/dispatch.ts`, replace this existing block:

```ts
    stage = "register_run";
    await runRegistry.register(ticketKey, handle.runId);
    return { started: true, runId: handle.runId };
```

with:

```ts
    stage = "register_run";
    await runRegistry.register(ticketKey, handle.runId);

    // Durable ticket↔run mapping: tag the ticket with its runId so the
    // dashboard (and operators in Jira) can recover which run processed it,
    // even after the run completes and its encrypted workflow input is no
    // longer decodable. Best-effort — the workflow has already started, so a
    // label failure must not fail the dispatch. Add-only: labels accumulate so
    // a re-dispatched ticket keeps one `run:<id>` label per run.
    await issueTracker
      .updateLabels?.(ticketKey, { add: [runLabel(handle.runId)] })
      .catch((err: unknown) =>
        logger.warn(
          { ticketKey, runId: handle.runId, err: (err as Error).message },
          "run_label_add_failed",
        ),
      );

    return { started: true, runId: handle.runId };
```

Note: `issueTracker` is already destructured from `adapters` at the top of `dispatchTicket` (`const { issueTracker, runRegistry } = adapters;`). `updateLabels` is optional on `IssueTrackerAdapter`; the `?.` short-circuits the whole `.catch(...)` chain when an adapter doesn't implement it (so the existing tests, whose `makeAdapters` has no `updateLabels`, stay green).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter worker exec vitest run src/lib/dispatch.test.ts`
Expected: PASS — both new tests pass and all pre-existing dispatch tests still pass.

- [ ] **Step 6: Verify runId is label-safe**

The mock runId is `run_123`. Real Vercel Workflow run ids returned by `start(...)` are alphanumeric with underscores (no spaces) — safe as a Jira label (Jira Cloud labels forbid only spaces). No code change needed; this step is a sanity confirmation that the format assumption in the spec holds. If a runId could ever contain a space, sanitize in `runLabel`. Leave as-is.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/lib/dispatch.ts apps/worker/src/lib/dispatch.test.ts
git commit -m "feat: tag tickets with run:<id> label on dispatch"
```

---

## Task 3: Consumer — resolve ticket from labels in the dashboard

**Files:**
- Modify: `apps/worker/src/lib/overview/collect-runs.ts`
- Modify: `apps/worker/src/routes/api/v1/runs.get.ts`
- Test: `apps/worker/src/lib/overview/collect-runs.test.ts`

### Step group A: thread `projectKey` through (no behavior change)

- [ ] **Step 1: Add `projectKey` to the options type**

In `apps/worker/src/lib/overview/collect-runs.ts`, add the field to `CollectRunsOptions`:

```ts
export interface CollectRunsOptions {
  runsLister: RunsLister;
  issueTracker: IssueTrackerAdapter;
  jiraBaseUrl: string;
  /** Jira project key, used to scope the run-label lookup query. */
  projectKey: string;
  model: string;
  now: Date;
  /** Max runs to return (most recent first). */
  limit?: number;
}
```

- [ ] **Step 2: Pass `projectKey` from the route**

In `apps/worker/src/routes/api/v1/runs.get.ts`, add `projectKey` to the `collectRuns({ ... })` call (it already references `env`):

```ts
    const { rows, total, counts } = await collectRuns({
      runsLister: getWorld().runs as RunsLister,
      issueTracker: adapters.issueTracker,
      jiraBaseUrl: env.JIRA_BASE_URL,
      projectKey: env.JIRA_PROJECT_KEY,
      model,
      now: new Date(),
    });
```

- [ ] **Step 3: Add `projectKey` to existing test calls**

In `apps/worker/src/lib/overview/collect-runs.test.ts`, add `projectKey: "AWT",` to every `collectRuns({ ... })` call (there are 5: the tests titled "maps runs to rows…", "maps statuses and sorts…", "falls back to ticket key as title…", "leaves ticket empty when input cannot be decoded", and "returns empty result for no runs"). Place it next to the existing `jiraBaseUrl:` line in each, e.g.:

```ts
      jiraBaseUrl: "https://example.atlassian.net/",
      projectKey: "AWT",
```

- [ ] **Step 4: Run tests + typecheck to confirm still green**

Run: `pnpm --filter worker exec vitest run src/lib/overview/collect-runs.test.ts`
Expected: PASS — no behavior change yet; the new option is accepted but unused.
Run: `pnpm --filter worker typecheck`
Expected: PASS — the route and tests now supply the required `projectKey`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/overview/collect-runs.ts apps/worker/src/routes/api/v1/runs.get.ts apps/worker/src/lib/overview/collect-runs.test.ts
git commit -m "chore: thread projectKey into collectRuns"
```

### Step group B: label-based ticket resolution (TDD)

- [ ] **Step 6: Write the failing resolution test**

Add this test to the `describe("collectRuns", ...)` block in `apps/worker/src/lib/overview/collect-runs.test.ts`:

```ts
it("resolves ticket from a run:<id> label when input is undecodable", async () => {
  const lister = makeLister([record({ runId: "run_x", input: undefined })]);
  const tracker = makeTracker({
    searchTickets: vi.fn().mockResolvedValue(["AWT-77"]),
    fetchTicket: vi.fn(async (key: string) => ({
      id: key,
      identifier: key,
      projectKey: "AWT",
      title: "Labeled ticket",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      labels: ["run:run_x", "needs-clarification"],
      trackerStatus: "AI",
      attachments: [],
    })),
  });

  const { rows } = await collectRuns({
    runsLister: lister,
    issueTracker: tracker,
    jiraBaseUrl: "https://example.atlassian.net",
    projectKey: "AWT",
    model: "m",
    now: NOW,
  });

  expect(rows[0].ticket).toBe("AWT-77");
  expect(rows[0].ticketTitle).toBe("Labeled ticket");
  expect(rows[0].ticketUrl).toBe("https://example.atlassian.net/browse/AWT-77");
  expect(tracker.searchTickets).toHaveBeenCalledWith(
    `project = "AWT" AND labels in ("run:run_x")`,
  );
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter worker exec vitest run src/lib/overview/collect-runs.test.ts -t "resolves ticket from a run"`
Expected: FAIL — `rows[0].ticket` is `""` (input is `undefined`, and label resolution isn't implemented), and `searchTickets` is not called with the expected JQL.

- [ ] **Step 8: Add the import and the label-map builder**

In `apps/worker/src/lib/overview/collect-runs.ts`, add to the imports at the top:

```ts
import { RUN_LABEL_PREFIX, runLabel } from "../labels.js";
```

Add this function near the bottom of the file (e.g. just above the `startTime` helper):

```ts
/**
 * Build a `runId → {ticketKey, title}` map by querying Jira for tickets that
 * carry a `run:<id>` label for any of the listed runs. This recovers the
 * ticket for runs whose encrypted workflow `input` can't be decoded here. One
 * JQL search (capped at 50 tickets by the adapter), then one fetch per matched
 * ticket to read its labels. Best-effort: any failure yields a partial/empty
 * map and the caller falls back to `extractTicket`.
 */
async function buildRunLabelMap(
  runs: WorkflowRunRecord[],
  issueTracker: IssueTrackerAdapter,
  projectKey: string,
): Promise<Map<string, { ticketKey: string; title: string }>> {
  const map = new Map<string, { ticketKey: string; title: string }>();
  if (runs.length === 0) return map;

  const labelList = runs.map((r) => `"${runLabel(r.runId)}"`).join(", ");
  const jql = `project = "${projectKey}" AND labels in (${labelList})`;

  let keys: string[];
  try {
    keys = (await issueTracker.searchTickets(jql)) ?? [];
  } catch {
    return map;
  }

  await Promise.all(
    keys.map(async (key) => {
      try {
        const t = await issueTracker.fetchTicket(key);
        for (const label of t.labels) {
          if (label.startsWith(RUN_LABEL_PREFIX)) {
            const runId = label.slice(RUN_LABEL_PREFIX.length);
            map.set(runId, { ticketKey: key, title: t.title || key });
          }
        }
      } catch {
        // Best-effort — skip tickets we can't fetch.
      }
    }),
  );

  return map;
}
```

- [ ] **Step 9: Wire the map into `collectRuns` and resolve per run**

In `apps/worker/src/lib/overview/collect-runs.ts`, after the existing line:

```ts
  const sorted = [...data].sort((a, b) => startTime(b) - startTime(a));
```

add:

```ts
  const runLabelMap = await buildRunLabelMap(
    sorted,
    issueTracker,
    opts.projectKey,
  );
```

Then, inside the `sorted.map(async (run) => { ... })` callback, replace this existing block:

```ts
      const { id, name } = mapWorkflow(run.workflowName);
      const ticket = extractTicket(run);
```

with:

```ts
      const { id, name } = mapWorkflow(run.workflowName);
      const labeled = runLabelMap.get(run.runId);
      const ticket = labeled?.ticketKey ?? extractTicket(run);
```

And replace the existing title-resolution block:

```ts
      let ticketTitle = ticket;
      if (ticket) {
        try {
          const t = await issueTracker.fetchTicket(ticket);
          if (t.title) ticketTitle = t.title;
        } catch {
          // Best-effort lookup — fall through to the key as the title.
        }
      }
```

with:

```ts
      // Label-resolved runs already have their title from buildRunLabelMap;
      // only the extractTicket fallback path needs a per-run lookup.
      let ticketTitle = ticket;
      if (labeled) {
        ticketTitle = labeled.title;
      } else if (ticket) {
        try {
          const t = await issueTracker.fetchTicket(ticket);
          if (t.title) ticketTitle = t.title;
        } catch {
          // Best-effort lookup — fall through to the key as the title.
        }
      }
```

- [ ] **Step 10: Run the resolution test to verify it passes**

Run: `pnpm --filter worker exec vitest run src/lib/overview/collect-runs.test.ts -t "resolves ticket from a run"`
Expected: PASS.

- [ ] **Step 11: Add fallback + no-query tests**

Add these two tests to the `describe("collectRuns", ...)` block:

```ts
it("falls back to extractTicket when no run label matches", async () => {
  const lister = makeLister([record({ runId: "r", input: ["AWT-9"] })]);
  const tracker = makeTracker({
    searchTickets: vi.fn().mockResolvedValue([]),
  });

  const { rows } = await collectRuns({
    runsLister: lister,
    issueTracker: tracker,
    jiraBaseUrl: "https://example.atlassian.net",
    projectKey: "AWT",
    model: "m",
    now: NOW,
  });

  expect(rows[0].ticket).toBe("AWT-9");
});

it("does not query Jira when there are no runs", async () => {
  const searchTickets = vi.fn();
  const { rows } = await collectRuns({
    runsLister: makeLister([]),
    issueTracker: makeTracker({ searchTickets }),
    jiraBaseUrl: "https://example.atlassian.net",
    projectKey: "AWT",
    model: "m",
    now: NOW,
  });

  expect(rows).toEqual([]);
  expect(searchTickets).not.toHaveBeenCalled();
});
```

- [ ] **Step 12: Run the full collect-runs suite**

Run: `pnpm --filter worker exec vitest run src/lib/overview/collect-runs.test.ts`
Expected: PASS — all tests, new and pre-existing. (The pre-existing "leaves ticket empty when input cannot be decoded" test still passes: `searchTickets` returns `undefined` → `[]` → empty map → `extractTicket` → `""`.)

- [ ] **Step 13: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/worker/src/lib/overview/collect-runs.ts apps/worker/src/lib/overview/collect-runs.test.ts
git commit -m "feat: resolve dashboard run→ticket via run:<id> labels"
```

---

## Task 4: Full verification

- [ ] **Step 1: Run the full worker test suite**

Run: `pnpm --filter worker test`
Expected: PASS — entire suite green.

- [ ] **Step 2: Typecheck the worker**

Run: `pnpm --filter worker typecheck`
Expected: PASS.

- [ ] **Step 3 (optional manual smoke):** After deploy, move a ticket into the AI column, confirm a `run:<id>` label appears on it in Jira, and confirm the dashboard runs table shows that ticket for the run. Per the live-smoke-test convention, clean up any test ticket/label afterward.
