# Arthur-Hosted Prompts With Codebase Fallback

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `research-plan`, `implement`, and `review` prompts be edited in Arthur without code changes, while keeping the current hardcoded strings as an automatic fallback when Arthur isn't configured or is unreachable. When Arthur *is* configured with a "prompt host" task, the workflow fetches the `production`-tagged version of each prompt at the start of every run. On any failure (missing env, 404, network error) it silently falls back to the hardcoded strings.

**Architecture:**

- New env var `GENAI_ENGINE_PROMPT_TASK_ID` — UUID of a dedicated Arthur task whose only job is to host the three prompts. Kept separate from the per-run trace tasks (`AWT-42`, `AWT-42.1`, …) so prompt edits don't require re-seeding per ticket.
- `ArthurClient` gains three prompt methods (`getPromptByTag`, `createPromptVersion`, `tagPromptVersion`). Each prompt is stored in Arthur as a single-message chat (`[{role: "user", content: "<markdown>"}]`) and retrieved back via `messages[0].content`.
- A new workflow step `loadPrompts()` runs once per workflow run, returns `{research, implement, review}`, and logs the source (`arthur` or `fallback`) per prompt. Result is checkpointed in workflow history so replays reuse the same strings.
- Three `getPrompt("research-plan.md" | "implement.md" | "review.md")` call sites in `src/workflows/agent.ts` are replaced by indexing into the `loadPrompts()` return value.
- One-shot `pnpm setup:arthur-prompts` script **creates-or-finds** a task named `ai-workflow-prompts`, seeds the three prompts on it (each saved as a new version, tagged `production`), and prints the UUID in a paste-ready `GENAI_ENGINE_PROMPT_TASK_ID=<uuid>` line. Idempotent — re-running finds the existing task and creates new versions, so it's safe after prompt edits.

**Tech Stack:** TypeScript, Vitest, native `fetch` (same pattern as `src/adapters/issue-tracker/jira.ts`), `@t3-oss/env-core` + Zod, Workflow DevKit (`"use step"`).

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `env.ts` | **Modify** | Add optional `GENAI_ENGINE_PROMPT_TASK_ID: z.string().uuid().optional()`. |
| `src/sandbox/arthur-client.ts` | **Modify** | Add `getPromptByTag`, `createPromptVersion`, `tagPromptVersion`. Export a helper type for the agentic-prompt response. |
| `src/sandbox/arthur-client.test.ts` | **Modify** | Add 5 tests covering the three new methods (happy path, 404 returns null, auth + body shape for save + tag). |
| `src/lib/prompts.ts` | **Modify** | Export a new `PROMPT_NAMES` array + `PROMPT_FALLBACKS` record mapped by Arthur prompt name (no `.md`). Keep `getPrompt(name)` for backwards compat (now delegates to the fallbacks record keyed by `.md` filename). |
| `src/workflows/prompts-step.ts` | **Create** | New module housing the `loadPrompts()` step. Single export. Contains its own `"use step"` directive. Returns `{research: string, implement: string, review: string}` and per-prompt source logging. |
| `src/workflows/prompts-step.test.ts` | **Create** | 4 unit tests: (a) no Arthur env → fallback for all three; (b) Arthur returns all three → Arthur wins; (c) Arthur 404 on one → that one falls back, other two come from Arthur; (d) `PROMPT_TASK_ID` set but `API_KEY` missing → fallback (invalid config treated as disabled). |
| `src/workflows/agent.ts` | **Modify** | Call `loadPrompts()` once near the top of the workflow body (right after `fetchAndValidateTicket`). Replace the three inline `getPrompt(...)` calls with `prompts.research` / `.implement` / `.review`. |
| `scripts/setup-arthur-prompts.ts` | **Create** | Find-or-create the `ai-workflow-prompts` task, seed the three prompts on it, tag each version `production`, print the paste-ready `GENAI_ENGINE_PROMPT_TASK_ID=<uuid>` line. Requires `GENAI_ENGINE_API_KEY` + `GENAI_ENGINE_TRACE_ENDPOINT` in `.env`. |
| `package.json` | **Modify** | Add script `"setup:arthur-prompts": "tsx scripts/setup-arthur-prompts.ts"`. |

