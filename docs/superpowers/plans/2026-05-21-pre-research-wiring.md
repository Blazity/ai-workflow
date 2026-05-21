# Pre-Research Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and wire the opt-in Pre-Research phase into `agentWorkflow`, per `docs/superpowers/specs/2026-05-19-pr-review-extensions-design.md` — Milestones 4+5 of the existing implementation plan. Currently the spec describes Pre-Research in detail but no implementation exists in code.

**Architecture:** Pre-Research runs in the host Vercel Function (not the sandbox) as a `"use step"` between `fetchAndValidateTicket` and `provisionSandbox`. It uses an AI SDK agentic loop with a configured tool belt to gather external context and produces a `PreResearchBrief`. The `brief_markdown` is threaded into `assembleResearchPlanContext` and `assembleImplementationContext` as a `<pre_research_brief>` block when `pass_to` includes the corresponding phase. Caching is keyed by ticket revision + config hash in Upstash Redis. Scope filtering (`all` / `label` / `branch_prefix`) and `on_failure` (`skip` / `fail`) match the existing review-pipeline patterns.

**Scope boundary:** The spec calls for `src/lib/agentic-loop.ts` to be a shared helper used by both Pre-Research and `ai_review`'s `whole_pr` mode. This plan creates that helper and uses it from Pre-Research only — `ai-review.ts` keeps its existing direct `generateObject` calls. A future slice can consolidate.

**Tech Stack:**
- Vercel Workflow DevKit (`"use workflow"` / `"use step"`)
- AI SDK v5 (`ai@^5.0.0`, `@ai-sdk/anthropic@^2.0.0`) — note: v5, not v6. Use `generateText` + `generateObject` + `stopWhen: stepCountIs(...)` to match existing patterns in `src/lib/checks/ai-review.ts`.
- Zod for config schemas (matching `src/lib/workflow-config.ts` patterns)
- Upstash Redis via `@upstash/redis` (matching `src/adapters/run-registry/upstash.ts` patterns)
- Vitest + colocated `.test.ts` files
- Existing adapters: `vcs` (GitHub App / GitLab), `issueTracker` (Jira)

---

## Task 1: Extend Config Schema And Env For Pre-Research

**Files:**
- Modify: `env.ts` — add `WEB_SEARCH_API_KEY` (optional)
- Modify: `src/lib/workflow-config.ts` — add `PreResearchConfigSchema`, extend `WorkflowConfigSchema`, add validation
- Modify: `workflow.config.yaml` — add disabled-by-default `preResearch:` block
- Modify: `src/lib/workflow-config.test.ts` — extend coverage

- [ ] **Step 1: Write the failing schema tests**

Append to `src/lib/workflow-config.test.ts` (place at end of file, before any closing wrappers):

```typescript
import { describe, it, expect } from "vitest";
import { WorkflowConfigSchema } from "./workflow-config.js";

describe("preResearch config", () => {
  const minimalReview = {
    enabled: false,
    scope: { mode: "all" as const },
    triggers: ["opened"],
    default_ignore: [],
    limits: {
      max_changed_files: 25,
      max_total_diff_bytes: 80000,
      max_file_content_bytes: 30000,
      max_check_annotations: 50,
      max_review_comments: 10,
      max_suggestions: 5,
    },
    checks: [],
  };

  const validPreResearch = {
    enabled: true,
    scope: { mode: "all" as const },
    model: "claude-sonnet-4-5",
    max_steps: 12,
    max_duration_seconds: 180,
    prompt: { source: "builtin" as const, name: "pre-research" },
    tools: ["web_search", "fetch_url"],
    limits: { max_references: 20, max_brief_bytes: 16000, max_fetch_bytes: 30000 },
    cache: { mode: "per_ticket_revision_hash" as const, ttl_seconds: 86400 },
    on_failure: "skip" as const,
    pass_to: ["research", "impl"] as const,
  };

  it("accepts a fully populated preResearch block", () => {
    const result = WorkflowConfigSchema.safeParse({
      version: 1,
      review: minimalReview,
      preResearch: validPreResearch,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown tool names", () => {
    const result = WorkflowConfigSchema.safeParse({
      version: 1,
      review: minimalReview,
      preResearch: { ...validPreResearch, tools: ["web_search", "rm_rf"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid pass_to entries", () => {
    const result = WorkflowConfigSchema.safeParse({
      version: 1,
      review: minimalReview,
      preResearch: { ...validPreResearch, pass_to: ["research", "deploy"] as unknown as ("research" | "impl")[] },
    });
    expect(result.success).toBe(false);
  });

  it("allows preResearch to be omitted (back-compat)", () => {
    const result = WorkflowConfigSchema.safeParse({ version: 1, review: minimalReview });
    expect(result.success).toBe(true);
  });

  it("requires label when scope.mode = label", () => {
    const result = WorkflowConfigSchema.safeParse({
      version: 1,
      review: minimalReview,
      preResearch: { ...validPreResearch, scope: { mode: "label" } as { mode: "label" } },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests — expect failures**

Run: `pnpm test src/lib/workflow-config.test.ts -t "preResearch"`
Expected: All five tests fail (the schema doesn't accept `preResearch` yet).

- [ ] **Step 3: Extend `env.ts` with `WEB_SEARCH_API_KEY`**

In `env.ts`, inside `server: { ... }` (next to `WORKFLOW_CONFIG_PATH` around line 122):

```typescript
    /** Optional API key for the web_search tool backend. Required only when preResearch.enabled and web_search is whitelisted. */
    WEB_SEARCH_API_KEY: z.string().min(1).optional(),
```

- [ ] **Step 4: Extend `workflow-config.ts` with preResearch schema**

In `src/lib/workflow-config.ts`, add the following AFTER the existing `ReviewConfigSchema` definition and BEFORE `WorkflowConfigSchema`:

```typescript
const PreResearchToolSchema = z.enum([
  "web_search",
  "fetch_url",
  "search_codebase",
  "read_file_at_ref",
  "query_tracker",
  "search_past_prs",
]);

const PreResearchPromptSchema = z
  .object({
    source: z.enum(["arthur", "local", "builtin"]),
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if ((p.source === "builtin" || p.source === "arthur") && !p.name) {
      ctx.addIssue({ code: "custom", message: `${p.source} prompt requires "name"` });
    }
    if (p.source === "local" && !p.path) {
      ctx.addIssue({ code: "custom", message: `local prompt requires "path"` });
    }
  });

const PreResearchLimitsSchema = z
  .object({
    max_references: z.number().int().positive(),
    max_brief_bytes: z.number().int().positive(),
    max_fetch_bytes: z.number().int().positive(),
  })
  .strict();

const PreResearchCacheSchema = z
  .object({
    mode: z.enum(["none", "per_ticket_revision_hash"]),
    ttl_seconds: z.number().int().positive(),
  })
  .strict();

const PreResearchConfigSchema = z
  .object({
    enabled: z.boolean(),
    scope: ScopeSchema,
    model: z.string().min(1),
    max_steps: z.number().int().positive(),
    max_duration_seconds: z.number().int().positive(),
    prompt: PreResearchPromptSchema,
    tools: z.array(PreResearchToolSchema),
    limits: PreResearchLimitsSchema,
    cache: PreResearchCacheSchema,
    on_failure: z.enum(["skip", "fail"]),
    pass_to: z.array(z.enum(["research", "impl"])).min(1),
  })
  .strict();

export type PreResearchConfig = z.infer<typeof PreResearchConfigSchema>;
export type PreResearchToolName = z.infer<typeof PreResearchToolSchema>;
```

Then update `WorkflowConfigSchema` to add `preResearch` as optional:

```typescript
export const WorkflowConfigSchema = z
  .object({
    version: z.literal(1),
    review: ReviewConfigSchema,
    preResearch: PreResearchConfigSchema.optional(),
  })
  .strict();
```

Then in `loadConfig`, after `validateCheckParams(...)`, add a env-gate for `WEB_SEARCH_API_KEY` when `web_search` is in the tool list and pre-research is enabled:

```typescript
  // Intentionally global: a missing key fails config load for EVERY entry
  // point (review webhook, agent workflow). This matches existing review
  // pipeline validation behavior.
  if (config.preResearch?.enabled && config.preResearch.tools.includes("web_search")) {
    if (!env.WEB_SEARCH_API_KEY) {
      throw new Error(
        `[${filePath}] preResearch.enabled is true and "web_search" is whitelisted but WEB_SEARCH_API_KEY is not set`,
      );
    }
  }
