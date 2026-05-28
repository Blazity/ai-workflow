# Overview Page: Real Data Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `AIWF_DATA` mock imports in `components/cockpit/screens/overview.tsx` with live data from Vercel Workflow, Arthur Engine, Vercel logs, Jira, and a GitHub App.

**Architecture:** Fill in the empty `app/api/*` route handlers. Each handler calls a thin integration client in `lib/integrations/*`, an aggregator in `lib/server/*` joins sources into the UI's exact shape, and the overview screen consumes everything through SWR hooks in `lib/data/hooks.ts`. Every API route falls back to slicing `AIWF_DATA` when its env vars are absent so the dashboard never breaks during incremental rollout.

**Tech Stack:** Next.js 15 App Router, React 19 client components, SWR for fetching, native `fetch` for outbound calls, `@octokit/auth-app` for GitHub installation tokens. No DB; rely on Vercel Runtime Cache for hourly aggregates.

---

## File Structure

**Create:**
- `lib/integrations/vercel.ts` — Vercel REST API client (workflow runs, function logs)
- `lib/integrations/arthur.ts` — Arthur Engine client (traces, evals, cost)
- `lib/integrations/jira.ts` — Jira Cloud REST client (issue lookup)
- `lib/integrations/github.ts` — GitHub App client (JWT → installation token → PR lookup)
- `lib/integrations/env.ts` — typed `getEnv()` helper + per-service `isConfigured()` predicates
- `lib/server/aggregators/runs.ts` — joins Vercel Workflow runs with Jira/GitHub/Arthur
- `lib/server/aggregators/workflows.ts` — joins Vercel Workflow registry with logs + Arthur
- `lib/server/aggregators/evals.ts` — Arthur eval summary
- `lib/server/aggregators/hours24.ts` — 24h hourly buckets from logs + Arthur, cached
- `lib/data/hooks.ts` — SWR hooks consumed by client components
- `app/api/runs/route.ts`
- `app/api/workflows/route.ts`
- `app/api/evals/summary/route.ts`
- `app/api/cost/hours24/route.ts`
- `app/api/activity/hours24/route.ts`

**Modify:**
- `components/cockpit/screens/overview.tsx` — replace `AIWF_DATA` reads with hooks + loading states
- `package.json` — add `swr`, `@octokit/auth-app`, `@octokit/request`

**Leave untouched:**
- `lib/data/mock.ts` — still used by other screens (`runs`, `trace`, `prompts`, `evals`, `cost`, `presandbox`, `postpr`); migration of those is out of scope for this plan
- `lib/types.ts` — already correct shapes; API responses must conform to it

---

## Task 0: Install dependencies and verify env scaffolding

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime deps**

```bash
npm install swr @octokit/auth-app @octokit/request
```

- [ ] **Step 2: Confirm `.env.example` exists and matches required vars**

Run: `cat .env.example`
Expected: contains `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `ARTHUR_API_KEY`, `ARTHUR_BASE_URL`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`.

- [ ] **Step 3: Create `.env.local` from the example**

```bash
cp .env.example .env.local
```

Tell the user to fill in the real values before continuing past Task 4. Tasks 1–4 work without any keys (fallback paths).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add swr + octokit deps for live overview data"
```

---

## Task 1: Env helper with per-service configured guards

**Files:**
- Create: `lib/integrations/env.ts`

- [ ] **Step 1: Write the helper**

```ts
// lib/integrations/env.ts
// Centralised env access. Each integration calls isConfigured() before making
// outbound calls; route handlers fall back to mock data when false.

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  vercel: {
    token: () => read("VERCEL_TOKEN"),
    teamId: () => read("VERCEL_TEAM_ID"),
    projectId: () => read("VERCEL_PROJECT_ID"),
  },
  arthur: {
    apiKey: () => read("ARTHUR_API_KEY"),
    baseUrl: () => read("ARTHUR_BASE_URL") ?? "https://platform.arthur.ai",
  },
  jira: {
    baseUrl: () => read("JIRA_BASE_URL"),
    email: () => read("JIRA_EMAIL"),
    token: () => read("JIRA_API_TOKEN"),
  },
  github: {
    appId: () => read("GITHUB_APP_ID"),
    installationId: () => read("GITHUB_APP_INSTALLATION_ID"),
    privateKey: () => read("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
  },
};