No changes to `configureStopHook`, Arthur tracer install, SandboxManager, or any VCS/issue-tracker adapter. The prompt-host task is auto-created on first setup run; re-runs find it by name and seed new versions — so there's at most one `ai-workflow-prompts` task per Arthur instance.

---

## Shared Types

```ts
// src/sandbox/arthur-client.ts
export interface AgenticPrompt {
  name: string;
  messages: Array<{ role: string; content: string; /* other OpenAI fields ignored */ }>;
  version?: number | string; // Arthur returns this — used for tagging
}
```

```ts
// src/workflows/prompts-step.ts
export interface LoadedPrompts {
  research: string;
  implement: string;
  review: string;
}
```

`PROMPT_NAMES` (defined in `src/lib/prompts.ts`) is the canonical list used by both the seed script and `loadPrompts()`:

```ts
export const PROMPT_NAMES = ["research-plan", "implement", "review"] as const;
export type PromptName = typeof PROMPT_NAMES[number];
```

---

## Task 1: Env var for the prompt-host task

**Files:** `env.ts`

- [ ] **Step 1:** In `env.ts`, add below the existing Arthur env vars (immediately after `GENAI_ENGINE_TRACE_ENDPOINT`):

```ts
    GENAI_ENGINE_PROMPT_TASK_ID: z.string().uuid().optional(),
```

- [ ] **Step 2:** Run `pnpm typecheck`. Expect PASS.

- [ ] **Step 3:** Commit: `git add env.ts && git commit -m "feat(env): add optional GENAI_ENGINE_PROMPT_TASK_ID"`.

---

## Task 2: Expose prompt names + fallbacks for shared use

**Files:** `src/lib/prompts.ts`

- [ ] **Step 1:** At the top of `src/lib/prompts.ts` (below the existing three `const ...Prompt = \`…\`` blocks, above `const prompts: Record<string, string>`), add:

```ts
export const PROMPT_NAMES = ["research-plan", "implement", "review"] as const;
export type PromptName = typeof PROMPT_NAMES[number];

/** Fallback strings keyed by Arthur prompt name (no `.md` suffix). */
export const PROMPT_FALLBACKS: Record<PromptName, string> = {
  "research-plan": researchPlanPrompt,
  "implement": implementPrompt,
  "review": reviewPrompt,
};
```

Leave the existing `prompts` record and `getPrompt()` export untouched — no caller is being moved in this task.

- [ ] **Step 2:** `pnpm typecheck`. PASS.

- [ ] **Step 3:** Commit: `git add src/lib/prompts.ts && git commit -m "refactor(prompts): expose PROMPT_NAMES and PROMPT_FALLBACKS"`.

---

## Task 3: `ArthurClient` prompt methods

**Files:** `src/sandbox/arthur-client.ts`, `src/sandbox/arthur-client.test.ts`

- [ ] **Step 1:** Write failing tests. Append to `src/sandbox/arthur-client.test.ts` (inside the existing `describe("ArthurClient", ...)`):

