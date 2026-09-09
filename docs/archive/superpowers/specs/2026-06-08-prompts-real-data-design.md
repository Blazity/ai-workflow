# `/prompts` Real-Data Conversion — Design

**Date:** 2026-06-08
**Status:** Approved
**Scope:** Swap the existing `/prompts` page from mock data to live worker data, mirroring the `/runs` and overview pattern. **Read-only display, including real Arthur version history.** No write/edit endpoints. Embellishment fields with no real backing are removed (markup deleted, not stubbed with placeholders).

## Problem

The `/prompts` dashboard page (`apps/dashboard/app/(cockpit)/prompts/page.tsx`) renders a full prompt-registry UI but is wired entirely to mock data (`AIWF_DATA.PROMPTS`, `PROMPT_VERSIONS`, `PROMPT_BODIES` from `@/lib/data/mock`). The overview and `/runs` pages already fetch real data from the worker through a server-component pattern. We want `/prompts` to show the prompts the worker actually drives the AI workflow with.

## Real data source (the important finding)

In this project, "prompts" are the three system prompts that drive each workflow phase. They live in the worker, not in a CMS:

- **Static fallbacks (source of truth in code):** `apps/worker/src/lib/prompts.ts` defines three constant strings — `researchPlanPrompt`, `implementPrompt`, `reviewPrompt` — exported as `PROMPT_FALLBACKS: Record<PromptName, string>` keyed by `PROMPT_NAMES = ["research-plan", "implement", "review"]`.
- **Optional runtime override (Arthur GenAI Engine):** `apps/worker/src/workflows/prompts-step.ts`'s `loadPrompts()` step checks whether `GENAI_ENGINE_API_KEY`, `GENAI_ENGINE_TRACE_ENDPOINT`, and `GENAI_ENGINE_PROMPT_TASK_ID` are all set. If so, it fetches the `production`-tagged version of each prompt from Arthur via `ArthurClient.getPromptByTag(taskId, name, "production")` (`apps/worker/src/sandbox/arthur-client.ts`). On 404 / error / Arthur disabled it falls back to the in-code `PROMPT_FALLBACKS` string for that name.
- **Seeding:** `apps/worker/scripts/setup-arthur-prompts.ts` is a one-shot script that pushes the three fallback strings into a single Arthur task named `ai-workflow-prompts` and tags each `production`. This is the only writer; nothing in the request/runtime path writes prompts.

**Arthur read API (ground-truthed against `arthur-ai/arthur-engine` `main`).** Auth is the same `Authorization: Bearer GENAI_ENGINE_API_KEY`; prompt reads require the `TASK_READ` scope. Three endpoints are relevant:

- **List versions (metadata only):** `GET /api/v1/tasks/{task_id}/prompts/{prompt_name}/versions` → `AgenticPromptVersionListResponse { count, versions: AgenticPromptVersionResponse[] }`. Each `AgenticPromptVersionResponse`: `{ version (int), created_at, deleted_at (nullable), model_provider, model_name, tags: string[], num_messages, num_tools }`. **No message body and no per-version eval metrics.**
- **Fetch a version body:** `GET /api/v1/tasks/{task_id}/prompts/{prompt_name}/versions/{prompt_version}` where `{prompt_version}` accepts `latest` | an integer | an ISO datetime | a tag → `AgenticPrompt { messages }`. This is the endpoint the existing `ArthurClient.getPromptByTag` already uses (it passes a tag). We use it to fetch the body of any specific version (the `production`-tagged one eagerly; an arbitrary version on demand).
- **List all prompts on a task:** `GET /api/v1/tasks/{task_id}/prompts` → `LLMGetAllMetadataListResponse { count, llm_metadata: [{ name, versions, tags, created_at, latest_version_created_at, deleted_versions }] }`. Not strictly needed — our three phase-prompt names are fixed — so we don't use it.

**Conclusion:** there is no editable prompt *registry* in this app, and the worker never persists prompt metadata locally — but Arthur **does** expose real version history (version number, created-at, tags, model) per named prompt, plus on-demand bodies. So the real, available data per phase prompt is: a stable name, the human phase label, the resolved **production body**, the resolved `source` (`arthur` | `fallback`), the model, and a list of **real Arthur versions** (`{ version, createdAt, tags, modelProvider, modelName, numMessages, numTools }`).