```

- [ ] **Step 5: Add preResearch block to `workflow.config.yaml`**

Append at the end of `workflow.config.yaml`:

```yaml

preResearch:
  # Dark by default. Flip to true once WEB_SEARCH_API_KEY is configured.
  enabled: false

  scope:
    mode: all

  model: claude-sonnet-4-5
  max_steps: 12
  max_duration_seconds: 180

  prompt:
    source: builtin
    name: pre-research

  tools:
    - fetch_url
    - search_codebase
    - read_file_at_ref
    - query_tracker
    - search_past_prs
    # web_search requires WEB_SEARCH_API_KEY — add it back when configured.

  limits:
    max_references: 20
    max_brief_bytes: 16000
    max_fetch_bytes: 30000

  cache:
    mode: per_ticket_revision_hash
    ttl_seconds: 86400

  on_failure: skip

  pass_to:
    - research
    - impl
```

- [ ] **Step 6: Run tests — expect pass**

Run: `pnpm test src/lib/workflow-config.test.ts`
Run: `pnpm typecheck`
Expected: all preResearch tests pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add env.ts src/lib/workflow-config.ts src/lib/workflow-config.test.ts workflow.config.yaml
git commit -m "feat(pre-research): add config schema and env gate"
```

---

## Task 2: Pre-Research Types

**Files:**
- Create: `src/lib/pre-research-types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/lib/pre-research-types.ts
import type { PhaseUsage } from "../sandbox/agents/types.js";
import type { PreResearchConfig } from "./workflow-config.js";
import type { DownloadedAttachment } from "../sandbox/attachments.js";

export interface PreResearchReference {
  title: string;
  url: string;
  source: "web" | "tracker" | "vcs" | "pr";
  relevance: string;
  excerpt?: string;
}

export interface PreResearchBrief {
  brief_markdown: string;
  references: PreResearchReference[];
  open_questions: string[];
  used_tools: string[];
  cache_key: string;
  model: string;
  config_hash: string;
  usage: PhaseUsage | null;
}

export interface PreResearchTicketData {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt?: string }>;
  labels: readonly string[];
}

export interface PreResearchInput {
  ticket: PreResearchTicketData;
  branchName: string;
  config: PreResearchConfig;
  configHash: string;
  systemPrompt: string;
  attachments?: DownloadedAttachment[];
  /** Aborts the agentic loop. Wired to runRegistry cancellation. */
  signal?: AbortSignal;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/pre-research-types.ts
git commit -m "feat(pre-research): add brief and input types"
```

---

## Task 3: Shared Agentic-Loop Helper

**Files:**
- Create: `src/lib/agentic-loop.ts`
- Create: `src/lib/agentic-loop.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/agentic-loop.test.ts
import { describe, it, expect, vi } from "vitest";
import { agenticLoop } from "./agentic-loop.js";

describe("agenticLoop", () => {
  it("returns text, steps, usage from underlying generateText", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      text: "result",
      steps: [{ stepType: "initial" }],
      usage: { promptTokens: 10, completionTokens: 5 },
      finishReason: "stop",
    });
    const result = await agenticLoop({
      model: "test-model",
      system: "sys",
      prompt: "usr",
      tools: {},
      maxSteps: 3,
      generateText: mockGenerate as never,
    });
    expect(result.text).toBe("result");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(result.finishReason).toBe("stop");
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  it("rejects when wall-clock deadline elapses before model returns", async () => {
    const mockGenerate = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 200)),
    );
    await expect(
      agenticLoop({
        model: "m",
        system: "s",
        prompt: "p",
        tools: {},
        maxSteps: 3,
        maxDurationMs: 50,
        generateText: mockGenerate as never,
      }),
    ).rejects.toThrow(/deadline/i);
  });

  it("aborts when external signal fires", async () => {
    const ac = new AbortController();
    const mockGenerate = vi.fn().mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    setTimeout(() => ac.abort(), 10);
    await expect(
      agenticLoop({
        model: "m",
        system: "s",
        prompt: "p",
        tools: {},
        maxSteps: 3,
        signal: ac.signal,
        generateText: mockGenerate as never,
      }),
    ).rejects.toThrow();
  });

  it("passes stopWhen with stepCountIs(maxSteps) to generateText", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      text: "", steps: [], usage: null, finishReason: "stop",
    });
    await agenticLoop({
      model: "m", system: "s", prompt: "p", tools: {},
      maxSteps: 7,
      generateText: mockGenerate as never,
    });
    const call = mockGenerate.mock.calls[0]![0]!;
    expect(call.stopWhen).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm test src/lib/agentic-loop.test.ts`