```ts
  describe("prompts", () => {
    it("getPromptByTag returns messages[0].content on 200", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: "research-plan",
        version: 3,
        messages: [{ role: "user", content: "the prompt body" }],
      }));
      const client = new ArthurClient("http://host", "k");
      const body = await client.getPromptByTag("task-uuid", "research-plan", "production");
      expect(body).toBe("the prompt body");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/task-uuid/prompts/research-plan/versions/tags/production");
    });

    it("getPromptByTag returns null on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
      const client = new ArthurClient("http://host", "k");
      expect(await client.getPromptByTag("t", "research-plan", "production")).toBeNull();
    });

    it("createPromptVersion POSTs single-message body with user role", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: "implement",
        version: 5,
        messages: [{ role: "user", content: "x" }],
      }));
      const client = new ArthurClient("http://host", "k");
      const result = await client.createPromptVersion("task-uuid", "implement", "x");
      expect(result.version).toBe(5);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/task-uuid/prompts/implement");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.messages).toEqual([{ role: "user", content: "x" }]);
    });

    it("tagPromptVersion PUTs the tag", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "review", version: 2, messages: [] }));
      const client = new ArthurClient("http://host", "k");
      await client.tagPromptVersion("t", "review", 2, "production");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/t/prompts/review/versions/2/tags");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ tag: "production" });
    });

    it("getPromptByTag throws on non-404 non-2xx (5xx)", async () => {
      mockFetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      const client = new ArthurClient("http://host", "k");
      await expect(client.getPromptByTag("t", "x", "production")).rejects.toThrow(/500/);
    });
  });
```

- [ ] **Step 2:** Run `pnpm test -- arthur-client.test.ts`. Expect FAIL — methods don't exist.

- [ ] **Step 3:** Add an interface export and three methods to `src/sandbox/arthur-client.ts`. Place the interface right below `ArthurTask`:

```ts
export interface AgenticPrompt {
  name: string;
  version?: number | string;
  messages: Array<{ role: string; content: string }>;
}
```

Then add these methods inside `ArthurClient`, right after `ensureTaskForTicket`:

```ts
  /** Fetch a tagged prompt version. Returns the first message's content, or null if 404. */
  async getPromptByTag(taskId: string, name: string, tag: string): Promise<string | null> {
    const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/tags/${encodeURIComponent(tag)}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "ngrok-skip-browser-warning": "true",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Arthur GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    const prompt = (await res.json()) as AgenticPrompt;
    const first = prompt.messages?.[0];
    return first?.content ?? null;
  }

  /** Create a new version of a named prompt on a task. Content is sent as a single user message. */
  async createPromptVersion(taskId: string, name: string, content: string): Promise<AgenticPrompt> {
    return this.request<AgenticPrompt>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          model_name: "claude-sonnet-4",
          model_provider: "anthropic",
        }),
      },
    );
  }

  /** Add a tag (e.g. "production") to a specific version. */
  async tagPromptVersion(taskId: string, name: string, version: number | string, tag: string): Promise<void> {
    await this.request<AgenticPrompt>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(String(version))}/tags`,
      {
        method: "PUT",
        body: JSON.stringify({ tag }),
      },
    );
  }
```

Note on `getPromptByTag`: we intentionally **don't** use `request<T>()` for it because 404 is a valid "not found" signal that must not throw — it's the fallback trigger. The save/tag methods *do* use `request()` because any non-2xx there is a genuine failure.

- [ ] **Step 4:** Run `pnpm test -- arthur-client.test.ts`. Expect PASS (15 tests total: 10 existing + 5 new).

- [ ] **Step 5:** `pnpm typecheck`. PASS.

- [ ] **Step 6:** Commit: `git add src/sandbox/arthur-client.ts src/sandbox/arthur-client.test.ts && git commit -m "feat(arthur-client): add prompt get/create/tag methods"`.

---

## Task 4: `loadPrompts()` step

**Files:** `src/workflows/prompts-step.ts`, `src/workflows/prompts-step.test.ts`

The step must be in its own file so Vitest can import it directly (importing from `agent.ts` pulls in the whole workflow DevKit). It is exported and called from `agent.ts` in Task 5.

- [ ] **Step 1:** Write the failing tests in `src/workflows/prompts-step.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../env.js", () => ({ env: {} }));

const mockGetPromptByTag = vi.fn();
vi.mock("../sandbox/arthur-client.js", () => ({
  ArthurClient: {
    fromTraceEndpoint: vi.fn(() => ({ getPromptByTag: mockGetPromptByTag })),
  },
}));