This makes the conversion a faithful read-only swap **with real version history**. The mock-only fields that have **no Arthur source** — per-version eval/halluc/p95/cost metrics, traffic split, KPI deltas, `lastEditedBy`, the two-version A/B text diff — are **removed** (markup deleted, not replaced with static placeholders). Tags are real (`AgenticPromptVersionResponse.tags`), so a `production` badge and a tag filter are backed by data and kept.

## Current state (mock)

`apps/dashboard/components/cockpit/screens/prompts.tsx` (`PromptsScreen`) consumes three mock slices via `const D = AIWF_DATA`:

1. `D.PROMPTS: Prompt[]` — 7 entries. Per the mock `Prompt` type (`apps/dashboard/lib/types.ts:64`):
   `id`, `name`, `workflow`, `workflowName`, `span`, `versionCount`, `current`, `trafficSplit: Record<string, number>`, `evalScore`, `evalDelta`, `lastEditedBy`, `lastEditedAtMin`, `tags: PromptTag[]`, `model`.
2. `D.PROMPT_VERSIONS: Record<string, PromptVersion[]>` — only `p_plan_changes` has history. Per `PromptVersion` (`types.ts:81`):
   `v`, `deployedAt`, `by`, `status: PromptTag`, `traffic`, `evalScore`, `runs`, `costAvg`, `p95`, `halluc`, `change`.
3. `D.PROMPT_BODIES: Record<string, string>` — body text keyed by version label (`v12`, `v11`).

`PromptTag = "production" | "staging" | "draft" | "archived" | "locked" | "ab-test"`.

What the screen renders from these:
- **Header KPIs** (`CkKPI`): total prompts, count in `production`, count of `ab-test`, and a hardcoded `"+0.4%"` avg eval delta.
- **Left rail `PromptList`:** tag filter pills (`all/production/staging/draft/locked`), per-prompt row showing `name`, `current` version, `workflowName`, tag chips, and an `evalScore`/`evalDelta` figure.
- **Right pane `PromptDetail`:** header eyebrow `Arthur · {workflowName} → {span}`, `+ New version` / `Deploy` buttons, four `Stat`s (current version, version count, eval score, traffic split), a **version timeline** of `PromptVersion[]`, a two-column **text diff** between two selected versions (`PromptDiff`, reads `PROMPT_BODIES`), and a **side-by-side metrics** table (`PromptMetrics`: evalScore/halluc/p95/costAvg/runs). It already has graceful empty states: "Select a prompt to inspect." and "Detailed version history not yet captured for this prompt." (rendered when `versions.length === 0`).

The page (`app/(cockpit)/prompts/page.tsx`) is a 4-line stub that renders `<PromptsScreen />` with no data fetch.

## Existing pattern (template)

Real data flows through three layers (see `app/overview-data.tsx`, `app/runs-data.tsx`):

1. `app/(cockpit)/<view>/page.tsx` — thin server route: `<Suspense fallback={<Skeleton/>}><Data/></Suspense>`.
2. `app/<view>-data.tsx` — **server component**: calls `getJSON<T>(path)` (`lib/api/server.ts`, server-only fetch with `Bearer WORKER_API_TOKEN`, `cache: "no-store"`, 10s timeout), `.catch()`es to a fallback in `lib/api/fallbacks.ts`, passes a `data` prop to the client screen.
3. `components/cockpit/screens/<view>.tsx` — **client presenter**: receives `data`, renders. Untracked metrics arrive `null`/empty and render as `—` or an empty state.

Worker routes live under `apps/worker/src/routes/api/v1/*.get.ts` as h3 `defineEventHandler`s returning a typed `@shared/contracts` response, gated by the shared bearer token (`apps/worker/src/lib/api-auth.ts`). Response interfaces are declared in `apps/shared/contracts/api.ts`; row/entity types in `apps/shared/contracts/domain.ts`.

## Proposed data contract

Add to `apps/shared/contracts/api.ts`. Entity type goes in `domain.ts` (currently has no prompt type).