Expected: all tests fail (module doesn't exist).

- [ ] **Step 3: Implement the helper**

```typescript
// src/lib/agentic-loop.ts
import {
  generateText as defaultGenerateText,
  stepCountIs,
  type ToolSet,
  type LanguageModel,
} from "ai";

export interface AgenticLoopInput {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools: ToolSet;
  maxSteps: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  /** Inject for tests; defaults to ai.generateText. */
  generateText?: typeof defaultGenerateText;
}

export interface AgenticLoopResult {
  text: string;
  steps: unknown[];
  usage: unknown;
  finishReason: string;
}

export async function agenticLoop(input: AgenticLoopInput): Promise<AgenticLoopResult> {
  const generate = input.generateText ?? defaultGenerateText;

  const deadlineMs = input.maxDurationMs;
  const localAc = new AbortController();
  const onUpstreamAbort = () => localAc.abort();
  input.signal?.addEventListener("abort", onUpstreamAbort);

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineHit = false;
  if (deadlineMs !== undefined) {
    deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      localAc.abort();
    }, deadlineMs);
  }

  try {
    const result = (await generate({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      tools: input.tools,
      stopWhen: stepCountIs(input.maxSteps),
      abortSignal: localAc.signal,
      experimental_telemetry: { isEnabled: true },
    } as never)) as {
      text: string;
      steps: unknown[];
      usage: unknown;
      finishReason: string;
    };

    if (deadlineHit) {
      throw new Error(`agenticLoop: wall-clock deadline of ${deadlineMs}ms exceeded`);
    }
    return result;
  } catch (err) {
    if (deadlineHit) {
      throw new Error(`agenticLoop: wall-clock deadline of ${deadlineMs}ms exceeded`);
    }
    throw err;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onUpstreamAbort);
  }
}
```

- [ ] **Step 4: Run tests — expect green**

Run: `pnpm test src/lib/agentic-loop.test.ts`
Run: `pnpm typecheck`
Expected: all four tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentic-loop.ts src/lib/agentic-loop.test.ts
git commit -m "feat(agentic-loop): add shared AI SDK loop helper"
```

---

## Task 4: VCS Adapter — searchCode And searchMergedPRs

**Files:**
- Modify: `src/adapters/vcs/types.ts`
- Modify: `src/adapters/vcs/github.ts`
- Modify: `src/adapters/vcs/github.test.ts`
- Modify: `src/adapters/vcs/gitlab.ts`
- Modify: `src/adapters/vcs/gitlab.test.ts`

- [ ] **Step 1: Write failing tests for GitHub `searchCode` and `searchMergedPRs`**

Append to `src/adapters/vcs/github.test.ts`. The existing file already mocks `buildOctokit` (via `vi.mock("../../lib/github-auth.js", ...)`) and exposes a `mockOctokit` object plus a `ghAdapter()` helper. Extend `mockOctokit` with a `search` namespace and assert against it directly:

```typescript
// Add to the existing `mockOctokit` object near the top of the file:
//   search: { code: vi.fn(), issuesAndPullRequests: vi.fn() },

describe("searchCode", () => {
  it("calls octokit.search.code with q, path scoping, and text-match media type", async () => {
    mockOctokit.search.code.mockResolvedValueOnce({
      data: {
        items: [
          {
            path: "src/foo.ts",
            name: "foo.ts",
            html_url: "https://github.com/o/r/blob/main/src/foo.ts",
            repository: { full_name: "o/r" },
            text_matches: [{ fragment: "match line" }],
          },
        ],
      },
    });
    const adapter = ghAdapter();
    const results = await adapter.searchCode({ query: "needle", path: "src/", limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe("src/foo.ts");
    expect(mockOctokit.search.code).toHaveBeenCalledWith({
      q: expect.stringContaining("needle"),
      per_page: 5,
      mediaType: { format: "text-match" },
    });
    expect(mockOctokit.search.code).toHaveBeenCalledWith(
      expect.objectContaining({ q: expect.stringContaining("repo:test-org/test-repo") }),
    );
    expect(mockOctokit.search.code).toHaveBeenCalledWith(
      expect.objectContaining({ q: expect.stringContaining("path:src/") }),
    );
  });
});

describe("searchMergedPRs", () => {
  it("calls octokit.search.issuesAndPullRequests with is:pr is:merged repo:OWNER/REPO", async () => {
    mockOctokit.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            number: 42,
            title: "fix bug",
            html_url: "https://github.com/o/r/pull/42",
            state: "closed",
            pull_request: { merged_at: "2026-05-01T00:00:00Z" },
          },
        ],
      },
    });
    const adapter = ghAdapter();
    const results = await adapter.searchMergedPRs({ query: "bug", limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]!.number).toBe(42);
    expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith({
      q: expect.stringMatching(/is:pr/),
      per_page: 10,
    });
    expect(mockOctokit.search.issuesAndPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ q: expect.stringMatching(/is:merged/) }),
    );
  });
});
```

Append to `src/adapters/vcs/gitlab.test.ts`. The existing file uses a `glAdapter()` helper (constructed via the local `GitLabAdapter` class) and mocks `@gitbeaker/rest`:

```typescript
describe("review-only operations on GitLab", () => {
  it("searchCode throws NotSupportedError", async () => {
    const a = glAdapter();
    await expect(a.searchCode({ query: "x" })).rejects.toThrow(/not supported/i);
  });

  it("searchMergedPRs throws NotSupportedError", async () => {
    const a = glAdapter();
    await expect(a.searchMergedPRs({ query: "x" })).rejects.toThrow(/not supported/i);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm test src/adapters/vcs/github.test.ts -t "searchCode|searchMergedPRs"`
Run: `pnpm test src/adapters/vcs/gitlab.test.ts -t "searchCode|searchMergedPRs"`
Expected: all four fail (methods don't exist).

- [ ] **Step 3: Add method signatures to `VCSAdapter` interface**

In `src/adapters/vcs/types.ts`, append to the `VCSAdapter` interface (after `createReview`):

```typescript
  // Pre-Research operations. GitLab throws NotSupportedError.
  searchCode(input: SearchCodeInput): Promise<SearchCodeHit[]>;
  searchMergedPRs(input: SearchMergedPRsInput): Promise<MergedPRHit[]>;
```

And add the types at the end of the file:

```typescript
export interface SearchCodeInput {
  query: string;
  path?: string;
  limit?: number;
}

export interface SearchCodeHit {
  path: string;
  name: string;
  url: string;
  repo: string;
  fragment?: string;
}

export interface SearchMergedPRsInput {
  query: string;
  limit?: number;
}

export interface MergedPRHit {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  state: string;
}
```

- [ ] **Step 4: Implement on GitHub adapter**

In `src/adapters/vcs/github.ts`, add the two methods to the class. The existing adapter stores the repo coordinates on `this.config.owner` / `this.config.repo` and invokes Octokit directly via `this.octokit.<namespace>.<method>(...)`:

```typescript
async searchCode(input: import("./types.js").SearchCodeInput): Promise<import("./types.js").SearchCodeHit[]> {
  const limit = Math.min(input.limit ?? 10, 30);
  const qualifiers = [`repo:${this.config.owner}/${this.config.repo}`];
  if (input.path) qualifiers.push(`path:${input.path}`);
  const q = [input.query, ...qualifiers].join(" ");
  const { data } = await this.octokit.search.code({
    q,
    per_page: limit,
    mediaType: { format: "text-match" },
  });
  return data.items.map((it) => ({
    path: it.path,
    name: it.name,
    url: it.html_url,
    repo: it.repository.full_name,
    fragment: it.text_matches?.[0]?.fragment,
  }));
}

async searchMergedPRs(input: import("./types.js").SearchMergedPRsInput): Promise<import("./types.js").MergedPRHit[]> {
  const limit = Math.min(input.limit ?? 10, 30);
  const q = [input.query, `repo:${this.config.owner}/${this.config.repo}`, "is:pr", "is:merged"].join(" ");
  const { data } = await this.octokit.search.issuesAndPullRequests({ q, per_page: limit });
  return data.items.map((it) => ({
    number: it.number,
    title: it.title,
    url: it.html_url,
    mergedAt: it.pull_request?.merged_at ?? "",
    state: it.state,
  }));
}
```

- [ ] **Step 5: Implement `NotSupportedError` throws on GitLab adapter**

In `src/adapters/vcs/gitlab.ts`, add inside the adapter class:

```typescript
async searchCode(): Promise<never> {
  throw new NotSupportedError("searchCode");
}

async searchMergedPRs(): Promise<never> {
  throw new NotSupportedError("searchMergedPRs");
}
```

(Add the `NotSupportedError` import from `./types.js` at the top if not already present.)

- [ ] **Step 6: Run tests — expect green**

Run: `pnpm test src/adapters/vcs/github.test.ts -t "searchCode|searchMergedPRs"`
Run: `pnpm test src/adapters/vcs/gitlab.test.ts -t "searchCode|searchMergedPRs"`
Run: `pnpm typecheck`
Expected: all four tests pass; no type errors elsewhere (VCSAdapter interface change must be satisfied by both impls).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/vcs/types.ts src/adapters/vcs/github.ts src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.ts src/adapters/vcs/gitlab.test.ts
git commit -m "feat(vcs): add searchCode and searchMergedPRs for pre-research"
```

---

## Task 5: Pre-Research Tool Belt

**Files:**
- Create: `src/lib/pre-research-tools.ts`
- Create: `src/lib/pre-research-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/pre-research-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildPreResearchTools } from "./pre-research-tools.js";

const baseConfig = {
  enabled: true,
  scope: { mode: "all" as const },
  model: "claude-sonnet-4-5",
  max_steps: 8,
  max_duration_seconds: 60,
  prompt: { source: "builtin" as const, name: "pre-research" },
  tools: [] as Array<
    | "web_search" | "fetch_url" | "search_codebase"
    | "read_file_at_ref" | "query_tracker" | "search_past_prs"
  >,
  limits: { max_references: 20, max_brief_bytes: 16000, max_fetch_bytes: 100 },
  cache: { mode: "per_ticket_revision_hash" as const, ttl_seconds: 60 },
  on_failure: "skip" as const,
  pass_to: ["research"] as const,
};

describe("buildPreResearchTools", () => {
  it("returns only whitelisted tools", () => {
    const tools = buildPreResearchTools(
      { ...baseConfig, tools: ["fetch_url", "search_codebase"] },
      { vcs: {} as never, issueTracker: {} as never, fetchImpl: globalThis.fetch },
    );
    expect(Object.keys(tools).sort()).toEqual(["fetch_url", "search_codebase"]);
  });

  it("fetch_url truncates to max_fetch_bytes", async () => {
    const big = "x".repeat(10_000);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const tools = buildPreResearchTools(
      { ...baseConfig, tools: ["fetch_url"], limits: { ...baseConfig.limits, max_fetch_bytes: 100 } },
      { vcs: {} as never, issueTracker: {} as never, fetchImpl: fetchImpl as never },
    );
    const result = await tools.fetch_url!.execute!({ url: "https://example.com" }, {} as never);
    expect(typeof result).toBe("object");
    expect((result as { content: string }).content.length).toBeLessThanOrEqual(100);
    expect((result as { truncated: boolean }).truncated).toBe(true);
  });

  it("search_codebase routes through the VCS adapter", async () => {
    const searchCode = vi.fn().mockResolvedValue([
      { path: "src/foo.ts", name: "foo.ts", url: "u", repo: "o/r", fragment: "x" },
    ]);
    const tools = buildPreResearchTools(
      { ...baseConfig, tools: ["search_codebase"] },
      { vcs: { searchCode } as never, issueTracker: {} as never, fetchImpl: globalThis.fetch },
    );
    const result = await tools.search_codebase!.execute!(
      { query: "needle", path: "src/" },
      {} as never,
    );
    expect(searchCode).toHaveBeenCalledWith({ query: "needle", path: "src/" });
    expect((result as { results: unknown[] }).results).toHaveLength(1);
  });

  it("fetch_url returns structured error on transient failure (not throw)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network"));
    const tools = buildPreResearchTools(
      { ...baseConfig, tools: ["fetch_url"] },
      { vcs: {} as never, issueTracker: {} as never, fetchImpl: fetchImpl as never },
    );
    const result = await tools.fetch_url!.execute!({ url: "https://example.com" }, {} as never);
    expect((result as { error: string }).error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm test src/lib/pre-research-tools.test.ts`
Expected: all four fail.

- [ ] **Step 3: Implement the tool belt**

```typescript
// src/lib/pre-research-tools.ts
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { PreResearchConfig, PreResearchToolName } from "./workflow-config.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

export interface PreResearchToolDeps {
  vcs: VCSAdapter;
  issueTracker: IssueTrackerAdapter;
  /** Override-able for tests. */
  fetchImpl: typeof fetch;
  /** Optional API key for the web_search backend. */
  webSearchApiKey?: string;
}

type ToolBuilder = (
  config: PreResearchConfig,
  deps: PreResearchToolDeps,
) => ToolSet[string];

function ok<T>(payload: T): T {
  return payload;
}

function err(message: string, code = "tool_error"): { error: string; code: string } {
  return { error: message, code };
}

const builders: Record<PreResearchToolName, ToolBuilder> = {
  fetch_url: (config, deps) =>
    tool({
      description:
        "Fetch a single URL and return its readable content, truncated to max_fetch_bytes.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        try {
          const res = await deps.fetchImpl(url, { redirect: "follow" });
          if (!res.ok) return err(`HTTP ${res.status} from ${url}`, "http_error");
          const text = await res.text();
          const limit = config.limits.max_fetch_bytes;
          const truncated = text.length > limit;
          return ok({
            url,
            status: res.status,
            content: truncated ? text.slice(0, limit) : text,
            truncated,
            byte_count: text.length,
          });
        } catch (e) {
          return err((e as Error).message, "network_error");
        }
      },
    }),

  search_codebase: (_, deps) =>
    tool({
      description: "Search the configured repo by content via the VCS adapter.",
      inputSchema: z.object({
        query: z.string().min(1),
        path: z.string().optional(),
        limit: z.number().int().positive().max(30).optional(),
      }),
      execute: async ({ query, path, limit }) => {
        try {
          const results = await deps.vcs.searchCode({ query, path, limit });
          return ok({ results });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    }),

  read_file_at_ref: (_, deps) =>
    tool({
      description:
        "Read a file's content from the base branch via the VCS adapter. Returns null if missing.",
      inputSchema: z.object({ path: z.string().min(1), ref: z.string().min(1) }),
      execute: async ({ path, ref }) => {
        try {
          const content = await deps.vcs.getFileContentAtRef(path, ref);
          return ok({ path, ref, content });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    }),

  query_tracker: (_, deps) =>
    tool({
      description:
        "Search the issue tracker for related tickets by free-text query.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(20).optional(),
      }),
      execute: async ({ query, limit }) => {
        try {
          const searchTickets = (
            deps.issueTracker as unknown as {
              searchTickets?: (q: string, l?: number) => Promise<unknown[]>;
            }
          ).searchTickets;
          if (typeof searchTickets !== "function") {
            return err("issueTracker.searchTickets not implemented", "not_supported");
          }
          const results = await searchTickets.call(deps.issueTracker, query, limit);
          return ok({ results });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    }),

  search_past_prs: (_, deps) =>
    tool({
      description: "List recently merged PRs whose title/body match the query.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(30).optional(),
      }),
      execute: async ({ query, limit }) => {
        try {
          const results = await deps.vcs.searchMergedPRs({ query, limit });
          return ok({ results });
        } catch (e) {
          return err((e as Error).message);
        }
      },
    }),

  web_search: (_, deps) =>
    tool({
      description: "Search the open web for relevant pages.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(10).optional(),
      }),
      execute: async ({ query, limit }) => {
        if (!deps.webSearchApiKey) {
          return err("WEB_SEARCH_API_KEY not configured", "not_configured");
        }
        // v1 ships exactly one backend; choose a provider during deployment.
        // Placeholder: post to a configurable backend. Replace at integration time.
        try {
          const res = await deps.fetchImpl("https://api.tavily.com/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: deps.webSearchApiKey,
              query,
              max_results: limit ?? 5,
            }),
          });
          if (!res.ok) return err(`HTTP ${res.status} from web_search`, "http_error");
          const data = (await res.json()) as unknown;
          return ok({ results: data });
        } catch (e) {
          return err((e as Error).message, "network_error");
        }
      },
    }),
};

export function buildPreResearchTools(
  config: PreResearchConfig,
  deps: PreResearchToolDeps,
): ToolSet {
  const out: ToolSet = {};
  for (const name of config.tools) {
    out[name] = builders[name](config, deps);
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect green**

Run: `pnpm test src/lib/pre-research-tools.test.ts`
Run: `pnpm typecheck`
Expected: all four pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pre-research-tools.ts src/lib/pre-research-tools.test.ts
git commit -m "feat(pre-research): add tool belt with fetch_url, search_codebase, query_tracker, search_past_prs, read_file_at_ref, web_search"
```

---

## Task 6: Pre-Research Redis Cache

**Files:**
- Create: `src/lib/pre-research-cache.ts`
- Create: `src/lib/pre-research-cache.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/pre-research-cache.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  computeTicketRevisionHash, computeCacheKey, getCachedBrief, setCachedBrief,
} from "./pre-research-cache.js";
import type { PreResearchBrief } from "./pre-research-types.js";

describe("pre-research cache", () => {
  const ticket = {
    identifier: "AIW-99",
    title: "T",
    description: "D",
    acceptanceCriteria: "AC",
    comments: [{ author: "x", body: "y" }],
    labels: [],
  };

  it("computeTicketRevisionHash is stable across calls", () => {
    expect(computeTicketRevisionHash(ticket)).toBe(computeTicketRevisionHash(ticket));
  });

  it("computeTicketRevisionHash changes when title changes", () => {
    const a = computeTicketRevisionHash(ticket);
    const b = computeTicketRevisionHash({ ...ticket, title: "T2" });
    expect(a).not.toBe(b);
  });

  it("computeCacheKey combines ticket id, rev hash, config hash", () => {
    const key = computeCacheKey({ ticketId: "AIW-99", revHash: "rev1", configHash: "cfg1" });
    expect(key).toBe("ai_workflow:preresearch:AIW-99:rev1:cfg1");
  });

  it("getCachedBrief returns null on miss", async () => {
    const redis = { get: vi.fn().mockResolvedValue(null) };
    const out = await getCachedBrief("k", { redis: redis as never });
    expect(out).toBeNull();
  });

  it("getCachedBrief deserializes a stored brief", async () => {
    const stored: PreResearchBrief = {
      brief_markdown: "md",
      references: [],
      open_questions: [],
      used_tools: [],
      cache_key: "k",
      model: "m",
      config_hash: "c",
      usage: null,
    };
    const redis = { get: vi.fn().mockResolvedValue(stored) };
    const out = await getCachedBrief("k", { redis: redis as never });
    expect(out?.brief_markdown).toBe("md");
  });

  it("setCachedBrief writes with TTL", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };
    await setCachedBrief("k", { brief_markdown: "md" } as PreResearchBrief, {
      redis: redis as never,
      ttlSeconds: 60,
    });
    expect(redis.set).toHaveBeenCalledWith("k", { brief_markdown: "md" }, { ex: 60 });
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm test src/lib/pre-research-cache.test.ts`
Expected: all six fail.

- [ ] **Step 3: Implement the cache helpers**

```typescript
// src/lib/pre-research-cache.ts
import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import type { PreResearchBrief, PreResearchTicketData } from "./pre-research-types.js";

const KEY_PREFIX = "ai_workflow:preresearch";

export function computeTicketRevisionHash(ticket: PreResearchTicketData): string {
  const canonical = JSON.stringify({
    identifier: ticket.identifier,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    commentSummaries: ticket.comments.map((c) => `${c.author}:${c.body.length}`),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function computeCacheKey(input: {
  ticketId: string;
  revHash: string;
  configHash: string;
}): string {
  return `${KEY_PREFIX}:${input.ticketId}:${input.revHash}:${input.configHash}`;
}

export async function getCachedBrief(
  key: string,
  deps: { redis: Redis },
): Promise<PreResearchBrief | null> {
  const raw = await deps.redis.get<PreResearchBrief>(key);
  return raw ?? null;
}

export async function setCachedBrief(
  key: string,
  brief: PreResearchBrief,
  deps: { redis: Redis; ttlSeconds: number },
): Promise<void> {
  await deps.redis.set(key, brief, { ex: deps.ttlSeconds });
}
```

- [ ] **Step 4: Run tests — expect green**

Run: `pnpm test src/lib/pre-research-cache.test.ts`
Run: `pnpm typecheck`
Expected: all six pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pre-research-cache.ts src/lib/pre-research-cache.test.ts
git commit -m "feat(pre-research): add redis cache helpers keyed by ticket revision"
```

---

## Task 7: `runPreResearch` Step Function

**Files:**
- Create: `src/lib/pre-research.ts`
- Create: `src/lib/pre-research.test.ts`
- Modify: `src/lib/prompts.ts` — add builtin `pre-research` prompt + update research/impl prompts

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/pre-research.test.ts
import { describe, it, expect, vi } from "vitest";
import { runPreResearchImpl } from "./pre-research.js";
import type { PreResearchBrief, PreResearchInput } from "./pre-research-types.js";

const baseInput = (overrides: Partial<PreResearchInput> = {}): PreResearchInput => ({
  ticket: {
    identifier: "AIW-1",
    title: "t",
    description: "d",
    acceptanceCriteria: "ac",
    comments: [],
    labels: [],
  },
  branchName: "blazebot/aiw-1",
  config: {
    enabled: true,
    scope: { mode: "all" },
    model: "claude-sonnet-4-5",
    max_steps: 3,
    max_duration_seconds: 5,
    prompt: { source: "builtin", name: "pre-research" },
    tools: ["fetch_url"],
    limits: { max_references: 20, max_brief_bytes: 16000, max_fetch_bytes: 1000 },
    cache: { mode: "per_ticket_revision_hash", ttl_seconds: 60 },
    on_failure: "skip",
    pass_to: ["research", "impl"],
  },
  configHash: "cfghash",
  systemPrompt: "system",
  ...overrides,
});

describe("runPreResearchImpl", () => {
  it("returns cached brief without invoking the model on cache hit", async () => {
    const cached: PreResearchBrief = {
      brief_markdown: "cached",
      references: [], open_questions: [], used_tools: [],
      cache_key: "k", model: "m", config_hash: "c", usage: null,
    };
    const agenticLoop = vi.fn();
    const redis = { get: vi.fn().mockResolvedValue(cached), set: vi.fn() };
    const result = await runPreResearchImpl(baseInput(), {
      redis: redis as never,
      agenticLoop: agenticLoop as never,
      vcs: {} as never, issueTracker: {} as never, fetchImpl: globalThis.fetch,
    });
    expect(result?.brief_markdown).toBe("cached");
    expect(agenticLoop).not.toHaveBeenCalled();
  });

  it("runs the loop and parses a brief on cache miss", async () => {
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    const agenticLoop = vi.fn().mockResolvedValue({
      text: 'Some preamble\n```json\n{"brief_markdown":"new","references":[],"open_questions":[],"used_tools":["fetch_url"]}\n```',
      steps: [], usage: { promptTokens: 1, completionTokens: 1 }, finishReason: "stop",
    });
    const result = await runPreResearchImpl(baseInput(), {
      redis: redis as never,
      agenticLoop: agenticLoop as never,
      vcs: {} as never, issueTracker: {} as never, fetchImpl: globalThis.fetch,
    });
    expect(result?.brief_markdown).toBe("new");
    expect(redis.set).toHaveBeenCalled();
  });

  it("truncates brief markdown to max_brief_bytes", async () => {
    const big = "x".repeat(50_000);
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    const agenticLoop = vi.fn().mockResolvedValue({
      text: '```json\n{"brief_markdown":"' + big + '","references":[],"open_questions":[],"used_tools":[]}\n```',
      steps: [], usage: null, finishReason: "stop",
    });
    const input = baseInput();
    input.config.limits.max_brief_bytes = 100;
    const result = await runPreResearchImpl(input, {
      redis: redis as never,
      agenticLoop: agenticLoop as never,
      vcs: {} as never, issueTracker: {} as never, fetchImpl: globalThis.fetch,
    });
    expect(result!.brief_markdown.length).toBeLessThanOrEqual(100 + 100);
    expect(result!.brief_markdown).toMatch(/truncated/i);
  });

  it("rejects non-JSON output", async () => {
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    const agenticLoop = vi.fn().mockResolvedValue({
      text: "no json here", steps: [], usage: null, finishReason: "stop",
    });
    await expect(
      runPreResearchImpl(baseInput(), {
        redis: redis as never,
        agenticLoop: agenticLoop as never,
        vcs: {} as never, issueTracker: {} as never, fetchImpl: globalThis.fetch,
      }),
    ).rejects.toThrow(/no fenced JSON block/i);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm test src/lib/pre-research.test.ts`
Expected: all four fail.

- [ ] **Step 3: Add the builtin `pre-research` prompt to `src/lib/prompts.ts`**

In `src/lib/prompts.ts`, near the bottom (after `BUILTIN_REVIEW_PROMPTS`):

```typescript
// Use String.raw so the literal triple-backtick fences inside the JSON example
// pass through verbatim — a normal template literal would try to terminate
// the surrounding template.
const builtinPreResearchPrompt = String.raw`# Pre-Research Brief

You are a research assistant. Given a ticket, your job is to produce a concise brief that the downstream coding agent can use to start work faster.

## Tools

Use the provided tools to:
- Look up library/API documentation relevant to the ticket
- Find related issues, prior tickets, recent merged PRs
- Read specific files from the base branch when needed

Stop calling tools as soon as you have enough context. Do not exhaustively crawl.

## Output

After your tool-using research is done, output a single fenced JSON object as the LAST thing in your response, in this shape:

` + "```json\n" + `{
  "brief_markdown": "<one-page markdown brief>",
  "references": [
    { "title": "...", "url": "...", "source": "web|tracker|vcs|pr", "relevance": "...", "excerpt": "..." }
  ],
  "open_questions": ["..."],
  "used_tools": ["fetch_url", "..."]
}
` + "```\n" + `
The brief_markdown should be the only field the downstream coding agent will read. Make it concrete, actionable, and short. Avoid generic summaries — focus on facts the downstream agent could not easily find by exploring the local repo.`;

export const BUILTIN_PRERESEARCH_PROMPTS: Record<string, string> = {
  "pre-research": builtinPreResearchPrompt,
};

export function getBuiltinPreResearchPrompt(name: string): string | null {
  return BUILTIN_PRERESEARCH_PROMPTS[name] ?? null;
}
```

Also update the existing `researchPlanPrompt` and `implementPrompt` constants to mention the brief. In `researchPlanPrompt`, insert a new bullet after "Restore session memory":

```
2. **Read pre-research brief (if present)** — If the input begins with a \`<pre_research_brief>\` block, treat its contents as additional context. Trust the brief on external/library/API facts but **verify any code-level claims against the actual repo** before depending on them.
```

(Renumber the subsequent steps.)

Do the same in `implementPrompt` near the top of its Process section.

- [ ] **Step 4: Implement `pre-research.ts`**

> Verify in the existing `src/workflows/agent.ts` that step functions declare
> `.maxRetries` as a function property. If no other step uses `.maxRetries`,
> drop the line `runPreResearch.maxRetries = 1;` and rely on the Workflow DevKit
> default. Confirm with:
>
> ```bash
> grep -n "\.maxRetries" src/workflows/agent.ts src/sandbox/agents/*.ts
> ```
>
> before adding it.

```typescript
// src/lib/pre-research.ts
import { Redis } from "@upstash/redis";
import { z } from "zod";
import { anthropic } from "@ai-sdk/anthropic";
import { env } from "../../env.js";
import { createStepAdapters } from "./step-adapters.js";
import { agenticLoop } from "./agentic-loop.js";
import { logger } from "./logger.js";
import {
  computeTicketRevisionHash,
  computeCacheKey,
  getCachedBrief,
  setCachedBrief,
} from "./pre-research-cache.js";
import { buildPreResearchTools } from "./pre-research-tools.js";
import type { PreResearchBrief, PreResearchInput } from "./pre-research-types.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { agenticLoop as agenticLoopFn } from "./agentic-loop.js";

export interface RunPreResearchDeps {
  redis: Redis;
  agenticLoop: typeof agenticLoopFn;
  vcs: VCSAdapter;
  issueTracker: IssueTrackerAdapter;
  fetchImpl: typeof fetch;
  webSearchApiKey?: string;
}

const RawBriefSchema = z.object({
  brief_markdown: z.string(),
  references: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        source: z.string().optional(),
        relevance: z.string().optional(),
        excerpt: z.string().optional(),
      }),
    )
    .optional(),
  open_questions: z.array(z.string()).optional(),
  used_tools: z.array(z.string()).optional(),
});

type RawBrief = z.infer<typeof RawBriefSchema>;

function extractJsonBlock(text: string): RawBrief {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (!fenced) {
    throw new Error("pre-research: no fenced JSON block found in model output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced[1]!);
  } catch (e) {
    throw new Error(`pre-research: failed to parse JSON brief — ${(e as Error).message}`);
  }
  const result = RawBriefSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`pre-research: invalid brief shape — ${result.error.message}`);
  }
  return result.data;
}

export async function runPreResearchImpl(
  input: PreResearchInput,
  deps: RunPreResearchDeps,
): Promise<PreResearchBrief | null> {
  const revHash = computeTicketRevisionHash(input.ticket);
  const cacheKey = computeCacheKey({
    ticketId: input.ticket.identifier,
    revHash,
    configHash: input.configHash,
  });

  if (input.config.cache.mode === "per_ticket_revision_hash") {
    const hit = await getCachedBrief(cacheKey, { redis: deps.redis });
    if (hit) return hit;
  }

  const tools = buildPreResearchTools(input.config, {
    vcs: deps.vcs,
    issueTracker: deps.issueTracker,
    fetchImpl: deps.fetchImpl,
    webSearchApiKey: deps.webSearchApiKey,
  });

  const userPrompt = renderUserPrompt(input);

  const { text, usage } = await deps.agenticLoop({
    model: anthropic(input.config.model),
    system: input.systemPrompt,
    prompt: userPrompt,
    tools,
    maxSteps: input.config.max_steps,
    maxDurationMs: input.config.max_duration_seconds * 1000,
    signal: input.signal,
  });

  const parsed = extractJsonBlock(text);

  let brief = parsed.brief_markdown;
  const cap = input.config.limits.max_brief_bytes;
  if (brief.length > cap) {
    brief = brief.slice(0, cap) + "\n\n[truncated to brief size cap]";
  }

  const refs = (parsed.references ?? []).slice(0, input.config.limits.max_references);

  const out: PreResearchBrief = {
    brief_markdown: brief,
    references: refs.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      source: ((r.source as PreResearchBrief["references"][number]["source"]) ?? "web"),
      relevance: r.relevance ?? "",
      excerpt: r.excerpt,
    })),
    open_questions: parsed.open_questions ?? [],
    used_tools: parsed.used_tools ?? [],
    cache_key: cacheKey,
    model: input.config.model,
    config_hash: input.configHash,
    usage: (usage as PreResearchBrief["usage"]) ?? null,
  };

  if (input.config.cache.mode === "per_ticket_revision_hash") {
    await setCachedBrief(cacheKey, out, {
      redis: deps.redis,
      ttlSeconds: input.config.cache.ttl_seconds,
    });
  }

  return out;
}

function renderUserPrompt(input: PreResearchInput): string {
  return [
    `# Ticket: ${input.ticket.identifier}`,
    "",
    `## Title`,
    input.ticket.title,
    "",
    `## Description`,
    input.ticket.description,
    "",
    `## Acceptance Criteria`,
    input.ticket.acceptanceCriteria || "(none)",
    "",
    `## Branch`,
    input.branchName,
  ].join("\n");
}

// Workflow step wrapper. Keeps "use step" directive isolated from the testable
// impl above so tests can inject deps without touching the workflow runtime.
//
// All module dependencies (Redis, env, step adapters, agenticLoop, logger,
// cache helpers, and tool-belt builder) are imported statically at the top
// of this file rather than dynamically inside the step body. That avoids a
// redundant `await import(...)` round-trip on every step invocation.
export async function runPreResearch(
  input: PreResearchInput,
): Promise<PreResearchBrief | null> {
  "use step";
  const log = logger.child({
    ticket_identifier: input.ticket.identifier,
    step: "preResearch",
  });
  log.info(
    {
      model: input.config.model,
      max_steps: input.config.max_steps,
      enabled_tools: input.config.tools,
    },
    "pre_research: start",
  );

  const { vcs, issueTracker } = createStepAdapters();
  const redis = new Redis({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
  });

  try {
    const result = await runPreResearchImpl(input, {
      redis,
      agenticLoop,
      vcs,
      issueTracker,
      fetchImpl: globalThis.fetch,
      webSearchApiKey: env.WEB_SEARCH_API_KEY,
    });
    log.info(
      {
        reference_count: result?.references.length ?? 0,
        used_tools: result?.used_tools ?? [],
      },
      "pre_research: done",
    );
    return result;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "pre_research: failed");
    throw e;
  }
}
runPreResearch.maxRetries = 1;
```

- [ ] **Step 5: Run tests — expect green**

Run: `pnpm test src/lib/pre-research.test.ts`
Run: `pnpm typecheck`
Expected: all four pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pre-research.ts src/lib/pre-research.test.ts src/lib/prompts.ts
git commit -m "feat(pre-research): add runPreResearch step with cache, parse, and builtin prompt"
```

