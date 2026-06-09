# `/prompts` Real-Data Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `/prompts` dashboard page from mock data to live worker data, mirroring the `/runs` server-component fetch pattern. Read-only display of the three workflow prompts the worker actually resolves at runtime, **including real Arthur version history**.

**Architecture:** New worker route `GET /api/v1/prompts` returns a typed `PromptsResponse` built from the same resolution logic the durable `loadPrompts()` step uses (Arthur `production` tags with in-code fallbacks), plus each prompt's real Arthur version-history metadata. A second route `GET /api/v1/prompts/[name]/versions/[version]` returns a single historical version's body on demand. Thin server route (`page.tsx`) wraps a server component (`prompts-data.tsx`) in `<Suspense>`; it fetches the list via `getJSON`, falls back to an empty `PromptsResponse`, and passes `data` to the client presenter `PromptsScreen`. The client fetches historical version bodies lazily through a same-origin Next route handler that proxies the worker (keeps the bearer token server-side). Shape mirrors `runs.get.ts` / `runs-data.tsx` / `RunsScreen`.

**Tech stack:** h3 worker (`@apps/worker`), Next.js App Router dashboard (`@apps/dashboard`), shared `@shared/contracts`. Worker has vitest tests; dashboard has none — dashboard verification is `npx tsc --noEmit`, `next lint`, and a manual browser check.

**Spec:** `docs/superpowers/specs/2026-06-08-prompts-real-data-design.md`

**Scope decisions baked in (confirmed by user + Arthur API ground-truthing):**
- Read-only display. No write/edit endpoints. Action buttons left inert.
- **Real Arthur version history is in scope** (version-list metadata + on-demand bodies). Arthur's version list is metadata only, so per-version eval/halluc/p95/cost metrics and the A/B text diff have **no source** — that markup is **removed**, not stubbed with placeholders.
- Tags are real (`AgenticPromptVersionResponse.tags`); the `production` badge and tag filter stay, backed by data.
- Worker route reuses a shared extracted `resolvePrompts()` helper (option A) called by both `loadPrompts()` and the route. Confirmed OK to touch `prompts-step.ts`.
- Body fetch: production body eager (already resolved); historical bodies lazy via the on-demand route.

**Note on commits:** This repo's owner stages commits manually. Do NOT commit unless the user explicitly asks. The final task lists the command for when they do.

---

### Task 1: Add the shared `PromptVersion` + `PromptDef` entities + response contracts

**Files:**
- Modify: `apps/shared/contracts/domain.ts`
- Modify: `apps/shared/contracts/api.ts`

- [ ] **Step 1: Add `PromptVersion` + `PromptDef` to `domain.ts`**

```ts
/** One Arthur version of a named prompt (metadata; body fetched on demand). */
export interface PromptVersion {
  /** Arthur integer version number. */
  version: number;
  /** ISO timestamp the version was created. */
  createdAt: string;
  /** Real Arthur tags on this version, e.g. ["production"]. */
  tags: string[];
  modelProvider: string;
  modelName: string;
  numMessages: number;
  numTools: number;
  /** Body text. Present only for the production version (eager); other
   *  versions are fetched on demand. */
  body?: string;
}

/** A workflow phase prompt as resolved by the worker at runtime. */
export interface PromptDef {
  /** Stable Arthur/fallback key: "research-plan" | "implement" | "review". */
  name: string;
  /** Human label for the workflow phase, e.g. "Research & Plan". */
  phase: string;
  /** Resolved production prompt body (Arthur production tag, or in-code fallback). */
  body: string;
  /** Where the resolved `body` came from. */
  source: "arthur" | "fallback";
  /** Model the agent runs this prompt with (env-derived). */
  model: string;
  /** Real Arthur version history, newest first. Empty when source is "fallback". */
  versions: PromptVersion[];
}
```

- [ ] **Step 2: Add `PromptsResponse` + `PromptVersionBodyResponse` to `api.ts`**

Add `PromptDef` to the existing `import type { ... } from "./domain.js"` line (note: `PromptVersion` is only referenced transitively through `PromptDef`, so it need not be imported in `api.ts`), then append:

```ts
export interface PromptsResponse {
  generatedAt: string;
  /** `false` when the worker can't resolve prompts (degrades to empty list). */
  available: boolean;
  /** Whether Arthur is configured (key + endpoint + task id all set). When
   *  false, every prompt's `source` is "fallback" and `versions` is empty. */
  arthurEnabled: boolean;
  rows: PromptDef[];
  total: number;
}

/** On-demand body for a single historical Arthur version. */
export interface PromptVersionBodyResponse {
  generatedAt: string;
  available: boolean;
  body: string | null;
}
```

- [ ] **Step 3: Typecheck shared**

Run: `pnpm -F @apps/shared exec tsc --noEmit` (or repo-root `pnpm typecheck` if that's the established command — match how the runs plan was verified).
Expected: PASS.

---

### Task 2: Add Arthur version-list + by-version read methods to `ArthurClient`

**Files:**
- Modify: `apps/worker/src/sandbox/arthur-client.ts`
- Modify: `apps/worker/src/sandbox/arthur-client.test.ts` (add coverage for the new methods, matching the file's existing fetch-mock style)

**Context:** `ArthurClient` already has `getPromptByTag` (fetches a tagged version's body). Add two read methods, ground-truthed against `arthur-ai/arthur-engine` `main`. Both reuse the existing `this.baseUrl` + bearer header convention.

- [ ] **Step 1: Add types + `listPromptVersions`**

```ts
export interface ArthurPromptVersion {
  version: number;
  created_at: string;
  deleted_at: string | null;
  model_provider: string;
  model_name: string;
  tags: string[];
  num_messages: number;
  num_tools: number;
}
interface AgenticPromptVersionListResponse {
  count: number;
  versions: ArthurPromptVersion[];
}

/** List version metadata for a named prompt (newest first). First page only. */
async listPromptVersions(taskId: string, name: string): Promise<ArthurPromptVersion[]> {
  const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions`;
  const res = await fetch(`${this.baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${this.apiKey}`, "ngrok-skip-browser-warning": "true" },
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Arthur GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as AgenticPromptVersionListResponse;
  return [...data.versions].sort((a, b) => b.version - a.version);
}
```

> Assumption (open Q in spec): first page only — sufficient for the timeline. If deep history is required later, add pagination params here.

- [ ] **Step 2: Add `getPromptVersionBody`**

`getPromptByTag` already parses the by-version endpoint's `AgenticPrompt.messages[0].content` shape (passing a tag as `{prompt_version}`). Generalize it to accept any version specifier (integer / `latest` / ISO datetime / tag):

```ts
/** Fetch the body of a specific version (int | "latest" | ISO datetime | tag). Null on 404. */
async getPromptVersionBody(taskId: string, name: string, version: number | string): Promise<string | null> {
  const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(String(version))}`;
  const res = await fetch(`${this.baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${this.apiKey}`, "ngrok-skip-browser-warning": "true" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Arthur GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  const prompt = (await res.json()) as AgenticPrompt;
  return prompt.messages?.[0]?.content ?? null;
}
```

> `getPromptByTag` can optionally be refactored to delegate to `getPromptVersionBody(taskId, name, tag)` to remove duplication — low risk, but keep it a separate optional cleanup so the existing `loadPrompts` path is untouched if you skip it.

- [ ] **Step 3: Typecheck + test the worker**

Run: `pnpm -F @apps/worker exec tsc --noEmit` then `pnpm -F @apps/worker exec vitest run src/sandbox/arthur-client.test.ts`
Expected: PASS, including the new method tests.

---

### Task 3: Extract a reusable `resolvePrompts()` helper in the worker

**Files:**
- Create: `apps/worker/src/lib/prompts/resolve.ts` (or `apps/worker/src/lib/resolve-prompts.ts` — match existing `lib/` layout)
- Modify: `apps/worker/src/workflows/prompts-step.ts`

**Context:** `loadPrompts()` (`workflows/prompts-step.ts`) is a `"use step"` durable step returning `{ research, implement, review }`. The Arthur-vs-fallback resolution inside it is what we want to share. Extract the *pure* logic (no `"use step"`) so a plain h3 route can call it too, and have it also collect real version history. `loadPrompts()` then maps the helper's result back to its `{ research, implement, review }` shape so the workflow contract is unchanged.

- [ ] **Step 1: Create the helper (resolves production body + version history per prompt)**

```ts
// apps/worker/src/lib/prompts/resolve.ts
import type { PromptVersion } from "@shared/contracts";
import { env } from "../../../env.js";
import { logger } from "../logger.js";
import { PROMPT_FALLBACKS, PROMPT_NAMES, type PromptName } from "../prompts.js";

const PHASE_LABEL: Record<PromptName, string> = {
  "research-plan": "Research & Plan",
  "implement": "Implement",
  "review": "Review",
};

export interface ResolvedPrompt {
  name: PromptName;
  phase: string;
  body: string;
  source: "arthur" | "fallback";
  model: string;
  versions: PromptVersion[];
}

export interface ResolvePromptsResult {
  arthurEnabled: boolean;
  prompts: ResolvedPrompt[];
}

export async function resolvePrompts(): Promise<ResolvePromptsResult> {
  const model = env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL;
  const arthurEnabled =
    !!env.GENAI_ENGINE_API_KEY &&
    !!env.GENAI_ENGINE_TRACE_ENDPOINT &&
    !!env.GENAI_ENGINE_PROMPT_TASK_ID;

  const base = (
    name: PromptName, body: string, source: "arthur" | "fallback", versions: PromptVersion[] = [],
  ): ResolvedPrompt => ({ name, phase: PHASE_LABEL[name], body, source, model, versions });

  if (!arthurEnabled) {
    logger.info({ source: "fallback", reason: "arthur_prompts_disabled" }, "prompts_resolved");
    return {
      arthurEnabled,
      prompts: PROMPT_NAMES.map((n) => base(n, PROMPT_FALLBACKS[n], "fallback")),
    };
  }

  const { ArthurClient } = await import("../../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(
    env.GENAI_ENGINE_TRACE_ENDPOINT!,
    env.GENAI_ENGINE_API_KEY!,
  );
  const taskId = env.GENAI_ENGINE_PROMPT_TASK_ID!;

  async function one(name: PromptName): Promise<ResolvedPrompt> {
    try {
      const [body, rawVersions] = await Promise.all([
        client.getPromptByTag(taskId, name, "production"),
        client.listPromptVersions(taskId, name).catch(() => []),
      ]);
      const versions: PromptVersion[] = rawVersions.map((v) => ({
        version: v.version,
        createdAt: v.created_at,
        tags: v.tags,
        modelProvider: v.model_provider,
        modelName: v.model_name,
        numMessages: v.num_messages,
        numTools: v.num_tools,
      }));
      // Attach the eager production body to its matching version entry.
      const prodVersion = versions.find((v) => v.tags.includes("production"));
      if (prodVersion && body !== null) prodVersion.body = body;

      if (body === null) {
        logger.info({ name, source: "fallback", reason: "arthur_prompt_missing" }, "prompts_resolved");
        return base(name, PROMPT_FALLBACKS[name], "fallback", versions);
      }
      logger.info({ name, source: "arthur", versions: versions.length }, "prompts_resolved");
      return base(name, body, "arthur", versions);
    } catch (err) {
      logger.warn({ name, source: "fallback", err: (err as Error).message }, "prompts_resolved");
      return base(name, PROMPT_FALLBACKS[name], "fallback");
    }
  }

  const prompts = await Promise.all(PROMPT_NAMES.map(one));
  return { arthurEnabled, prompts };
}
```

> Verify the import depth (`../../../env.js`, `../logger.js`, `../prompts.js`, `../../sandbox/arthur-client.js`) against the file's actual location before finalizing — adjust to wherever you place it. The originals in `prompts-step.ts` import `../../env.js`, `./lib/logger.js`, `./lib/prompts.js` from `workflows/`. `@shared/contracts` is the same alias the routes use.

- [ ] **Step 2: Rewrite `loadPrompts()` to delegate to the helper**

Keep the `"use step"` directive, `maxRetries = 0`, and the `{ research, implement, review }` return shape. Replace the body with a call to `resolvePrompts()` and a map by name:

```ts
export async function loadPrompts(): Promise<LoadedPrompts> {
  "use step";
  const { resolvePrompts } = await import("../lib/prompts/resolve.js");
  const { prompts } = await resolvePrompts();
  const byName = Object.fromEntries(prompts.map((p) => [p.name, p.body]));
  return {
    research: byName["research-plan"],
    implement: byName["implement"],
    review: byName["review"],
  };
}
loadPrompts.maxRetries = 0;
```

- [ ] **Step 3: Run the existing prompts-step tests**

Run: `pnpm -F @apps/worker exec vitest run src/workflows/prompts-step.test.ts`
Expected: PASS. The test mocks `../sandbox/arthur-client.js` and `../../env.js`; if the helper's import paths differ, update the test's mock paths to match (the behavior — fallbacks when disabled, Arthur when enabled — is unchanged).

---

### Task 4: Add the worker routes (`GET /api/v1/prompts` + on-demand version body)

**Files:**
- Create: `apps/worker/src/routes/api/v1/prompts.get.ts`
- Create: `apps/worker/src/routes/api/v1/prompts/[name]/versions/[version].get.ts`

- [ ] **Step 1: Create the list route (mirror `runs.get.ts`)**

```ts
import { defineEventHandler, setResponseHeader } from "h3";
import type { PromptsResponse } from "@shared/contracts";
import { resolvePrompts } from "../../../lib/prompts/resolve.js";
import { logger } from "../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<PromptsResponse> => {
  setResponseHeader(
    event,
    "Cache-Control",
    "private, max-age=15, stale-while-revalidate=60",
  );

  const generatedAt = new Date().toISOString();
  try {
    const { arthurEnabled, prompts } = await resolvePrompts();
    return {
      generatedAt,
      available: true,
      arthurEnabled,
      rows: prompts,
      total: prompts.length,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "prompts_resolve_failed");
    return { generatedAt, available: false, arthurEnabled: false, rows: [], total: 0 };
  }
});
```

> `ResolvedPrompt` is structurally assignable to `PromptDef` (same fields incl. `versions`). If TS complains about the `PromptName` vs `string` `name` field, widen via `rows: prompts as PromptDef[]`. Confirm the auth gate that protects `/api/v1/*` (`lib/api-auth.ts`) is applied route-table-wide (not per-file) — no extra wiring needed.

- [ ] **Step 2: Create the on-demand version-body route (mirror `runs/[runId].get.ts`)**

```ts
// apps/worker/src/routes/api/v1/prompts/[name]/versions/[version].get.ts
import { defineEventHandler, setResponseHeader, getRouterParam } from "h3";
import type { PromptVersionBodyResponse } from "@shared/contracts";
import { env } from "../../../../../../env.js";
import { PROMPT_NAMES, type PromptName } from "../../../../../lib/prompts.js";
import { logger } from "../../../../../lib/logger.js";

export default defineEventHandler(async (event): Promise<PromptVersionBodyResponse> => {
  setResponseHeader(event, "Cache-Control", "private, max-age=15, stale-while-revalidate=60");
  const generatedAt = new Date().toISOString();

  const name = getRouterParam(event, "name") ?? "";
  const version = getRouterParam(event, "version") ?? "";
  const arthurEnabled =
    !!env.GENAI_ENGINE_API_KEY && !!env.GENAI_ENGINE_TRACE_ENDPOINT && !!env.GENAI_ENGINE_PROMPT_TASK_ID;

  if (!arthurEnabled || !PROMPT_NAMES.includes(name as PromptName) || !version) {
    return { generatedAt, available: false, body: null };
  }
  try {
    const { ArthurClient } = await import("../../../../../sandbox/arthur-client.js");
    const client = ArthurClient.fromTraceEndpoint(env.GENAI_ENGINE_TRACE_ENDPOINT!, env.GENAI_ENGINE_API_KEY!);
    const body = await client.getPromptVersionBody(env.GENAI_ENGINE_PROMPT_TASK_ID!, name, version);
    return { generatedAt, available: body !== null, body };
  } catch (err) {
    logger.warn({ name, version, err: (err as Error).message }, "prompt_version_body_failed");
    return { generatedAt, available: false, body: null };
  }
});
```

> Verify the relative import depth for this nested route path against the repo's actual `tsconfig`/route layout — count segments from `routes/api/v1/prompts/[name]/versions/` back to `apps/worker/{env.ts,src/lib,src/sandbox}`. Adjust `../` counts accordingly (the `env.ts` lives at `apps/worker/env.ts`, not under `src/`). Confirm h3's file-based dynamic-segment convention uses `[name]`/`[version]` here the same way `runs/[runId].get.ts` does.

- [ ] **Step 3: Typecheck the worker**

Run: `pnpm -F @apps/worker exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke the endpoints locally (optional but recommended)**

Start the worker, then:
`curl -s -H "Authorization: Bearer $WORKER_API_TOKEN" http://localhost:<port>/api/v1/prompts | jq`
Expected: `{ available: true, arthurEnabled: <env>, total: 3, rows: [3 prompts; each has body, source, model, versions[]] }`. With Arthur on, `versions` is non-empty and one entry carries `body`.
`curl -s -H "Authorization: Bearer $WORKER_API_TOKEN" http://localhost:<port>/api/v1/prompts/research-plan/versions/1 | jq`
Expected (Arthur on): `{ available: true, body: "..." }`; (Arthur off / missing): `{ available: false, body: null }`.

---

### Task 5: Add the dashboard fallback

**Files:**
- Modify: `apps/dashboard/lib/api/fallbacks.ts`

- [ ] **Step 1: Add `promptsFallback`**

Add `PromptsResponse` to the existing `import type { ... } from "@shared/contracts"`, then append:

```ts
export function promptsFallback(now: string): PromptsResponse {
  return { generatedAt: now, available: false, arthurEnabled: false, rows: [], total: 0 };
}
```

- [ ] **Step 2: Typecheck dashboard**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS (no new errors from this file).

---

### Task 6: Add the loading skeleton

**Files:**
- Create: `apps/dashboard/app/prompts-skeleton.tsx`

- [ ] **Step 1: Create the skeleton (mirror `overview-skeleton.tsx`)**

Header + 4-up KPI row + two-column (rail + detail) block matching the `/prompts` layout:

```tsx
// apps/dashboard/app/prompts-skeleton.tsx
function Block({ className = "" }: { className?: string }) {
  return <div className={`bg-neutral-200/60 rounded-sm animate-pulse ${className}`} />;
}

export function PromptsSkeleton() {
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <Block className="h-10 w-56" />
        <Block className="h-9 w-64" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Block key={i} className="h-[96px]" />
        ))}
      </div>
      <div className="flex flex-col lg:grid lg:grid-cols-[340px_1fr] gap-3 lg:min-h-[720px]">
        <Block className="lg:h-full h-[300px]" />
        <Block className="lg:h-full h-[400px]" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS.

---

### Task 7: Add the server data component + the client-side version-body proxy route

**Files:**
- Create: `apps/dashboard/app/prompts-data.tsx`
- Create: `apps/dashboard/app/api/prompts/[name]/versions/[version]/route.ts`

- [ ] **Step 1: Create the server component (mirror `runs-data.tsx`)**

```tsx
// apps/dashboard/app/prompts-data.tsx
import { getJSON } from "@/lib/api/server";
import { PromptsScreen } from "@/components/cockpit/screens/prompts";
import type { PromptsResponse } from "@shared/contracts";
import { promptsFallback } from "@/lib/api/fallbacks";

export async function PromptsData() {
  const now = new Date().toISOString();
  const data = await getJSON<PromptsResponse>("/api/v1/prompts").catch(() =>
    promptsFallback(now),
  );
  return <PromptsScreen data={data} />;
}
```

> This won't typecheck until Task 8 changes `PromptsScreen`'s signature. Expected; the full gate is in Task 9.

- [ ] **Step 2: Create the same-origin proxy route for lazy version bodies**

`PromptsScreen` is a client component; the bearer-gated worker API can't be hit from the browser (the token is server-only). Add a Next route handler that proxies the worker server-side:

```ts
// apps/dashboard/app/api/prompts/[name]/versions/[version]/route.ts
import { NextResponse } from "next/server";
import { getJSON } from "@/lib/api/server";
import type { PromptVersionBodyResponse } from "@shared/contracts";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string; version: string }> },
) {
  const { name, version } = await params;
  const now = new Date().toISOString();
  const data = await getJSON<PromptVersionBodyResponse>(
    `/api/v1/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  ).catch(() => ({ generatedAt: now, available: false, body: null }));
  return NextResponse.json(data);
}
```

> `params` is a Promise in Next 15 route handlers — confirm against the repo's Next version and existing route-handler conventions (check whether other `app/api/**/route.ts` files already exist to mirror their `params` typing). If none exist, this is the first; that's fine.

- [ ] **Step 3: Typecheck dashboard**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS for the route handler (the `prompts-data.tsx` line still fails until Task 8; full gate in Task 9).

---

### Task 8: Convert `PromptsScreen` to consume real data (with real version history)

**Files:**
- Modify: `apps/dashboard/components/cockpit/screens/prompts.tsx`

Keep the read-only registry + version-timeline shape, now backed by real data. **Remove** the per-version metrics grid and the two-column A/B diff (no Arthur source). Reuse existing `CkCard`, `CkKPI`, `Stat`, the chip styling, and the single-column mono body markup lifted from the old `PromptDiff`.

- [ ] **Step 1: Replace imports and remove mock dependency**

```tsx
"use client";

import React, { useState, useEffect } from "react";
import { CkCard, CkKPI } from "@/components/ui";
import type { PromptsResponse, PromptDef, PromptVersion } from "@shared/contracts";
```

Remove: `AIWF_DATA`, and the mock `Prompt`/`PromptVersion`/`PromptTag` imports from `@/lib/types` (the `PromptVersion` now comes from `@shared/contracts`). Remove `const D = AIWF_DATA`. Keep `useEffect` (used to reset/lazy-load the selected version body when the active prompt changes). `CkChip` stays if still used.

- [ ] **Step 2: Repurpose `PromptStatusChip` for real tags + source**

`PromptStatusChip` keys off a status string. Real statuses now are: the production tag (`production`) on a version, and the resolution `source` (`arthur`/`fallback`). Add `arthur`/`fallback` keys to `PROMPT_STATUS_COLOR` and keep the existing `production`/`staging`/`draft`/`archived`/`locked` keys (real Arthur `tags` may include any string — unknown tags fall through to the default style already coded).

- [ ] **Step 3: Rewrite `PromptList` to consume `PromptDef[]`**

- Signature: `function PromptList({ rows, active, onSelect }: { rows: PromptDef[]; active: string; onSelect: (name: string) => void })`.
- Tag filter pills: derive the option set from the tags that actually occur across `rows[].versions[].tags` (e.g. `["all", ...uniqueTags]`); filter rows by whether any of their versions carries the selected tag. (If no versions/tags exist — Arthur off — render just `all` or hide the pill row.)
- Each row keyed by `p.name`; show `p.name`, `p.phase`, `p.model`, the production-tag chip (from the version tagged `production`), and a `source` chip. Remove the eval score/delta figure.
- `eyebrow`: `` `${arthurEnabled ? "Arthur" : "In-code"} · ${rows.length} prompts` `` — thread `arthurEnabled` through as a prop.

- [ ] **Step 4: Rewrite `PromptDetail` — body panel + real version timeline**

- Signature: `function PromptDetail({ prompt }: { prompt: PromptDef | undefined })`.
- Keep the "Select a prompt to inspect." empty state when `prompt` is undefined.
- Header eyebrow: `{prompt.source === "arthur" ? "Arthur" : "In-code"} · {prompt.phase}`. Title: `prompt.name`. Action chips: the `source` chip. Leave the `+ New version` / `Deploy` buttons inert (read-only).
- Replace the four mock `Stat`s with real ones: `Phase` = `prompt.phase`, `Source` = `prompt.source`, `Model` = `prompt.model`, `Versions` = `prompt.versions.length`.
- **Version timeline (real):** map `prompt.versions` (newest first). Each card shows: `v{version}`, `createdAt` (format as-is or relative), tag chips (`v.tags`), `modelName`, and `numMessages`/`numTools` counts. **Delete** the mock per-card eval/halluc/p95/cost rows and the `traffic` bar. Clicking a version selects it for the body panel.
- **Body panel (single column, read-only):** lift the inner mono `<div>` markup from the old `PromptDiff` (drop the two-column diff). Default shows `prompt.body` (the production version). When the user selects a non-production version, fetch its body once via the proxy route and render it:
  ```tsx
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [bodyCache, setBodyCache] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  // reset selection when the prompt changes
  useEffect(() => { setSelectedVersion(null); }, [prompt?.name]);
  async function showVersion(v: PromptVersion) {
    setSelectedVersion(v.version);
    if (v.body) { setBodyCache((c) => ({ ...c, [v.version]: v.body! })); return; }
    if (bodyCache[v.version] !== undefined) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/prompts/${prompt!.name}/versions/${v.version}`);
      const json = (await res.json()) as { body: string | null };
      setBodyCache((c) => ({ ...c, [v.version]: json.body ?? "(version body unavailable)" }));
    } finally { setLoading(false); }
  }
  const shownBody = selectedVersion != null ? (bodyCache[selectedVersion] ?? (loading ? "Loading…" : "")) : prompt!.body;
  ```
- Delete the now-unused `PromptDiff` and `PromptMetrics` functions.

- [ ] **Step 5: Rewrite the top-level `PromptsScreen`**

```tsx
export function PromptsScreen({ data }: { data: PromptsResponse }) {
  const [active, setActive] = useState(data.rows[0]?.name ?? "");
  const selected = data.rows.find((p) => p.name === active);
  const inProd = data.rows.filter((p) => p.versions.some((v) => v.tags.includes("production"))).length;
  return (
    <div className="px-4 lg:px-6 pt-5 pb-8 flex flex-col gap-4">
      {/* header — keep the title; leave the inert Import/New buttons */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <CkKPI label="Prompts" value={data.total.toString()} sub="workflow phases" />
        <CkKPI label="In production" value={inProd.toString()} sub={data.arthurEnabled ? "tagged in Arthur" : "in-code defaults"} />
        {/* A/B + avg-Δ tiles removed — no real source */}
      </div>
      <div className="flex flex-col lg:grid lg:grid-cols-[340px_1fr] gap-3 lg:min-h-[720px]">
        <PromptList rows={data.rows} active={active} onSelect={setActive} arthurEnabled={data.arthurEnabled} />
        <PromptDetail prompt={selected} />
      </div>
    </div>
  );
}
```

> Reduced from 4 KPI tiles to 2 because the A/B-test and avg-eval-Δ tiles have no real source (removed, not stubbed). Adjust the grid (`lg:grid-cols-2`) accordingly.

- [ ] **Step 6: Verify no mock references remain**

Run: `grep -nE "AIWF_DATA|\\bD\\.|PROMPT_BODIES|PromptTag|from \"@/lib/types\"" apps/dashboard/components/cockpit/screens/prompts.tsx`
Expected: no matches (note `PromptVersion` now legitimately appears via `@shared/contracts`, so it's excluded from this grep).

---

### Task 9: Rewrite the route to the server pattern + verify

**Files:**
- Modify: `apps/dashboard/app/(cockpit)/prompts/page.tsx`

- [ ] **Step 1: Replace the page with the Suspense + server-component pattern**

```tsx
// apps/dashboard/app/(cockpit)/prompts/page.tsx — Prompts ("/prompts")
import { Suspense } from "react";

import { PromptsData } from "@/app/prompts-data";
import { PromptsSkeleton } from "@/app/prompts-skeleton";

export default function PromptsPage() {
  return (
    <Suspense fallback={<PromptsSkeleton />}>
      <PromptsData />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck the whole dashboard**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Lint the changed files**

Run: `cd apps/dashboard && npx next lint --file app/prompts-data.tsx --file app/prompts-skeleton.tsx --file "app/api/prompts/[name]/versions/[version]/route.ts" --file "app/(cockpit)/prompts/page.tsx" --file components/cockpit/screens/prompts.tsx`
Expected: no errors.

- [ ] **Step 4: Visual check**

Run: `cd apps/dashboard && pnpm dev`, open `/prompts`.
Expected:
- Three prompts listed (`research-plan`, `implement`, `review`) by phase + model.
- Selecting one shows its production body. With Arthur enabled, the version timeline lists real Arthur versions (version number, created-at, tags, model); clicking a historical version fetches and shows that version's body via `/api/prompts/{name}/versions/{version}`.
- With Arthur disabled, `source` chip reads `fallback`, the timeline is empty, and bodies match `apps/worker/src/lib/prompts.ts`.
- With the worker unreachable (`WORKER_BASE_URL` unset), the page shows the empty state (`0 prompts`), no crash. A failed version-body fetch shows an inline "version body unavailable" note, no crash.

- [ ] **Step 5: Commit (ONLY if the user asks)**

```bash
git add apps/shared/contracts/api.ts apps/shared/contracts/domain.ts \
  apps/worker/src/sandbox/arthur-client.ts apps/worker/src/sandbox/arthur-client.test.ts \
  apps/worker/src/lib/prompts/resolve.ts apps/worker/src/workflows/prompts-step.ts \
  apps/worker/src/routes/api/v1/prompts.get.ts \
  "apps/worker/src/routes/api/v1/prompts/[name]/versions/[version].get.ts" \
  apps/dashboard/lib/api/fallbacks.ts apps/dashboard/app/prompts-data.tsx \
  "apps/dashboard/app/api/prompts/[name]/versions/[version]/route.ts" \
  apps/dashboard/app/prompts-skeleton.tsx "apps/dashboard/app/(cockpit)/prompts/page.tsx" \
  apps/dashboard/components/cockpit/screens/prompts.tsx
git commit -m "feat: wire /prompts to real worker data with Arthur version history"
```

---

## Self-Review

**Spec coverage:**
- `PromptVersion` + `PromptDef` + `PromptsResponse` + `PromptVersionBodyResponse` contracts → Task 1. ✓
- Arthur read methods (`listPromptVersions`, `getPromptVersionBody`) → Task 2. ✓
- Real data source (Arthur production tags + in-code fallbacks) + version history via shared `resolvePrompts()` → Task 3. ✓
- Worker list route `GET /api/v1/prompts` + on-demand body route `GET /api/v1/prompts/[name]/versions/[version]` → Task 4. ✓
- Dashboard `promptsFallback` → Task 5. ✓
- `prompts-skeleton.tsx` → Task 6. ✓
- `prompts-data.tsx` server component + client-side version-body proxy route → Task 7. ✓
- `PromptsScreen` swap to read-only real-data view with real version timeline; per-version metrics + A/B diff markup removed → Task 8. ✓
- Page route → server pattern → Task 9. ✓
- Worker-down empty state → `promptsFallback` (Task 5) + route catch (Task 4), verified in Task 9 Step 4. ✓
- Embellishment removal (per-version eval/halluc/p95/cost, traffic split, eval Δ, A/B test KPI) — markup deleted, not stubbed (Task 8). ✓

**Decisions resolved (no longer open):** read-only confirmed; real version history in scope (metadata + on-demand bodies); tags are real; `resolvePrompts()` extraction confirmed OK; production-body eager / historical lazy.

**Still-open items (flagged in spec, do not block execution):**
1. Lazy vs eager historical body fetch — plan implements eager-production / lazy-history; switch if the user prefers otherwise.
2. Version-list pagination depth — plan fetches first page only; add pagination if deep history is required.

**Type consistency:** `PromptsResponse`/`PromptDef`/`PromptVersion`/`PromptVersionBodyResponse` imported from `@shared/contracts` across Tasks 3, 4, 5, 7, 8. `PromptsScreen` accepts `{ data: PromptsResponse }` (Task 8) — matches the call site (Task 7). `ResolvedPrompt` (worker) is structurally assignable to `PromptDef` (incl. `versions: PromptVersion[]`); widen the `name` field if TS narrows on the literal union. `ArthurPromptVersion` (snake_case Arthur shape) is mapped to the camelCase `PromptVersion` inside `resolvePrompts()`. `PromptsSkeleton` (Task 6) matches the import in Task 9. ✓

**Placeholder scan:** No TBD/TODO. Verify, when executing: worker route import depths (esp. the nested `prompts/[name]/versions/[version].get.ts` path), the Next route-handler `params` Promise convention against the repo's Next version, and the worker dev-run command — all flagged inline. ✓
</content>