### `apps/shared/contracts/domain.ts` (new entities)

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
   *  versions are fetched on demand via the by-version endpoint. */
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

### `apps/shared/contracts/api.ts` (new response)

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

**Body fetch strategy — decided: eager for the production version, lazy for the rest.** The list response carries every phase prompt with its full `versions` metadata array and the **production body eagerly** on `PromptDef.body` (we already fetch it to resolve what the workflow uses, so it's free). Non-production version bodies are NOT shipped in this response — `PromptVersion.body` is `undefined` for them. When the user expands a historical version, the screen fetches that single body on demand through a second worker route (see "Worker routes"). This keeps the list response small (3 bodies, not N) and avoids fanning out an unbounded number of Arthur body calls per page load.

Notes:
- `available` follows the `RunsResponse`/`RunDetailResponse` convention: `true` on a successful resolve, `false` in the fallback object.
- `arthurEnabled` lets the screen honestly say "showing in-code defaults" vs "showing production prompts from Arthur".
- Per-version eval/halluc/p95/cost metrics, traffic split, and `lastEditedBy` are **not** in the contract — Arthur's version list is metadata only and has no such source. The screen markup that rendered them is removed.

## Worker routes

### `GET /api/v1/prompts` — list (new file `apps/worker/src/routes/api/v1/prompts.get.ts`, mirrors `runs.get.ts`)

- `defineEventHandler` returning `PromptsResponse`, same `Cache-Control: private, max-age=15, stale-while-revalidate=60` header.
- Resolve all three phase prompts via a shared helper `resolvePrompts()`. The exact production-body resolution already lives in `loadPrompts()` (`workflows/prompts-step.ts`), which is a `"use step"` durable step returning `{ research, implement, review }` — not callable from a plain h3 route. **Decision (option A, confirmed OK to touch the step):** extract the pure resolution into `apps/worker/src/lib/prompts/resolve.ts`, returning `PromptDef[]` + `arthurEnabled`, and have **both** `loadPrompts()` and the route call it. Single source of truth, no drift.
- Per prompt, `resolvePrompts()` does:
  - `model` = `env.AGENT_KIND === "codex" ? env.CODEX_MODEL : env.CLAUDE_MODEL` (same expression as `runs.get.ts`).
  - `phase` from a static label map: `research-plan → "Research & Plan"`, `implement → "Implement"`, `review → "Review"`.
  - When Arthur is enabled: fetch the `production`-tagged body via the existing `ArthurClient.getPromptByTag(taskId, name, "production")` (→ `body`, `source: "arthur"`), AND fetch the version list via a new `ArthurClient.listPromptVersions(taskId, name)` (→ `versions: PromptVersion[]`, newest first). Any single failure degrades that prompt to its in-code fallback body, `source: "fallback"`, `versions: []` — same per-prompt try/catch the current step already has.
  - When Arthur is disabled: `body` = `PROMPT_FALLBACKS[name]`, `source: "fallback"`, `versions: []`.
- `available: true` on success; the `catch` returns the empty `available:false` object (matching `runs.get.ts`). Resolution rarely fully throws because each prompt independently falls back, so the happy path always has three rows.

### `GET /api/v1/prompts/[name]/versions/[version]` — on-demand body (new file)

Backs lazy body fetching for historical versions the user expands. New file `apps/worker/src/routes/api/v1/prompts/[name]/versions/[version].get.ts` (h3 dynamic-segment pattern, same as the existing `runs/[runId].get.ts`):

- Reads route params `name` and `version`, validates `name` against `PROMPT_NAMES` (404/empty otherwise), calls a new `ArthurClient.getPromptVersionBody(taskId, name, version)` which hits `GET /api/v1/tasks/{task_id}/prompts/{name}/versions/{version}` and returns the first message content (the existing `getPromptByTag` already parses this `AgenticPrompt.messages[0].content` shape — generalize it to accept any `{prompt_version}`).
- Returns a small typed response `PromptVersionBodyResponse { generatedAt; available: boolean; body: string | null }` (add to `api.ts`). When Arthur is disabled or the version is missing → `available:false, body:null`.
- Same `Cache-Control` header and bearer gate as the other v1 routes.

## Dashboard wiring

1. **`lib/api/fallbacks.ts`** — add `promptsFallback(now)`:
   ```ts
   export function promptsFallback(now: string): PromptsResponse {
     return { generatedAt: now, available: false, arthurEnabled: false, rows: [], total: 0 };
   }
   ```
2. **`app/prompts-data.tsx`** (new server component), single fetch like `runs-data.tsx`:
   ```ts
   const data = await getJSON<PromptsResponse>("/api/v1/prompts").catch(() => promptsFallback(now));
   return <PromptsScreen data={data} />;
   ```
3. **`app/prompts-skeleton.tsx`** (new) — header + KPI row + two-column (rail + detail) block, styled like `overview-skeleton.tsx`.
4. **`app/(cockpit)/prompts/page.tsx`** — rewrite to the `<Suspense fallback={<PromptsSkeleton/>}><PromptsData/></Suspense>` shape.
5. **`components/cockpit/screens/prompts.tsx`** — change `PromptsScreen()` to `PromptsScreen({ data }: { data: PromptsResponse })`. Map the real `PromptDef[]` onto the existing UI. Keep the tag filter and version timeline (now real), but **delete** the per-version metrics grid and the two-column A/B diff (no backing data). Historical-version body expansion fetches lazily from the on-demand route.
6. **On-demand version-body fetch (client).** `PromptsScreen` is a `"use client"` presenter, so expanding a historical version does a client-side `fetch`. The bearer-gated worker API is not directly reachable from the browser (the `WORKER_API_TOKEN` is server-only — see `lib/api/server.ts`). So add a thin Next route handler `app/api/prompts/[name]/versions/[version]/route.ts` that re-uses `getJSON<PromptVersionBodyResponse>("/api/v1/prompts/<name>/versions/<version>")` server-side and returns it to the client. The screen fetches `/api/prompts/{name}/versions/{version}` (same-origin, no token exposure). Cache the resolved body in component state so re-expanding doesn't refetch.

### Screen mapping (mock field → real field / behavior)

| Mock usage | Real replacement |
|---|---|
| `D.PROMPTS` list | `data.rows` (3 `PromptDef`) |
| `p.id` (row key, selection) | `p.name` (stable key) |
| `p.name` | `p.name` |
| `p.workflowName` / `p.span` (eyebrow) | `p.phase` (eyebrow `{data.arthurEnabled ? "Arthur" : "In-code"} · {p.phase}`) |
| `p.current` version badge | real: highest `p.versions[].version`, or the production-tagged version number; show `source` chip alongside |
| `p.tags` chips + tag filter pills | **kept, real** — derive the row's tags from its production version's `tags` (`p.versions.find(v => v.tags.includes("production"))?.tags`), and per-version `tags` in the timeline. Filter pills reduced to tags that actually occur (e.g. `all` + `production`). |
| `p.evalScore` / `p.evalDelta` | **removed** (no Arthur source — markup deleted) |
| `D.PROMPT_VERSIONS[id]` timeline | **kept, real** — `p.versions` (`{version, createdAt, tags, modelName, numMessages, numTools}`), newest first. Each entry shows version number, `createdAt`, tag chips, `modelName`, message/tool counts. The mock's eval/halluc/p95/cost rows in each timeline card are **removed**. |
| `D.PROMPT_BODIES[v]` two-column diff (`PromptDiff`) | **removed** — replaced by a single read-only body panel. Shows `p.body` (production) by default; clicking a timeline version fetches that version's body via the on-demand route and renders it in the same panel. |
| `PromptMetrics` side-by-side table | **removed** (no per-version metrics) |
| Header KPIs (total / production / ab-test / avg Δ) | total = `data.total`; "In production" = count of rows whose versions include a `production` tag; ab-test and avg-Δ tiles **removed** (no source) |
| `+ New version` / `Deploy` / `Import from prod` / `+ New prompt` buttons | left inert (read-only), matching how `/runs` left its `+ Filter` / `Export` buttons |

Faithful render: left rail lists the 3 prompts by `name` + `phase` + `model` + production tag chip; right pane shows a read-only body panel (production body by default, swappable to a selected historical version fetched on demand) plus the real version timeline. Reuses `CkCard`/`CkKPI`/`Stat`, the chip styling (repurposed for real `tags`), and the single-column body markup lifted from the old `PromptDiff`.

## Behavior

- **Happy path (Arthur disabled — current production reality):** `/prompts` lists the 3 workflow prompts with their in-code fallback bodies, `source: "fallback"`, `arthurEnabled: false`, `versions: []`. Eyebrow reflects "In-code". The version timeline section is empty (no markup, since there are no versions). Bodies are exactly what the agent runs.
- **Happy path (Arthur enabled):** each prompt's production body and full real version history come from Arthur (`source: "arthur"`). The timeline lists every Arthur version with its real `version`, `createdAt`, `tags`, and `modelName`. Expanding a historical version fetches its body on demand via `GET /api/v1/prompts/[name]/versions/[version]`. A prompt that fails to resolve from Arthur degrades to its fallback body with `versions: []`.
- **Worker down / 401:** `getJSON` throws → `promptsFallback` → empty list, `available:false`. The screen shows its "Select a prompt to inspect." empty state with `0 prompts`. No crash. Same silent-fallback as `/runs`. An on-demand body fetch that fails renders an inline "version body unavailable" note, not a page crash.

## Out of scope

- Editing, creating, deploying, or version-bumping prompts (the `+ New version` / `Deploy` / `Import from prod` / `+ New prompt` buttons stay inert).
- Per-version eval/halluc/p95/cost metrics and the two-version A/B text diff — no Arthur source; markup removed.
- Traffic split, `lastEditedBy`, eval deltas — no source; markup removed.
- Wiring the `/editor` view (separate `workflow-editor` screen).

## Open questions / assumptions

Resolved by user decisions and Arthur API ground-truthing:

- **Read-only — confirmed.** No write endpoints; action buttons stay inert.
- **Version history — confirmed in scope.** Real Arthur version history (metadata + on-demand bodies) is included. Per-version eval metrics are NOT available from Arthur's version-list endpoint (metadata only: `{version, created_at, tags, model_name, num_messages, num_tools}`), so the mock's per-version metrics are dropped — confirmed acceptable.
- **Tags are real.** The `production` badge and the tag filter are backed by `AgenticPromptVersionResponse.tags`; kept.
- **Resolution-helper extraction — confirmed.** Shared `resolvePrompts()` used by both `loadPrompts()` and the route; OK to touch `prompts-step.ts`.
- **Embellishment fields — removed, not stubbed.** Per the user decision, fields with no real backing have their markup deleted rather than rendered as static placeholders.

Still open:

1. **Lazy vs eager body fetch — proposed eager-for-production, lazy-for-history.** Stated above; flagged here in case you'd rather ship all version bodies eagerly (simpler client, larger/slower response) or fetch even the production body lazily (smaller list response, extra round-trip on first view).
2. **Version pagination depth.** Arthur's `…/versions` endpoint is paginated. Assumption: fetch the first page only (newest N, e.g. default page size) and not the full history — sufficient for the timeline. Confirm whether deep history (all pages) is required.

## Verification

1. `apps/shared` + `apps/worker` typecheck (`pnpm -F @apps/worker typecheck` or `npx tsc --noEmit`).
2. Worker `GET /api/v1/prompts` returns 3 rows with non-empty `body`, correct `source`, `arthurEnabled` reflecting env, and (Arthur on) a non-empty `versions[]` with real `version`/`createdAt`/`tags`. Existing `prompts-step` tests still pass.
3. Worker `GET /api/v1/prompts/research-plan/versions/<n>` returns that version's `body` (Arthur on) or `available:false` (Arthur off / missing).
4. Dashboard typecheck passes.
5. `/prompts` renders the 3 real prompts; selecting one shows its production body; the timeline lists real Arthur versions; expanding one fetches and shows that version's body. With Arthur disabled, `source` is `fallback`, the timeline is empty, and bodies match `apps/worker/src/lib/prompts.ts`.
6. With the worker unreachable, `/prompts` shows the empty state (`0 prompts`), not an error.
</content>
</invoke>