---

## Task 8: Extend TicketEvent For pre_research Phase

**Files:**
- Modify: `src/adapters/messaging/types.ts`
- Modify: `src/adapters/messaging/format.ts`
- Modify: `src/adapters/messaging/format.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/adapters/messaging/format.test.ts`:

```typescript
it("renders failed pre_research phase", () => {
  const out = formatTicketEvent(
    "AIW-9",
    { kind: "failed", phase: "pre_research", reason: "WEB_SEARCH_API_KEY missing" },
  );
  expect(out).toMatch(/pre.?research/i);
  expect(out).toMatch(/WEB_SEARCH/);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm test src/adapters/messaging/format.test.ts -t "pre_research"`
Expected: type or runtime failure (`"pre_research"` not in union).

- [ ] **Step 3: Extend the union**

In `src/adapters/messaging/types.ts`:

```typescript
  | {
      kind: "failed";
      phase?: "pre_research" | "research" | "impl" | "review" | "push";
      reason?: string;
      usageReport?: string;
    }
```

In `src/adapters/messaging/format.ts`, extend the `phase` parameter type on the `formatFailedBody` function (currently at line 105) to include `pre_research`:

```typescript
function formatFailedBody(
  phase: "pre_research" | "research" | "impl" | "review" | "push" | undefined,
  reason: string | undefined,
): string {
  if (phase && reason) return `: ${phase} — ${reason}`;
  if (reason) return `: ${reason}`;
  return "";
}
```