import { loadPrompts } from "./prompts-step.js";
import { PROMPT_FALLBACKS } from "../lib/prompts.js";

function setEnv(partial: Record<string, string | undefined>) {
  const mod = require("../../env.js") as { env: Record<string, string | undefined> };
  mod.env = { ...mod.env, ...partial };
}

describe("loadPrompts", () => {
  beforeEach(() => {
    mockGetPromptByTag.mockReset();
    setEnv({
      GENAI_ENGINE_API_KEY: undefined,
      GENAI_ENGINE_TRACE_ENDPOINT: undefined,
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
  });

  it("returns fallbacks when no Arthur env is set", async () => {
    const result = await loadPrompts();
    expect(result.research).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(result.implement).toBe(PROMPT_FALLBACKS["implement"]);
    expect(result.review).toBe(PROMPT_FALLBACKS["review"]);
    expect(mockGetPromptByTag).not.toHaveBeenCalled();
  });

  it("returns fallbacks when PROMPT_TASK_ID is missing even if key+endpoint are set", async () => {
    setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: undefined,
    });
    const result = await loadPrompts();
    expect(result.research).toBe(PROMPT_FALLBACKS["research-plan"]);
    expect(mockGetPromptByTag).not.toHaveBeenCalled();
  });

  it("returns Arthur prompts when all three are present", async () => {
    setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "prompt-task-uuid",
    });
    mockGetPromptByTag
      .mockResolvedValueOnce("arthur research")
      .mockResolvedValueOnce("arthur implement")
      .mockResolvedValueOnce("arthur review");
    const result = await loadPrompts();
    expect(result).toEqual({
      research: "arthur research",
      implement: "arthur implement",
      review: "arthur review",
    });
    expect(mockGetPromptByTag).toHaveBeenCalledTimes(3);
    const names = mockGetPromptByTag.mock.calls.map((c) => c[1]);
    expect(names).toEqual(["research-plan", "implement", "review"]);
  });

  it("falls back per-prompt when Arthur returns null or throws", async () => {
    setEnv({
      GENAI_ENGINE_API_KEY: "k",
      GENAI_ENGINE_TRACE_ENDPOINT: "https://host/api/v1/traces",
      GENAI_ENGINE_PROMPT_TASK_ID: "prompt-task-uuid",
    });
    mockGetPromptByTag
      .mockResolvedValueOnce("arthur research")
      .mockResolvedValueOnce(null)                   // implement missing
      .mockRejectedValueOnce(new Error("boom"));     // review errors

    const result = await loadPrompts();
    expect(result.research).toBe("arthur research");
    expect(result.implement).toBe(PROMPT_FALLBACKS["implement"]);
    expect(result.review).toBe(PROMPT_FALLBACKS["review"]);
  });
});
```

- [ ] **Step 2:** Run `pnpm test -- prompts-step.test.ts`. Expect FAIL — the file doesn't exist.

- [ ] **Step 3:** Create `src/workflows/prompts-step.ts`:

```ts
import type { LoadedPrompts } from "./prompts-step-types.js";

export interface LoadedPrompts {
  research: string;
  implement: string;
  review: string;
}