export const isConfigured = {
  vercel: () => !!(env.vercel.token() && env.vercel.projectId()),
  arthur: () => !!env.arthur.apiKey(),
  jira: () => !!(env.jira.baseUrl() && env.jira.email() && env.jira.token()),
  github: () => !!(env.github.appId() && env.github.installationId() && env.github.privateKey()),
};
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/integrations/env.ts
git commit -m "feat(integrations): central env access with per-service configured guards"
```

---

## Task 2: Vercel Workflow + logs integration client

**Files:**
- Create: `lib/integrations/vercel.ts`

> **Note:** Vercel Workflow REST endpoints are evolving. Before coding, open https://vercel.com/docs/rest-api and the Workflow docs and confirm the path/parameters for "list workflow runs", "get run", and "list function logs". The shape below assumes `GET /v1/workflows/runs` returns `{ runs: [...] }`. Adjust to match the real surface; do not invent.

- [ ] **Step 1: Verify the real endpoints**

Open https://vercel.com/docs/rest-api and the Workflow Run API reference. Note the exact paths for:
- List runs for a project (filterable by status)
- Get run by id (with span/step state)
- Query function logs by time range

Record findings in a comment block at the top of `vercel.ts`.

- [ ] **Step 2: Write the client**

```ts
// lib/integrations/vercel.ts
import { env, isConfigured } from "./env";

// REST API base. Per docs verified in step 1.
const API = "https://api.vercel.com";

interface VercelRunRaw {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "success" | "running" | "failed" | "blocked" | "awaiting";
  startedAt: number;          // ms epoch
  durationMs: number | null;
  model?: string;
  // Live state
  currentSpan?: { name: string; kind: string; index: number; total: number };
  progress?: number;
  etaSec?: number;
  // Awaiting state
  pausedAt?: { spanName: string; question: string; questionFor: string; suggestedAnswers?: string[] };
  // External refs the workflow tagged onto the run
  ticket?: string;
  prNumber?: number;
  prRepo?: string;            // "owner/repo"
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = env.vercel.token();
  const team = env.vercel.teamId();
  const url = new URL(API + path);
  if (team) url.searchParams.set("teamId", team);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Vercel ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function listRuns(opts: {
  status?: VercelRunRaw["status"][];
  since?: number;             // ms epoch
  limit?: number;
}): Promise<VercelRunRaw[]> {
  if (!isConfigured.vercel()) return [];
  const project = env.vercel.projectId()!;
  const qs = new URLSearchParams({ projectId: project });
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.since) qs.set("since", String(opts.since));
  opts.status?.forEach((s) => qs.append("status", s));
  const data = await call<{ runs: VercelRunRaw[] }>(`/v1/workflows/runs?${qs}`);
  return data.runs;
}

export async function listFunctionLogs(opts: {
  since: number;
  until: number;
}): Promise<{ timestamp: number; durationMs: number; statusCode: number }[]> {
  if (!isConfigured.vercel()) return [];
  const project = env.vercel.projectId()!;
  const data = await call<{ logs: { timestamp: number; durationMs: number; statusCode: number }[] }>(
    `/v2/logs?projectId=${project}&since=${opts.since}&until=${opts.until}`,
  );
  return data.logs;
}
```

- [ ] **Step 3: Smoke-check the path locally**

If `VERCEL_TOKEN` is in `.env.local`, run:

```bash
npx tsx -e "import('./lib/integrations/vercel').then(m => m.listRuns({ limit: 3 }).then(console.log))"
```

Expected: array of runs (possibly empty if no workflows exist yet) — *not* a 401/404. If you get 404, the endpoint path is wrong; recheck step 1.

- [ ] **Step 4: Commit**

```bash
git add lib/integrations/vercel.ts
git commit -m "feat(integrations): Vercel Workflow runs + function logs client"
```

---

## Task 3: Arthur Engine integration client

**Files:**
- Create: `lib/integrations/arthur.ts`

> **Note:** Arthur cost: this plan assumes Arthur returns cost in dollars on the trace/eval endpoints (Option A from the prior conversation, configured price table). If their API only returns tokens + model, this client will need a local price table — defer to a follow-up.

- [ ] **Step 1: Confirm Arthur endpoints**

Open Arthur Engine docs. Confirm endpoints for:
- Trace/run summary by external `run_id` (returns eval scores, token totals, cost)
- Eval metrics aggregate (pass/warn/fail counts over a time window)
- Hourly cost aggregate (or query traces + bucket client-side)

Document in a header comment.

- [ ] **Step 2: Write the client**

```ts
// lib/integrations/arthur.ts
import { env, isConfigured } from "./env";