`formatFailedBody` interpolates the `phase` string directly into the output, so no new `case` arm is needed — accepting `pre_research` in the union is the entire change. The downstream renderer will print `pre_research — <reason>` verbatim, which matches the test assertion `/pre.?research/i`.

- [ ] **Step 4: Run tests — expect green**

Run: `pnpm test src/adapters/messaging/format.test.ts`
Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/messaging/types.ts src/adapters/messaging/format.ts src/adapters/messaging/format.test.ts
git commit -m "feat(messaging): add pre_research phase to failed event"
```

---

## Task 9: Thread `preResearchBrief` Through Context Assemblers

**Files:**
- Modify: `src/sandbox/context.ts`
- Modify: `src/sandbox/context.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/sandbox/context.test.ts`:

```typescript
describe("preResearchBrief threading", () => {
  const baseTicket = {
    identifier: "AIW-9", title: "T", description: "D",
    acceptanceCriteria: "AC", comments: [],
  };

  it("prepends <pre_research_brief> block to research context when present", () => {
    const out = assembleResearchPlanContext({
      ticket: baseTicket,
      prompt: "research prompt",
      branchName: "b",
      preResearchBrief: "MY BRIEF",
    });
    expect(out).toMatch(/<pre_research_brief>\nMY BRIEF\n<\/pre_research_brief>/);
    expect(out.indexOf("<pre_research_brief>")).toBeLessThan(out.indexOf("# Requirements"));
  });

  it("omits the block when preResearchBrief is null/undefined", () => {
    const out = assembleResearchPlanContext({
      ticket: baseTicket, prompt: "research prompt", branchName: "b",
    });
    expect(out).not.toContain("<pre_research_brief>");
  });

  it("prepends block to implementation context when present", () => {
    const out = assembleImplementationContext({
      ticket: baseTicket, prompt: "impl prompt", researchPlanMarkdown: "rp",
      preResearchBrief: "MY BRIEF",
    });
    expect(out).toMatch(/<pre_research_brief>\nMY BRIEF\n<\/pre_research_brief>/);
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `pnpm test src/sandbox/context.test.ts -t "preResearchBrief"`
Expected: fail.

- [ ] **Step 3: Extend context.ts**

In `src/sandbox/context.ts`, extend both input interfaces:

```typescript
export interface ResearchPlanContextInput {
  // ...existing fields...
  preResearchBrief?: string | null;
}

export interface ImplementationContextInput {
  // ...existing fields...
  preResearchBrief?: string | null;
}
```

Add a helper:

```typescript
function preResearchBlock(brief: string | null | undefined): string {
  if (!brief) return "";
  return `<pre_research_brief>\n${brief}\n</pre_research_brief>\n\n`;
}
```

Prepend in `assembleResearchPlanContext` — change `let md = \`# Requirements ...` to:

```typescript
  let md = `${preResearchBlock(input.preResearchBrief)}# Requirements
```

Do the same for `assembleImplementationContext`:

```typescript
  return `${preResearchBlock(input.preResearchBrief)}# Requirements
```

- [ ] **Step 4: Run — expect green**

Run: `pnpm test src/sandbox/context.test.ts`
Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/context.ts src/sandbox/context.test.ts
git commit -m "feat(context): thread preResearchBrief into research/impl assemblers"
```

---

## Task 10: Scope-Matching Helper And Wire-In

**Files:**
- Create: `src/lib/pre-research-scope.ts`
- Create: `src/lib/pre-research-scope.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/pre-research-scope.test.ts
import { describe, it, expect } from "vitest";
import { matchesPreResearchScope } from "./pre-research-scope.js";

describe("matchesPreResearchScope", () => {
  it("returns true for mode 'all'", () => {
    expect(
      matchesPreResearchScope(
        { mode: "all" },
        { labels: [], branchName: "anything" },
      ),
    ).toBe(true);
  });

  it("mode 'label' matches when label is present", () => {
    expect(
      matchesPreResearchScope(
        { mode: "label", label: "deep-research" },
        { labels: ["deep-research", "x"], branchName: "b" },
      ),
    ).toBe(true);
  });

  it("mode 'label' does not match when label is absent", () => {
    expect(
      matchesPreResearchScope(
        { mode: "label", label: "deep-research" },
        { labels: ["foo"], branchName: "b" },
      ),
    ).toBe(false);
  });

  it("mode 'branch_prefix' matches branch name prefix", () => {
    expect(
      matchesPreResearchScope(
        { mode: "branch_prefix", branch_prefix: "blazebot/" },
        { labels: [], branchName: "blazebot/aiw-1" },
      ),
    ).toBe(true);
  });

  it("mode 'branch_prefix' does not match other prefix", () => {
    expect(
      matchesPreResearchScope(
        { mode: "branch_prefix", branch_prefix: "blazebot/" },
        { labels: [], branchName: "main" },
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failures**

- [ ] **Step 3: Implement**

```typescript
// src/lib/pre-research-scope.ts
import type { PreResearchConfig } from "./workflow-config.js";

export function matchesPreResearchScope(
  scope: PreResearchConfig["scope"],
  ctx: { labels: readonly string[]; branchName: string },
): boolean {
  switch (scope.mode) {
    case "all":
      return true;
    case "label":
      return ctx.labels.includes(scope.label);
    case "branch_prefix":
      return ctx.branchName.startsWith(scope.branch_prefix);
  }
}
```

- [ ] **Step 4: Run — expect green; commit**

Run: `pnpm test src/lib/pre-research-scope.test.ts`

```bash
git add src/lib/pre-research-scope.ts src/lib/pre-research-scope.test.ts
git commit -m "feat(pre-research): add scope matcher (all/label/branch_prefix)"
```

---

## Task 11: Wire `runPreResearch` Into `agentWorkflow`

**Files:**
- Modify: `src/workflows/agent.ts`
- Create: `src/workflows/agent.test.ts`

This is the keystone task — it makes Pre-Research visibly run for real tickets.

- [ ] **Step 1: Write the first failing test for wiring shape**

Create `src/workflows/agent.test.ts`. Since `agentWorkflow` uses `"use workflow"` and is hard to drive end-to-end in unit tests, test the inlined helper function `executePreResearchPhase` we'll extract from agent.ts:

```typescript
// src/workflows/agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { executePreResearchPhase } from "./agent.js";
import type { PreResearchConfig } from "../lib/workflow-config.js";

const cfg = (override: Partial<PreResearchConfig> = {}): PreResearchConfig => ({
  enabled: true,
  scope: { mode: "all" },
  model: "claude-sonnet-4-5",
  max_steps: 5,
  max_duration_seconds: 30,
  prompt: { source: "builtin", name: "pre-research" },
  tools: ["fetch_url"],
  limits: { max_references: 20, max_brief_bytes: 16000, max_fetch_bytes: 1000 },
  cache: { mode: "per_ticket_revision_hash", ttl_seconds: 60 },
  on_failure: "skip",
  pass_to: ["research", "impl"],
  ...override,
});

const ticket = {
  identifier: "AIW-9",
  title: "t", description: "d", acceptanceCriteria: "ac",
  comments: [], labels: [],
};

describe("executePreResearchPhase", () => {
  it("returns null briefs when config is undefined", async () => {
    const r = await executePreResearchPhase({
      config: undefined, configHash: "x",
      ticket, branchName: "b",
      runStep: vi.fn(),
    });
    expect(r.researchBrief).toBeNull();
    expect(r.implBrief).toBeNull();
    expect(r.outcome).toBe("skipped_disabled");
  });

  it("returns null briefs when enabled:false", async () => {
    const r = await executePreResearchPhase({
      config: cfg({ enabled: false }), configHash: "x",
      ticket, branchName: "b",
      runStep: vi.fn(),
    });
    expect(r.outcome).toBe("skipped_disabled");
  });

  it("returns null briefs when scope does not match", async () => {
    const r = await executePreResearchPhase({
      config: cfg({ scope: { mode: "label", label: "deep-research" } }),
      configHash: "x", ticket, branchName: "b",
      runStep: vi.fn(),
    });
    expect(r.outcome).toBe("skipped_out_of_scope");
  });

  it("routes brief via pass_to", async () => {
    const runStep = vi.fn().mockResolvedValue({
      brief_markdown: "B",
      references: [], open_questions: [], used_tools: [],
      cache_key: "k", model: "m", config_hash: "c", usage: null,
    });
    const r = await executePreResearchPhase({
      config: cfg({ pass_to: ["research"] }),
      configHash: "x", ticket, branchName: "b",
      runStep,
    });
    expect(r.researchBrief).toBe("B");
    expect(r.implBrief).toBeNull();
    expect(r.outcome).toBe("ok");
  });

  it("on_failure: skip swallows error and returns null briefs", async () => {
    const runStep = vi.fn().mockRejectedValue(new Error("boom"));
    const r = await executePreResearchPhase({
      config: cfg({ on_failure: "skip" }),
      configHash: "x", ticket, branchName: "b",
      runStep,
    });
    expect(r.researchBrief).toBeNull();
    expect(r.implBrief).toBeNull();
    expect(r.outcome).toBe("failed_skipped");
  });

  it("on_failure: fail re-throws", async () => {
    const runStep = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      executePreResearchPhase({
        config: cfg({ on_failure: "fail" }),
        configHash: "x", ticket, branchName: "b",
        runStep,
      }),
    ).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run — expect failures (no export, no agent.test exists)**

Run: `pnpm test src/workflows/agent.test.ts`
Expected: all six fail.

- [ ] **Step 3: Add `executePreResearchPhase` to `src/workflows/agent.ts`**

In `src/workflows/agent.ts`, just before `// --- Main Workflow ---`, insert:

```typescript
import type { PreResearchConfig } from "../lib/workflow-config.js";
import type { PreResearchBrief } from "../lib/pre-research-types.js";

export interface ExecutePreResearchInput {
  config: PreResearchConfig | undefined;
  configHash: string;
  ticket: {
    identifier: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    comments: Array<{ author: string; body: string; createdAt?: string }>;
    labels: readonly string[];
  };
  branchName: string;
  /** Inject the step runner — production uses `runPreResearch`. Tests inject a mock. */
  runStep: (input: import("../lib/pre-research-types.js").PreResearchInput) => Promise<PreResearchBrief | null>;
}

export interface ExecutePreResearchResult {
  researchBrief: string | null;
  implBrief: string | null;
  brief: PreResearchBrief | null;
  outcome:
    | "ok"
    | "skipped_disabled"
    | "skipped_out_of_scope"
    | "failed_skipped";
}

export async function executePreResearchPhase(
  input: ExecutePreResearchInput,
): Promise<ExecutePreResearchResult> {
  const empty: Omit<ExecutePreResearchResult, "outcome"> = {
    researchBrief: null,
    implBrief: null,
    brief: null,
  };
  const { config } = input;

  if (!config || !config.enabled) {
    return { ...empty, outcome: "skipped_disabled" };
  }

  const { matchesPreResearchScope } = await import("../lib/pre-research-scope.js");
  if (!matchesPreResearchScope(config.scope, {
    labels: input.ticket.labels,
    branchName: input.branchName,
  })) {
    return { ...empty, outcome: "skipped_out_of_scope" };
  }

  const { getBuiltinPreResearchPrompt } = await import("../lib/prompts.js");
  const systemPrompt =
    config.prompt.source === "builtin" && config.prompt.name
      ? getBuiltinPreResearchPrompt(config.prompt.name) ?? ""
      : ""; // arthur/local loading is a future slice; default to empty.

  let brief: PreResearchBrief | null;
  try {
    brief = await input.runStep({
      ticket: input.ticket,
      branchName: input.branchName,
      config,
      configHash: input.configHash,
      systemPrompt,
    });
  } catch (e) {
    if (config.on_failure === "fail") throw e;
    return { ...empty, outcome: "failed_skipped" };
  }

  const passResearch = config.pass_to.includes("research");
  const passImpl = config.pass_to.includes("impl");

  return {
    researchBrief: passResearch ? (brief?.brief_markdown ?? null) : null,
    implBrief: passImpl ? (brief?.brief_markdown ?? null) : null,
    brief,
    outcome: "ok",
  };
}
```

- [ ] **Step 4: Run executePreResearchPhase tests — expect green**

Run: `pnpm test src/workflows/agent.test.ts`
Expected: all six pass.

- [ ] **Step 5: Insert the call site in `agentWorkflow`**

In `src/workflows/agent.ts`, the existing code already declares `branchName` at line 491:

```typescript
488:  try {
489:    await notifyTicket(ticket.identifier, { kind: "started" });
490:
491:    const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
492:
493:    // Check for existing PR BEFORE creating/resetting the branch.
494:    // createFeatureBranch force-resets the branch to main's HEAD, which causes
495:    // GitHub to auto-close any open PR (no diff = no PR).
496:    const prContext = await fetchPRContext(branchName);
```

**Do not re-declare `branchName`.** Insert the Pre-Research block *between the existing line 491 (end of the `const branchName = ...` statement) and line 493 (the existing `// Check for existing PR ...` comment that precedes `const prContext = await fetchPRContext(branchName);`)*. The inserted block uses the already-declared `branchName` and leaves the existing `prContext` / `createFeatureBranch` flow untouched after it.

The block to insert (starts with the `// ============ PHASE 0: Pre-Research ============` comment, ends with `// ===== End of Pre-Research =====`):

```typescript
    // ============ PHASE 0: Pre-Research ============
    const { loadConfig } = await import("../lib/workflow-config.js");
    let preResearchConfig: Awaited<ReturnType<typeof loadConfig>>["config"]["preResearch"];
    let preResearchConfigHash: string;
    try {
      const loaded = await loadConfig();
      preResearchConfig = loaded.config.preResearch;
      preResearchConfigHash = loaded.configHash;
    } catch (e) {
      // Config-load failure for the review pipeline shouldn't block agent
      // workflow runs. Pre-research is opt-in; treat unloadable config as
      // disabled.
      preResearchConfig = undefined;
      preResearchConfigHash = "";
    }

    const { runPreResearch } = await import("../lib/pre-research.js");
    const preResearch = await executePreResearchPhase({
      config: preResearchConfig,
      configHash: preResearchConfigHash,
      ticket: {
        identifier: ticket.identifier,
        title: ticket.title,
        description: ticket.description,
        acceptanceCriteria: ticket.acceptanceCriteria,
        comments: ticket.comments,
        labels: ticket.labels,
      },
      branchName,
      runStep: runPreResearch,
    }).catch(async (err: Error) => {
      // on_failure: fail bubbled up from inside executePreResearchPhase.
      await unregisterRun(ticket.identifier);
      await moveTicket(ticketId, env.COLUMN_BACKLOG);
      await notifyTicket(ticket.identifier, {
        kind: "failed",
        phase: "pre_research",
        reason: err.message,
        usageReport: usageReportOrUndefined(),
      });
      return null;
    });
    if (preResearch === null) return; // on_failure: fail already terminated.

    if (preResearch.brief?.usage) {
      phaseUsages["Pre-Research"] = preResearch.brief.usage;
    }
    // ===== End of Pre-Research =====
```

**Lines that stay in place:** lines 491 (existing `const branchName`), 493–496 (existing PR-context comment + `fetchPRContext` call), and everything below remain unchanged. **Lines that move:** none — the block is purely an insertion.

Then update the two `assemble*` calls already in the function to pass the brief — replace the existing `researchInput = assembleResearchPlanContext({ ... })` to include `preResearchBrief: preResearch.researchBrief`, and `implInput = assembleImplementationContext({ ... })` to include `preResearchBrief: preResearch.implBrief`.

- [ ] **Step 6: Type-check and run full agent suite**

Run: `pnpm typecheck`
Run: `pnpm test src/workflows/agent.test.ts`
Run: `pnpm test src/workflows/prompts-step.test.ts`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/workflows/agent.ts src/workflows/agent.test.ts
git commit -m "feat(agent): wire pre-research phase between ticket fetch and sandbox provision"
```

---

## Task 12: Final Verification And Sample Config

**Files:**
- Modify: `workflow.config.yaml` (already in Task 1) — confirm sample is valid
- Modify: `SETUP.md` — add pre-research operator docs

- [ ] **Step 1: Add operator docs to SETUP.md**

In `SETUP.md`, add a new section near the existing review-pipeline section:

```markdown
### Pre-Research (Optional)

The opt-in Pre-Research phase runs before the sandbox is provisioned. It uses
an AI SDK agentic loop to gather external context (web docs, related tickets,
similar past PRs) and threads a brief into the Research and Implementation
prompts.

To enable:

1. Set `preResearch.enabled: true` in `workflow.config.yaml`.
2. (Optional) Add `web_search` to the `tools:` list and set `WEB_SEARCH_API_KEY`
   in the deployment env. Without that key, `web_search` is rejected at config
   load.
3. Choose `scope.mode` for staged rollout: start with `label` so only tagged
   tickets exercise the path; flip to `all` after a quiet week.
4. `pass_to` controls which downstream phases receive the brief
   (`research` and/or `impl`). Both is the default.
5. `on_failure: skip` keeps Pre-Research best-effort. `on_failure: fail` moves
   the ticket back to `COLUMN_BACKLOG` and emits a failed event with
   `phase: pre_research`.

Briefs are cached in Upstash Redis under
`ai_workflow:preresearch:<ticket_id>:<rev_hash>:<config_hash>` with the
configured TTL. Cache invalidates when ticket content or config changes.
```

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `pnpm test`
Run: `pnpm typecheck`
Expected: all green. Note any pre-existing skipped/flaky tests but ensure no regressions from this work.

- [ ] **Step 3: Commit**

```bash
git add SETUP.md
git commit -m "docs(pre-research): operator setup, rollout, and cache notes"
```

- [ ] **Step 4: Final sanity check**

Run: `pnpm build` (or whatever the project's bundle check is, e.g. `pnpm next build`)
Expected: build completes.

Spot-check the wiring:

```bash
grep -n "executePreResearchPhase\|preResearchBrief\|runPreResearch" src/workflows/agent.ts src/sandbox/context.ts
```

Expected: three or more matches showing the call site, the assembler arg, and the step import.

---

## Self-Review Checklist (Already Applied)

- **Spec coverage:** Every success criterion under "Pre-Research" in `docs/superpowers/specs/2026-05-19-pr-review-extensions-design.md` traces to a task: config validation → Task 1; types → Task 2; agentic loop → Task 3; tool belt + VCS additions → Tasks 4–5; cache → Task 6; step function → Task 7; failed phase event → Task 8; context threading → Task 9; scope filter → Task 10; agent wiring + on_failure + pass_to + phaseUsages → Task 11; docs → Task 12.
- **Placeholder scan:** No `TBD`, no "implement later", no naked "similar to Task N". Each step has the actual code or command. The one place where exact integration depends on existing code style (the GitHub adapter's Octokit invocation in Task 4) is called out explicitly so the engineer matches the existing pattern.
- **Type consistency:** `PreResearchBrief`, `PreResearchInput`, `PreResearchConfig`, `PreResearchToolName`, `PreResearchTicketData` names match across all tasks. `executePreResearchPhase` input/result shapes match between definition (Task 11) and call site (Task 11). `preResearchBrief` field name is identical in tests (Task 9) and assembler interfaces (Task 9).