export async function loadPrompts(): Promise<LoadedPrompts> {
  "use step";
  const { env } = await import("../../env.js");
  const { logger } = await import("../lib/logger.js");
  const { PROMPT_FALLBACKS } = await import("../lib/prompts.js");

  const arthurEnabled =
    !!env.GENAI_ENGINE_API_KEY &&
    !!env.GENAI_ENGINE_TRACE_ENDPOINT &&
    !!env.GENAI_ENGINE_PROMPT_TASK_ID;

  if (!arthurEnabled) {
    logger.info({ source: "fallback", reason: "arthur_prompts_disabled" }, "prompts_loaded");
    return {
      research: PROMPT_FALLBACKS["research-plan"],
      implement: PROMPT_FALLBACKS["implement"],
      review: PROMPT_FALLBACKS["review"],
    };
  }

  const { ArthurClient } = await import("../sandbox/arthur-client.js");
  const client = ArthurClient.fromTraceEndpoint(
    env.GENAI_ENGINE_TRACE_ENDPOINT!,
    env.GENAI_ENGINE_API_KEY!,
  );
  const taskId = env.GENAI_ENGINE_PROMPT_TASK_ID!;
  const TAG = "production";

  async function one(name: "research-plan" | "implement" | "review"): Promise<string> {
    try {
      const body = await client.getPromptByTag(taskId, name, TAG);
      if (body === null) {
        logger.info({ name, source: "fallback", reason: "arthur_prompt_missing" }, "prompts_loaded");
        return PROMPT_FALLBACKS[name];
      }
      logger.info({ name, source: "arthur" }, "prompts_loaded");
      return body;
    } catch (err) {
      logger.warn({ name, source: "fallback", err: (err as Error).message }, "prompts_loaded");
      return PROMPT_FALLBACKS[name];
    }
  }

  const [research, implement, review] = await Promise.all([
    one("research-plan"),
    one("implement"),
    one("review"),
  ]);
  return { research, implement, review };
}
loadPrompts.maxRetries = 0;
```

Remove the bad `import type` line (the duplicate) before saving — the interface is defined inline.

- [ ] **Step 4:** Run `pnpm test -- prompts-step.test.ts`. Expect PASS (4 tests).

- [ ] **Step 5:** `pnpm typecheck`. PASS.

- [ ] **Step 6:** Commit: `git add src/workflows/prompts-step.ts src/workflows/prompts-step.test.ts && git commit -m "feat(workflow): loadPrompts step with per-prompt Arthur→codebase fallback"`.

---

## Task 5: Wire `loadPrompts()` into the workflow

**Files:** `src/workflows/agent.ts`

- [ ] **Step 1:** In `src/workflows/agent.ts`, right after `const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI); if (!ticket) return;`, add:

```ts
    const { loadPrompts } = await import("./prompts-step.js");
    const prompts = await loadPrompts();
```

- [ ] **Step 2:** Replace the three `getPrompt(...)` call sites:

| Before | After |
|---|---|
| `prompt: getPrompt("research-plan.md")` | `prompt: prompts.research` |
| `prompt: getPrompt("implement.md")` | `prompt: prompts.implement` |
| `prompt: getPrompt("review.md")` *(commented)* | `prompt: prompts.review` *(commented — leave commented same as today)* |

- [ ] **Step 3:** Remove the now-unused `const { getPrompt } = await import("../lib/prompts.js");` import inside the workflow body.

- [ ] **Step 4:** `pnpm typecheck`. PASS.

- [ ] **Step 5:** `pnpm test`. All suites green (existing + new).

- [ ] **Step 6:** Commit: `git add src/workflows/agent.ts && git commit -m "feat(workflow): use loadPrompts instead of getPrompt"`.

---

## Task 6: One-shot setup script (find-or-create task + seed + print UUID)

**Files:** `scripts/setup-arthur-prompts.ts`, `package.json`

We need two supporting `ArthurClient` helpers that Task 3 didn't add. Rather than retro-editing Task 3, they're added here because they're only used by this script.

- [ ] **Step 1:** Extend `ArthurClient` with `findTaskByName(name)` and `createPlainTask(name)`. In `src/sandbox/arthur-client.ts`, add these methods directly below `ensureTaskForTicket`:

```ts
  /** Exact-name lookup. Returns the task if found (non-archived), else null. */
  async findTaskByName(name: string): Promise<ArthurTask | null> {
    const { tasks } = await this.request<{ count: number; tasks: ArthurTask[] }>(
      "/api/v2/tasks/search",
      { method: "POST", body: JSON.stringify({ task_name: name }) },
    );
    return tasks.find((t) => t.name === name && !t.is_archived) ?? null;
  }

  /** Create a task without the agent-metadata/is_agentic defaults used by ensureTaskForTicket. */
  async createPlainTask(name: string): Promise<ArthurTask> {
    return this.request<ArthurTask>("/api/v2/tasks", {
      method: "POST",
      body: JSON.stringify({ name, is_agentic: true }),
    });
  }