interface ArthurRunSummary {
  runId: string;
  evalScore: number;          // 0..1
  guardrailHits: number;
  tokens: number;
  cost: number;               // USD
}

interface ArthurEvalSummary {
  pass: number;
  warn: number;
  fail: number;
  scoreAvg: number;           // 0..100
  spansGraded: number;
}

async function call<T>(path: string): Promise<T> {
  const key = env.arthur.apiKey();
  const base = env.arthur.baseUrl();
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Arthur ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function getRunSummaries(runIds: string[]): Promise<Map<string, ArthurRunSummary>> {
  if (!isConfigured.arthur() || runIds.length === 0) return new Map();
  const qs = new URLSearchParams();
  runIds.forEach((id) => qs.append("run_id", id));
  const data = await call<{ runs: ArthurRunSummary[] }>(`/api/v1/runs/summary?${qs}`);
  return new Map(data.runs.map((r) => [r.runId, r]));
}

export async function getEvalSummary(opts: { sinceMs: number }): Promise<ArthurEvalSummary> {
  if (!isConfigured.arthur()) {
    return { pass: 0, warn: 0, fail: 0, scoreAvg: 0, spansGraded: 0 };
  }
  return call<ArthurEvalSummary>(`/api/v1/evals/summary?since=${opts.sinceMs}`);
}

export async function getCostBuckets(opts: {
  sinceMs: number;
  untilMs: number;
  bucketMs: number;
}): Promise<{ t: number; cost: number }[]> {
  if (!isConfigured.arthur()) return [];
  const data = await call<{ buckets: { t: number; cost: number }[] }>(
    `/api/v1/cost/buckets?since=${opts.sinceMs}&until=${opts.untilMs}&bucket=${opts.bucketMs}`,
  );
  return data.buckets;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/integrations/arthur.ts
git commit -m "feat(integrations): Arthur Engine traces/evals/cost client"
```

---

## Task 4: Jira and GitHub App decorators

**Files:**
- Create: `lib/integrations/jira.ts`
- Create: `lib/integrations/github.ts`

- [ ] **Step 1: Write the Jira client**

```ts
// lib/integrations/jira.ts
import { env, isConfigured } from "./env";

export interface JiraIssue {
  key: string;
  title: string;
  url: string;
}

export async function getIssues(keys: string[]): Promise<Map<string, JiraIssue>> {
  if (!isConfigured.jira() || keys.length === 0) return new Map();
  const base = env.jira.baseUrl()!;
  const auth = Buffer.from(`${env.jira.email()}:${env.jira.token()}`).toString("base64");
  // JQL batch fetch — one round-trip for all keys.
  const jql = `key in (${keys.map((k) => `"${k}"`).join(",")})`;
  const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { issues: { key: string; fields: { summary: string } }[] };
  return new Map(
    data.issues.map((i) => [
      i.key,
      { key: i.key, title: i.fields.summary, url: `${base}/browse/${i.key}` },
    ]),
  );
}
```

- [ ] **Step 2: Write the GitHub App client**

```ts
// lib/integrations/github.ts
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { env, isConfigured } from "./env";

export interface GhPR {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function installationToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const auth = createAppAuth({
    appId: env.github.appId()!,
    privateKey: env.github.privateKey()!,
    installationId: env.github.installationId()!,
  });
  const { token, expiresAt } = await auth({ type: "installation" });
  cachedToken = { token, expiresAt: new Date(expiresAt).getTime() };
  return token;
}

export async function getPRs(
  refs: { repo: string; number: number }[],
): Promise<Map<string, GhPR>> {
  if (!isConfigured.github() || refs.length === 0) return new Map();
  const token = await installationToken();
  const results = await Promise.all(
    refs.map(async ({ repo, number }) => {
      const [owner, name] = repo.split("/");
      const res = await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo: name,
        pull_number: number,
        headers: { authorization: `token ${token}` },
      });
      const key = `${repo}#${number}`;
      const state: GhPR["state"] = res.data.merged_at ? "merged" : (res.data.state as "open" | "closed");
      return [key, { number, url: res.data.html_url, title: res.data.title, state }] as const;
    }),
  );
  return new Map(results);
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/integrations/jira.ts lib/integrations/github.ts
git commit -m "feat(integrations): Jira + GitHub App decorators"
```

---

## Task 5: Runs aggregator + `/api/runs` route

**Files:**
- Create: `lib/server/aggregators/runs.ts`
- Create: `app/api/runs/route.ts`

This route returns the data feeding "Now running", "Input needed", and the "Recent runs" table. Output shape must exactly match `Run[]` from `lib/types.ts:23-58`.

- [ ] **Step 1: Write the aggregator**

```ts
// lib/server/aggregators/runs.ts
import { listRuns } from "@/lib/integrations/vercel";
import { getRunSummaries } from "@/lib/integrations/arthur";
import { getIssues } from "@/lib/integrations/jira";
import { getPRs } from "@/lib/integrations/github";
import { isConfigured } from "@/lib/integrations/env";
import { AIWF_DATA } from "@/lib/data/mock";
import type { Run } from "@/lib/types";

export type RunsBundle = { running: Run[]; awaiting: Run[]; recent: Run[] };

export async function getRunsBundle(): Promise<RunsBundle> {
  if (!isConfigured.vercel()) {
    return {
      running: AIWF_DATA.LIVE_RUNS.filter((r) => r.status === "running"),
      awaiting: AIWF_DATA.LIVE_RUNS.filter((r) => r.status === "awaiting"),
      recent: AIWF_DATA.RUNS,
    };
  }

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const raw = await listRuns({ since, limit: 200 });

  const [arthur, jira, github] = await Promise.all([
    getRunSummaries(raw.map((r) => r.id)),
    getIssues(uniq(raw.map((r) => r.ticket).filter(Boolean) as string[])),
    getPRs(
      raw
        .filter((r) => r.prNumber && r.prRepo)
        .map((r) => ({ repo: r.prRepo!, number: r.prNumber! })),
    ),
  ]);

  const decorated: Run[] = raw.map((r) => {
    const a = arthur.get(r.id);
    const ticket = r.ticket ?? "—";
    const j = r.ticket ? jira.get(r.ticket) : undefined;
    const pr = r.prRepo && r.prNumber ? github.get(`${r.prRepo}#${r.prNumber}`) : undefined;
    return {
      id: r.id,
      workflow: r.workflowId,
      workflowName: r.workflowName,
      status: r.status,
      ticket,
      ticketTitle: j?.title ?? ticket,
      ticketUrl: j?.url ?? "",
      prNumber: pr?.number ?? null,
      prUrl: pr?.url ?? null,
      actor: "—",
      model: r.model ?? "—",
      startedAtMin: Math.round((Date.now() - r.startedAt) / 60000),
      duration: r.durationMs == null ? null : Math.round(r.durationMs / 100) / 10,
      tokens: a?.tokens ?? 0,
      cost: a?.cost ?? 0,
      spans: 0,
      evalScore: a?.evalScore ?? 0,
      guardrailHits: a?.guardrailHits ?? 0,
      currentSpan: r.currentSpan?.name,
      currentSpanKind: r.currentSpan?.kind as Run["currentSpanKind"],
      spanIndex: r.currentSpan?.index,
      spansTotal: r.currentSpan?.total,
      progress: r.progress,
      etaSec: r.etaSec,
      elapsed: r.startedAt ? (Date.now() - r.startedAt) / 1000 : undefined,
      pausedAtSpan: r.pausedAt?.spanName,
      question: r.pausedAt?.question,
      questionFor: r.pausedAt?.questionFor,
      suggestedAnswers: r.pausedAt?.suggestedAnswers,
      askedAtMin: r.pausedAt ? Math.round((Date.now() - r.startedAt) / 60000) : undefined,
    };
  });

  return {
    running: decorated.filter((r) => r.status === "running"),
    awaiting: decorated.filter((r) => r.status === "awaiting"),
    recent: decorated,
  };
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
```

- [ ] **Step 2: Write the route handler**

```ts
// app/api/runs/route.ts
import { NextResponse } from "next/server";
import { getRunsBundle } from "@/lib/server/aggregators/runs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bundle = await getRunsBundle();
    return NextResponse.json(bundle);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
```

- [ ] **Step 3: Verify the route works in fallback mode**

Run dev server:

```bash
npm run dev
```

In another shell:

```bash
curl -s http://localhost:3000/api/runs | head -c 200
```

Expected: JSON with `running`, `awaiting`, `recent` arrays. Even without any keys configured, you should see the mock-derived data.

- [ ] **Step 4: Commit**

```bash
git add lib/server/aggregators/runs.ts app/api/runs/route.ts
git commit -m "feat(api): /api/runs aggregating Vercel Workflow + Arthur + Jira + GitHub"
```

---

## Task 6: Workflows aggregator + `/api/workflows` route

**Files:**
- Create: `lib/server/aggregators/workflows.ts`
- Create: `app/api/workflows/route.ts`

Feeds the hero KPI strip totals and the bottom "Workflows" table.

- [ ] **Step 1: Write the aggregator**

```ts
// lib/server/aggregators/workflows.ts
import { listRuns, listFunctionLogs } from "@/lib/integrations/vercel";
import { getRunSummaries } from "@/lib/integrations/arthur";
import { isConfigured } from "@/lib/integrations/env";
import { AIWF_DATA } from "@/lib/data/mock";
import type { Workflow } from "@/lib/types";

export async function getWorkflows(): Promise<Workflow[]> {
  if (!isConfigured.vercel()) return AIWF_DATA.WORKFLOWS;

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const [runs, logs] = await Promise.all([
    listRuns({ since, limit: 1000 }),
    listFunctionLogs({ since, until: Date.now() }),
  ]);

  const arthur = await getRunSummaries(runs.map((r) => r.id));

  // Group by workflowId, compute aggregates.
  const byId = new Map<string, { name: string; runs: typeof runs }>();
  for (const r of runs) {
    if (!byId.has(r.workflowId)) byId.set(r.workflowId, { name: r.workflowName, runs: [] });
    byId.get(r.workflowId)!.runs.push(r);
  }

  return Array.from(byId.entries()).map(([id, { name, runs: wfRuns }]) => {
    const durations = wfRuns
      .map((r) => r.durationMs)
      .filter((d): d is number => d != null)
      .sort((a, b) => a - b);
    const p50 = pct(durations, 0.5) / 1000;
    const p95 = pct(durations, 0.95) / 1000;
    const errors = wfRuns.filter((r) => r.status === "failed").length;
    const errRate = wfRuns.length === 0 ? 0 : errors / wfRuns.length;
    const costToday = wfRuns.reduce((s, r) => s + (arthur.get(r.id)?.cost ?? 0), 0);
    const gateway = wfRuns[0]?.model?.split("-")[0] ?? "—";
    return {
      id,
      name,
      blurb: "",
      runs24h: wfRuns.length,
      p50,
      p95,
      errRate,
      costToday,
      gateway,
    };
  });
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
```

- [ ] **Step 2: Write the route handler**

```ts
// app/api/workflows/route.ts
import { NextResponse } from "next/server";
import { getWorkflows } from "@/lib/server/aggregators/workflows";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ workflows: await getWorkflows() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
```

- [ ] **Step 3: Verify**

```bash
curl -s http://localhost:3000/api/workflows | head -c 200
```

Expected: `{"workflows":[...]}` with non-empty array.

- [ ] **Step 4: Commit**

```bash
git add lib/server/aggregators/workflows.ts app/api/workflows/route.ts
git commit -m "feat(api): /api/workflows with 24h aggregates"
```

---

## Task 7: Evals + hours24 aggregators with Runtime Cache

**Files:**
- Create: `lib/server/aggregators/evals.ts`
- Create: `lib/server/aggregators/hours24.ts`
- Create: `app/api/evals/summary/route.ts`
- Create: `app/api/cost/hours24/route.ts`
- Create: `app/api/activity/hours24/route.ts`

The hourly aggregator hits external APIs and buckets into 24 hourly points. Cache for 5 minutes per bucket key using Next.js `unstable_cache` or the response `Cache-Control` header.

- [ ] **Step 1: Write the evals aggregator**

```ts
// lib/server/aggregators/evals.ts
import { getEvalSummary } from "@/lib/integrations/arthur";
import { isConfigured } from "@/lib/integrations/env";

export interface EvalSummary {
  pass: number;
  warn: number;
  fail: number;
  scoreAvg: number;
  spansGraded: number;
}

export async function getEvalsSummary(): Promise<EvalSummary> {
  if (!isConfigured.arthur()) {
    // Mock parity with the donut in overview.tsx
    return { pass: 7, warn: 2, fail: 0, scoreAvg: 92.3, spansGraded: 12400 };
  }
  return getEvalSummary({ sinceMs: Date.now() - 24 * 60 * 60 * 1000 });
}
```

- [ ] **Step 2: Write the hours24 aggregator**

```ts
// lib/server/aggregators/hours24.ts
import { unstable_cache } from "next/cache";
import { listRuns, listFunctionLogs } from "@/lib/integrations/vercel";
import { getCostBuckets } from "@/lib/integrations/arthur";
import { isConfigured } from "@/lib/integrations/env";
import { AIWF_DATA } from "@/lib/data/mock";
import type { HourPoint } from "@/lib/types";

const HOUR = 60 * 60 * 1000;

async function computeHours24(): Promise<HourPoint[]> {
  if (!isConfigured.vercel()) return AIWF_DATA.HOURS24;

  const until = Date.now();
  const since = until - 24 * HOUR;
  const [runs, logs, costs] = await Promise.all([
    listRuns({ since, limit: 5000 }),
    listFunctionLogs({ since, until }),
    isConfigured.arthur()
      ? getCostBuckets({ sinceMs: since, untilMs: until, bucketMs: HOUR })
      : Promise.resolve([]),
  ]);

  const points: HourPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const bucketStart = since + h * HOUR;
    const bucketEnd = bucketStart + HOUR;
    const inBucket = runs.filter((r) => r.startedAt >= bucketStart && r.startedAt < bucketEnd);
    const logsInBucket = logs.filter((l) => l.timestamp >= bucketStart && l.timestamp < bucketEnd);
    const durations = logsInBucket.map((l) => l.durationMs).sort((a, b) => a - b);
    const p95 =
      durations.length === 0 ? 0 : durations[Math.floor(durations.length * 0.95)] / 1000;
    const errors = logsInBucket.filter((l) => l.statusCode >= 500).length;
    const cost = costs.find((c) => c.t === bucketStart)?.cost ?? 0;
    points.push({ h, runs: inBucket.length, cost, p95, errors });
  }
  return points;
}

export const getHours24 = unstable_cache(computeHours24, ["hours24"], { revalidate: 300 });
```

- [ ] **Step 3: Write the three route handlers**

```ts
// app/api/evals/summary/route.ts
import { NextResponse } from "next/server";
import { getEvalsSummary } from "@/lib/server/aggregators/evals";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(await getEvalsSummary());
}
```

```ts
// app/api/activity/hours24/route.ts
import { NextResponse } from "next/server";
import { getHours24 } from "@/lib/server/aggregators/hours24";
export const revalidate = 300;
export async function GET() {
  const points = await getHours24();
  return NextResponse.json({ points });
}
```

```ts
// app/api/cost/hours24/route.ts
import { NextResponse } from "next/server";
import { getHours24 } from "@/lib/server/aggregators/hours24";
export const revalidate = 300;
export async function GET() {
  const points = await getHours24();
  return NextResponse.json({ points: points.map(({ h, cost }) => ({ h, cost })) });
}
```

- [ ] **Step 4: Verify all three**

```bash
curl -s http://localhost:3000/api/evals/summary
curl -s http://localhost:3000/api/activity/hours24 | head -c 200
curl -s http://localhost:3000/api/cost/hours24 | head -c 200
```

Expected: each returns JSON, no 500s.

- [ ] **Step 5: Commit**

```bash
git add lib/server/aggregators/evals.ts lib/server/aggregators/hours24.ts \
        app/api/evals/summary/route.ts app/api/activity/hours24/route.ts \
        app/api/cost/hours24/route.ts
git commit -m "feat(api): evals summary + 24h activity/cost buckets with 5min cache"
```

---

## Task 8: Client-side SWR hooks

**Files:**
- Create: `lib/data/hooks.ts`

- [ ] **Step 1: Write the hooks**

```ts
// lib/data/hooks.ts
"use client";

import useSWR from "swr";
import type { Run, Workflow, HourPoint } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useRuns() {
  return useSWR<{ running: Run[]; awaiting: Run[]; recent: Run[] }>(
    "/api/runs",
    fetcher,
    { refreshInterval: 30_000, fallbackData: { running: [], awaiting: [], recent: [] } },
  );
}

export function useWorkflows() {
  return useSWR<{ workflows: Workflow[] }>("/api/workflows", fetcher, {
    refreshInterval: 60_000,
    fallbackData: { workflows: [] },
  });
}

export function useEvalsSummary() {
  return useSWR<{ pass: number; warn: number; fail: number; scoreAvg: number; spansGraded: number }>(
    "/api/evals/summary",
    fetcher,
    { refreshInterval: 60_000 },
  );
}

export function useHours24() {
  return useSWR<{ points: HourPoint[] }>("/api/activity/hours24", fetcher, {
    refreshInterval: 5 * 60_000,
    fallbackData: { points: [] },
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/data/hooks.ts
git commit -m "feat(data): SWR hooks for overview screen"
```

---

## Task 9: Wire the overview screen — hero KPIs + workflows table

**Files:**
- Modify: `components/cockpit/screens/overview.tsx`

Swap the `AIWF_DATA` reads that feed the hero KPI strip, editorial hero, and the bottom Workflows table.

- [ ] **Step 1: Add hook imports and replace top-of-component data**

Replace lines 14-20 (imports + `const D = AIWF_DATA`) with:

```tsx
import { AIWF_DATA } from "@/lib/data/mock"; // still needed for unmigrated mock fallbacks below
import { useWorkflows, useEvalsSummary, useHours24, useRuns } from "@/lib/data/hooks";
```

Replace `const D = AIWF_DATA;` (line 19) with nothing — remove it.

- [ ] **Step 2: Refactor the `OverviewScreen` body to consume hooks**

In `OverviewScreen`, replace the totals computation block (lines 181-187) with:

```tsx
const { data: wfData } = useWorkflows();
const { data: hours24 } = useHours24();
const { data: runsData } = useRuns();
const workflows = wfData?.workflows ?? [];
const hours = hours24?.points ?? [];

const totalRuns = workflows.reduce((a, w) => a + w.runs24h, 0);
const totalCost = workflows.reduce((a, w) => a + w.costToday, 0);
const totalErrors = workflows.reduce((a, w) => a + Math.round(w.runs24h * w.errRate), 0);
const sparkRuns = hours.map((h) => h.runs);
const sparkP95 = hours.map((h) => h.p95);
const sparkErr = hours.map((h) => h.errors);
```

- [ ] **Step 3: Swap the workflows table source**

Replace `D.WORKFLOWS` (lines 198-201) with `workflows`, and `D.WORKFLOWS.length` accordingly. Replace `D.RUNS.find(...)` inside the workflows table (line 338) with `runsData?.recent.find((r) => r.workflow === w.id)`.

- [ ] **Step 4: Swap the recent runs source**

Replace `D.RUNS` references in the runs pagination block (lines 192-194) and table body with `runsData?.recent ?? []`. Replace status-count chips (`D.RUNS.filter(...)`) with the same against `runsData?.recent ?? []`.

- [ ] **Step 5: Run the dev server and visually verify**

```bash
npm run dev
```

Open http://localhost:3000. Confirm:
- Hero KPIs render numbers (real or fallback)
- Workflows table renders rows
- Recent runs table renders rows
- No console errors about undefined `.length` / `.filter` (means the fallbackData kicked in correctly)

- [ ] **Step 6: Commit**

```bash
git add components/cockpit/screens/overview.tsx
git commit -m "feat(overview): wire hero KPIs + workflows + recent runs to live data"
```

---

## Task 10: Wire Now Running, Input Needed, and Eval Health donut

**Files:**
- Modify: `components/cockpit/screens/overview.tsx`

- [ ] **Step 1: Update `NowRunningPanel` and `AwaitingInputPanel` to take their data via props**

Change `NowRunningPanel`'s signature from `({ onOpenRun })` to `({ runs, onOpenRun })`:

```tsx
function NowRunningPanel({ runs, onOpenRun }: { runs: Run[]; onOpenRun: (run: Run) => void }) {
  const running = runs;
  // …rest unchanged, just replace the existing `D.LIVE_RUNS.filter(...)` line
}
```

Same for `AwaitingInputPanel`:

```tsx
function AwaitingInputPanel({ runs, onOpenRun }: { runs: Run[]; onOpenRun: (run: Run) => void }) {
  const awaiting = runs;
  // …
}
```

In `OverviewScreen`'s JSX, change the call sites:

```tsx
<NowRunningPanel runs={runsData?.running ?? []} onOpenRun={onOpenRun} />
<AwaitingInputPanel runs={runsData?.awaiting ?? []} onOpenRun={onOpenRun} />
```

- [ ] **Step 2: Wire the Eval Health donut**

Change `EvalHealthKPI` to consume the SWR hook directly:

```tsx
function EvalHealthKPI() {
  const { data } = useEvalsSummary();
  const pass = data?.pass ?? 0;
  const warn = data?.warn ?? 0;
  const fail = data?.fail ?? 0;
  const total = Math.max(1, pass + warn + fail);
  const shares = [pass / total, warn / total, fail / total];
  const scoreLabel = data?.scoreAvg?.toFixed(1) ?? "—";
  const spans = data?.spansGraded?.toLocaleString() ?? "—";
  return (
    // …existing JSX, replace `shares={[0.78, 0.14, 0.08]}` with `shares={shares}`,
    // `centerLabel="92.3"` with `centerLabel={scoreLabel}`, the three count `<b>` values
    // with `{pass}` / `{warn}` / `{fail}`, and the footer text with `${spans} spans graded · 24h`.
  );
}
```

- [ ] **Step 3: Update the editorial hero numbers**

Replace the hardcoded `"23.1s"` p95 and `"92.3"` eval-score KPIs (lines 230) with values from the live data:

```tsx
const livep95 = hours.length === 0 ? "—" : `${hours[hours.length - 1].p95.toFixed(1)}s`;
const liveEvalScore = useEvalsSummary().data?.scoreAvg.toFixed(1) ?? "—";
```

…and reference them in the KPI grid array.

- [ ] **Step 4: Visual + console check**

```bash
npm run dev
```

Open the page. Confirm:
- "Now running" + "Input needed" cards render (may be empty if no live runs — that's correct)
- Eval donut updates with real percentages
- No "Cannot read properties of undefined" errors

- [ ] **Step 5: Commit**

```bash
git add components/cockpit/screens/overview.tsx
git commit -m "feat(overview): wire now-running, awaiting, eval donut to live data"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Run with no env (fallback mode)**

```bash
rm .env.local
npm run dev
```

Open http://localhost:3000. Confirm the page looks identical to the mock-data version (because every aggregator falls back to `AIWF_DATA`).

- [ ] **Step 2: Restore env and run with real keys**

```bash
cp .env.example .env.local
# Fill in real values
npm run dev
```

Open http://localhost:3000. Spot-check:
- A workflow row matches a workflow that exists in your Vercel dashboard
- A recent run's ticket title matches what shows in Jira
- A run with a PR link opens the correct GitHub PR
- The cost-today number aligns roughly with Arthur's UI

- [ ] **Step 3: Production type-check + build**

```bash
npx tsc --noEmit && npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Commit (if any cleanup happened)**

```bash
git status
# Only commit if there's something
```

---

## Out of scope (follow-ups)

- `runs`, `trace`, `prompts`, `evals`, `cost`, `presandbox`, `postpr` screens still read `AIWF_DATA`. Each is a follow-up plan; the integration clients above are reusable.
- Real eval-metric breakdown (Evals screen) needs a richer Arthur endpoint — placeholder summary is enough for the overview donut only.
- Local price table fallback for cost if Arthur's API turns out not to expose `$` directly.
- Auth on the `/api/*` routes — currently public; add session/middleware before deploying.