```

*(Note: `createPlainTask` body is identical to `createTask` today. Kept as a separate method so its usage signals "for non-ticket tasks" — a semantic marker to prevent future code from assuming ticket-naming conventions on prompt-host tasks.)*

- [ ] **Step 2:** Add unit tests for the two new methods in `src/sandbox/arthur-client.test.ts` (inside the existing describe):

```ts
  describe("findTaskByName", () => {
    it("returns exact-name match, excluding archived", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 3,
        tasks: [
          { id: "a", name: "ai-workflow-prompts" },
          { id: "b", name: "ai-workflow-prompts-old", is_archived: true },
          { id: "c", name: "ai-workflow-prompts", is_archived: true },
        ],
      }));
      const client = new ArthurClient("http://host", "k");
      const t = await client.findTaskByName("ai-workflow-prompts");
      expect(t?.id).toBe("a");
    });

    it("returns null on no match", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, tasks: [] }));
      const client = new ArthurClient("http://host", "k");
      expect(await client.findTaskByName("nothing")).toBeNull();
    });
  });
```

- [ ] **Step 3:** Run `pnpm test -- arthur-client.test.ts`. Expect PASS.

- [ ] **Step 4:** Create `scripts/setup-arthur-prompts.ts`:

```ts
/**
 * One-shot setup: ensures the Arthur prompt-host task exists and has the three
 * workflow prompts seeded with the `production` tag.
 *
 *   npx tsx scripts/setup-arthur-prompts.ts
 *
 * Requires in .env:
 *   GENAI_ENGINE_API_KEY
 *   GENAI_ENGINE_TRACE_ENDPOINT
 *
 * Prints the task UUID as a paste-ready env line at the end.
 */
import "dotenv/config";
import { ArthurClient } from "../src/sandbox/arthur-client.js";
import { PROMPT_FALLBACKS, PROMPT_NAMES } from "../src/lib/prompts.js";

const TASK_NAME = "ai-workflow-prompts";
const TAG = "production";

const apiKey = process.env.GENAI_ENGINE_API_KEY;
const endpoint = process.env.GENAI_ENGINE_TRACE_ENDPOINT;
if (!apiKey || !endpoint) {
  console.error("Missing GENAI_ENGINE_{API_KEY,TRACE_ENDPOINT} in env/.env");
  process.exit(1);
}

const client = ArthurClient.fromTraceEndpoint(endpoint, apiKey);

async function main() {
  let task = await client.findTaskByName(TASK_NAME);
  if (task) {
    console.log(`Found existing task "${TASK_NAME}" (${task.id}) — will overwrite prompts.`);
  } else {
    task = await client.createPlainTask(TASK_NAME);
    console.log(`Created new task "${TASK_NAME}" (${task.id}).`);
  }

  for (const name of PROMPT_NAMES) {
    const body = PROMPT_FALLBACKS[name];
    console.log(`\n  seeding ${name}…`);
    const created = await client.createPromptVersion(task.id, name, body);
    const version = created.version;
    if (version === undefined) {
      console.error(`  no version returned; cannot tag. full response:`, created);
      continue;
    }
    await client.tagPromptVersion(task.id, name, version, TAG);
    console.log(`  ✓ version ${version} tagged "${TAG}"`);
  }

  console.log(`\nSetup complete. Add this to .env:\n  GENAI_ENGINE_PROMPT_TASK_ID=${task.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5:** In `package.json` add to `"scripts"`:

```json
    "setup:arthur-prompts": "tsx scripts/setup-arthur-prompts.ts",
```

- [ ] **Step 6:** `pnpm typecheck`. PASS.

- [ ] **Step 7:** Commit:

```bash
git add src/sandbox/arthur-client.ts src/sandbox/arthur-client.test.ts scripts/setup-arthur-prompts.ts package.json
git commit -m "feat(scripts): setup-arthur-prompts — find-or-create task and seed prompts"
```

---

## Task 7: Manual verification

**Files:** None (runtime verification only).

- [ ] **Step 1:** Ensure `GENAI_ENGINE_API_KEY` and `GENAI_ENGINE_TRACE_ENDPOINT` are set and uncommented in `.env`.

- [ ] **Step 2:** Run setup:

```bash
pnpm setup:arthur-prompts
```

Expected output: either `Created new task …` or `Found existing task …`, followed by three `✓ version N tagged "production"` lines, and a final:

```
Setup complete. Add this to .env:
  GENAI_ENGINE_PROMPT_TASK_ID=<uuid>
```

- [ ] **Step 3:** Copy that line into `.env`.

- [ ] **Step 4:** In Arthur UI, verify the `ai-workflow-prompts` task exists with three prompts, each having a version tagged `production`.

- [ ] **Step 5:** Start `pnpm dev`, trigger a fresh ticket. Grep dev-server output for `prompts_loaded` — expect three lines, each with `source: "arthur"`:

```
msg=prompts_loaded name=research-plan source=arthur
msg=prompts_loaded name=implement source=arthur
msg=prompts_loaded name=review source=arthur
```

- [ ] **Step 6:** Negative check — comment out `GENAI_ENGINE_PROMPT_TASK_ID` in `.env`, restart `pnpm dev`, trigger another ticket. Expect a single `prompts_loaded source=fallback reason=arthur_prompts_disabled` line and no per-prompt `arthur` source log.

- [ ] **Step 7:** Per-prompt fallback check — temporarily delete one prompt (e.g. `review`) from the Arthur UI, restart `pnpm dev`, trigger another ticket. Expect two `source=arthur` lines and one `source=fallback reason=arthur_prompt_missing name=review`. Re-run `pnpm setup:arthur-prompts` to restore.

---

## Verification

1. `pnpm test` — all suites green.
2. `pnpm typecheck` — green.
3. Task 7 manual flow — three positive, two negative, all matching expected log lines.

## Risks / Open Items

- **Race between seed and workflow start.** If a workflow run begins while the seed script is mid-flight, the workflow might see an incomplete prompt set and fall back for the missing ones. The per-prompt fallback makes this safe (no broken run), just visible in logs. Acceptable.
- **No automatic task creation.** We don't auto-create the prompt-host task because the prompts API needs a task ID *before* any prompt exists, and accidentally creating many such tasks would be confusing. Manual setup keeps the invariant "at most one prompt-host task" explicit. Documented in Task 7 Step 1.
- **`model_name` / `model_provider` are required by `POST /prompts/{name}`** per the API schema. We send the current workflow's model (`claude-sonnet-4`, `anthropic`) as placeholders — Arthur's tracing doesn't consume these fields for hosted prompts, and we ignore them on read. If Arthur starts validating compatibility, we'd revisit.
- **Replay consistency.** `loadPrompts()` is a `"use step"` with `maxRetries = 0`, so once the workflow records a result it reuses it on replay. This means prompts mid-flight never change under the workflow's feet. Tradeoff: an urgent prompt fix won't affect a workflow already past the `loadPrompts()` checkpoint — operators must dispatch a new run.
- **Bundle size / cold-start.** `prompts-step.ts` adds ~1KB to the deployed JS. Insignificant.
- **No cost pricing for prompt storage.** Arthur charges per trace; hosted prompts are free. Confirmed with API docs — no additional env/billing concern.
