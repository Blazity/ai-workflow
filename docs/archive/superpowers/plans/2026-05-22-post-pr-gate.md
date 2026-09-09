# Post-PR Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a detached, webhook-triggered review workflow that runs configurable checks against a PR after the implementation workflow has already created it. Steps are surfaced as real GitHub Check Runs on the PR head SHA.

**Architecture:** GitHub `pull_request` webhook → Vercel Workflow DevKit (WDK) durable workflow → sequential gate steps. The gate is fully detached from `src/workflows/agent.ts`; the only coupling is the PR object that agent creates. Verification leans on tier2 live e2e tests (mirroring existing `e2e/tier2/*.test.ts`) rather than mocked-octokit unit tests.

**Tech Stack:** Vercel WDK (`"use step"`, `workflow/api`), Octokit (`@octokit/rest`), `zod`, `yaml`, Upstash Redis (existing `@upstash/redis` client), h3 (existing webhook framework).

---

## Decisions Locked During Grilling

| # | Decision |
|---|----------|
| 1 | Durable WDK workflow per webhook delivery (one workflow run per `{owner,repo,pr,headSha}`). |
| 2 | Triggered by `pull_request` actions `opened` / `synchronize` / `reopened`. Ignore `edited` and unchanged-SHA `reopened`. |
| 3 | Config lives at repo root: `post-pr-gate.yaml`. Mirrors `pre-sandbox.yaml` shape. |
| 4 | Step result shape: `{ conclusion: "success" \| "failure" \| "neutral"; summary; details?; annotations? }`. No inter-step state. PR comments are posted *inside* the step via the vcs adapter, not via the return value. |
| 5 | Runner owns Check Run lifecycle. Eager creation as `in_progress`. WDK step retries set to 0 — if a step errors the gate run fails loud and check runs are left in their last state. Cross-delivery reconciler deferred. |
| 6 | Sequential step execution. Each step is its own `"use step"`. |
| 7 | Idempotency via per-PR Upstash lock (`gate:lock:{repo}#{pr}`, SET NX with short TTL) wrapping the webhook critical section. Inside the lock: check `gate:current:{repo}#{pr}` for force-push, check `gate:dedupe:{repo}#{pr}@{sha}` for SHA-level dedupe, start the workflow, write both keys with the real `handle.runId`. Force-push cancels previous run via the pointer. Cross-delivery reconciler deferred. |
| 8 | Step context: branch-name ticket linkage (`blazebot/awt-42` → `AWT-42`), only `vcs` + `issueTracker` adapters exposed, step-owned AI SDK access. (Up-front diff fetch deferred until the first diff-consuming step lands.) |
| 9 | `GITHUB_WEBHOOK_SECRET` (required — webhook returns 401 if missing or invalid). `X-Hub-Signature-256` SHA-256 HMAC. GitHub App needs `checks:write` and `Pull request` event subscription — re-acceptance required on each installed repo. Crash-loud on missing permission in v1. |
| 10 | New code organization: `src/post-pr-gate/{types,config,runner,steps}.ts`; WDK entry at `src/workflows/post-pr-gate.ts`; webhook at `src/routes/webhooks/github.post.ts` (switches on `X-GitHub-Event`); `BRANCH_PREFIX` extracted to `src/lib/branch-prefix.ts`. |
| 11 | V1 ships exactly one step: `pr-title-format` (Conventional Commits regex). AI SDK-backed steps deferred. |
| 12 | Branch protection: punt. Gate is advisory-only in v1. |
| 13 | Test strategy: tier2 live e2e is primary. Plus a `config.test.ts` (zod) and one HMAC unit test. Drop mocked-runner / step unit tests. |

---

## File Structure

**New files:**

```
src/
├── lib/
│   ├── branch-prefix.ts                # BRANCH_PREFIX + branchForTicket + ticketKeyFromBranch
│   └── github-webhook-sig.ts           # verifyGitHubWebhookSignature (sha256, X-Hub-Signature-256)
├── post-pr-gate/
│   ├── types.ts                        # PostPrGateConfig, StepContext, StepResult, StepRegistry
│   ├── config.ts                       # zod schema + loadPostPrGateConfig
│   ├── config.test.ts                  # zod accept/reject cases
│   ├── runner.ts                       # executePostPrGatePhase — sequential + eager check creation
│   ├── gate-store.ts                   # Upstash dedupe + current-run pointer
│   └── steps/
│       ├── index.ts                    # postPrGateStepRegistry + PostPrGateStepId
│       └── pr-title-format.ts          # only v1 step
├── workflows/
│   └── post-pr-gate.ts                 # runPostPrGatePhase — WDK entry, "use step" wrappers
└── routes/webhooks/
    └── github.post.ts                  # HMAC verify + event filter + dedupe + workflow start
                                         # (no unit test — HMAC covered by github-webhook-sig.test.ts,
                                         #  dispatch paths covered by tier2 e2e)
```

**Modified files:**

```
src/sandbox/stop-ticket-sandboxes.ts    # remove local BRANCH_PREFIX, import from src/lib/branch-prefix.ts
src/workflows/agent.ts                  # line 544: use branchForTicket() helper
src/adapters/vcs/types.ts               # add CheckRunCapableVCS capability interface + annotation type
src/adapters/vcs/github.ts              # implement createCheckRun, updateCheckRun
env.ts                                  # add GITHUB_WEBHOOK_SECRET (optional)
e2e/helpers/github.ts                   # add listCheckRuns helper for assertions
e2e/tier2/                              # 4 new tier2 cases (see Phase C)
```

**Repo root:**

```
post-pr-gate.yaml                       # example config, committed
```

---

## Phase A — Preparatory Refactors

These produce no runtime behavior change. Land them first as a small PR to keep the main gate PR focused.

### Task A1: Extract `BRANCH_PREFIX` to a shared module

**Files:**
- Create: `src/lib/branch-prefix.ts`
- Modify: `src/sandbox/stop-ticket-sandboxes.ts:4` (remove local `const BRANCH_PREFIX`)
- Modify: `src/workflows/agent.ts:544` (use `branchForTicket()`)

- [ ] **Step 1: Create the helper module**

```ts
// src/lib/branch-prefix.ts
export const BRANCH_PREFIX = "blazebot/";

export function branchForTicket(ticketIdentifier: string): string {
  return `${BRANCH_PREFIX}${ticketIdentifier.toLowerCase()}`;
}

/** Reverse mapping. Returns null when the branch is not a Blazebot branch. */
export function ticketKeyFromBranch(branch: string): string | null {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const suffix = branch.slice(BRANCH_PREFIX.length);
  if (!suffix) return null;
  return suffix.toUpperCase();
}
```

- [ ] **Step 2: Update `stop-ticket-sandboxes.ts`**

Replace the local `const BRANCH_PREFIX = "blazebot/";` with:

```ts
import { BRANCH_PREFIX } from "../lib/branch-prefix.js";
```

- [ ] **Step 3: Update `agent.ts:544`**

Replace `const branchName = \`blazebot/${ticket.identifier.toLowerCase()}\`;` with:

```ts
const branchName = branchForTicket(ticket.identifier);
```

Add the import at the top of `agent.ts`:

```ts
import { branchForTicket } from "../lib/branch-prefix.js";
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Verify existing tests still pass**

Run: `pnpm test -- src/sandbox`
Expected: All pass. The string `"blazebot/task-1"` appears in test fixtures and should be unaffected (the constant value is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/lib/branch-prefix.ts src/sandbox/stop-ticket-sandboxes.ts src/workflows/agent.ts
git commit -m "refactor: extract BRANCH_PREFIX to src/lib/branch-prefix.ts"
```

---

### Task A2: Add `CheckRunCapableVCS` capability interface

**Files:**
- Modify: `src/adapters/vcs/types.ts`

- [ ] **Step 1: Add the new types**

Append to `src/adapters/vcs/types.ts`:

```ts
export interface CheckRunAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  annotationLevel: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  rawDetails?: string;
}

export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export interface CheckRunUpdate {
  status: "in_progress" | "completed";
  conclusion?: CheckRunConclusion;
  summary?: string;
  details?: string;
  annotations?: CheckRunAnnotation[];
}

/**
 * Capability interface — *not* extended onto VCSAdapter, because GitLab
 * has no equivalent. Callers check `hasCheckRunCapability(adapter)` before
 * invoking these methods. Adding methods to VCSAdapter directly would
 * force GitLab to throw at runtime; this surface keeps the failure to
 * detect-time, not invoke-time.
 */
export interface CheckRunCapableVCS {
  createCheckRun(name: string, headSha: string): Promise<number>;
  updateCheckRun(id: number, update: CheckRunUpdate): Promise<void>;
}

export function hasCheckRunCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & CheckRunCapableVCS {
  return (
    typeof (adapter as Partial<CheckRunCapableVCS>).createCheckRun === "function" &&
    typeof (adapter as Partial<CheckRunCapableVCS>).updateCheckRun === "function"
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/vcs/types.ts
git commit -m "feat: add CheckRunCapableVCS capability interface"
```

---

### Task A3: Implement `createCheckRun` / `updateCheckRun` on `GitHubAdapter`

**Files:**
- Modify: `src/adapters/vcs/github.ts`

GitHub's annotations API caps at **50 per update call** — multiple updates chunk them.

- [ ] **Step 1: Add method implementations**

Inside the `GitHubAdapter` class, after `getCheckRunResults`, add:

```ts
async createCheckRun(name: string, headSha: string): Promise<number> {
  const { data } = await this.octokit.checks.create({
    ...this.ownerRepo,
    name,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  return data.id;
}

async updateCheckRun(
  id: number,
  update: import("./types.js").CheckRunUpdate,
): Promise<void> {
  const baseParams = {
    ...this.ownerRepo,
    check_run_id: id,
    status: update.status,
    ...(update.conclusion ? { conclusion: update.conclusion } : {}),
    ...(update.status === "completed"
      ? { completed_at: new Date().toISOString() }
      : {}),
  };

  const output =
    update.summary !== undefined || update.details !== undefined
      ? {
          title: update.summary?.slice(0, 200) ?? "",
          summary: update.summary ?? "",
          ...(update.details ? { text: update.details } : {}),
        }
      : undefined;

  const annotations = update.annotations ?? [];
  if (annotations.length === 0) {
    await this.octokit.checks.update({
      ...baseParams,
      ...(output ? { output } : {}),
    });
    return;
  }

  // GitHub's `output` is fully overwritten on each update. Carry title +
  // summary + text through every batch so subsequent calls don't erase the
  // details body set by the first.
  const outputBase = {
    title: output?.title ?? "",
    summary: output?.summary ?? "",
    ...(output?.text ? { text: output.text } : {}),
  };

  for (let i = 0; i < annotations.length; i += 50) {
    const batch = annotations.slice(i, i + 50);
    const isFirst = i === 0;
    await this.octokit.checks.update({
      ...this.ownerRepo,
      check_run_id: id,
      // Only the first batch flips status / conclusion / completed_at.
      ...(isFirst
        ? baseParams
        : { status: update.status }),
      output: {
        ...outputBase,
        annotations: batch.map(mapAnnotation),
      },
    });
  }
}
```

Add at the bottom of the file (outside the class):

```ts
function mapAnnotation(a: import("./types.js").CheckRunAnnotation) {
  return {
    path: a.path,
    start_line: a.startLine,
    end_line: a.endLine,
    ...(a.startColumn !== undefined ? { start_column: a.startColumn } : {}),
    ...(a.endColumn !== undefined ? { end_column: a.endColumn } : {}),
    annotation_level: a.annotationLevel,
    message: a.message,
    ...(a.title ? { title: a.title } : {}),
    ...(a.rawDetails ? { raw_details: a.rawDetails } : {}),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/vcs/github.ts
git commit -m "feat: implement createCheckRun and updateCheckRun on GitHubAdapter"
```

---

### Task A4: Extract HMAC signature verification

GitHub webhooks use SHA-256 over `X-Hub-Signature-256`. Add a dedicated GitHub-flavored helper. Do **not** refactor `jira.post.ts` onto the same helper — the two protocols use different env vars, headers, and (in Jira's case) algorithm-agile method parsing. Merging them would add abstraction churn without security gain.

**Files:**
- Create: `src/lib/github-webhook-sig.ts`

- [ ] **Step 1: Create the helper**

```ts
// src/lib/github-webhook-sig.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GitHub-style X-Hub-Signature-256 header against the raw body.
 * Throws when the signature is missing, malformed, or does not match.
 *
 * Header format: "sha256=<hex>". GitHub always uses sha256 on this header.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }
  const [method, receivedHex] = signatureHeader.split("=", 2);
  if (method !== "sha256" || !receivedHex) {
    throw new Error("Malformed X-Hub-Signature-256 header");
  }
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(receivedHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid webhook signature");
  }
}
```

- [ ] **Step 2: Write the unit test (security-critical)**

Create `src/lib/github-webhook-sig.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "./github-webhook-sig.js";

const SECRET = "test-secret";

function sign(body: string): string {
  const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const body = '{"foo":"bar"}';
    expect(() => verifyGitHubWebhookSignature(body, sign(body), SECRET)).not.toThrow();
  });

  it("rejects a missing header", () => {
    expect(() => verifyGitHubWebhookSignature("x", undefined, SECRET)).toThrow(/Missing/);
  });

  it("rejects a malformed header", () => {
    expect(() => verifyGitHubWebhookSignature("x", "garbage", SECRET)).toThrow(/Malformed/);
  });

  it("rejects sha1 (legacy)", () => {
    expect(() => verifyGitHubWebhookSignature("x", "sha1=abc", SECRET)).toThrow(/Malformed/);
  });

  it("rejects an invalid signature", () => {
    const body = '{"foo":"bar"}';
    const wrong = sign(body).replace(/.$/, "0");
    expect(() => verifyGitHubWebhookSignature(body, wrong, SECRET)).toThrow(/Invalid/);
  });

  it("rejects signatures of mismatched length", () => {
    expect(() => verifyGitHubWebhookSignature("x", "sha256=deadbeef", SECRET)).toThrow(/Invalid/);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm test -- src/lib/github-webhook-sig.test.ts`
Expected: 6 passing.

- [ ] **Step 4: Commit Phase A**

```bash
git add src/lib/github-webhook-sig.ts src/lib/github-webhook-sig.test.ts
git commit -m "feat: add github webhook signature verification helper"
```

End of Phase A. The PR can ship here for review.

---

## Phase B — Gate Skeleton

### Task B1: Define `post-pr-gate` types

**Files:**
- Create: `src/post-pr-gate/types.ts`

- [ ] **Step 1: Write the types**

```ts
// src/post-pr-gate/types.ts
import type {
  VCSAdapter,
  CheckRunAnnotation,
} from "../adapters/vcs/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";

export const postPrGateTicketInputFields = [
  "identifier",
  "title",
  "description",
  "acceptanceCriteria",
  "comments",
  "labels",
] as const;
export type PostPrGateTicketInputField = (typeof postPrGateTicketInputFields)[number];

export interface PostPrGatePrInfo {
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  author: string;
  isDraft: boolean;
}

export interface PostPrGateTicket {
  identifier?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  comments?: Array<{ author: string; body: string; createdAt?: string }>;
  labels?: string[];
}

export interface PostPrGateFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: "added" | "removed" | "modified" | "renamed";
}

export interface PostPrGateStepContext {
  pr: PostPrGatePrInfo;
  ticket: PostPrGateTicket | null;
  diff: string | null;
  files: PostPrGateFile[] | null;
  adapters: {
    vcs: VCSAdapter;
    issueTracker: IssueTrackerAdapter;
  };
}

export type PostPrGateStepConclusion = "success" | "failure" | "neutral";

export interface PostPrGateStepResult {
  conclusion: PostPrGateStepConclusion;
  summary: string;
  details?: string;
  annotations?: CheckRunAnnotation[];
}

export type PostPrGateOnFailure = "continue" | "fail";

export interface PostPrGateConfigStep<StepId extends string = string> {
  uses: StepId;
  name?: string;
  timeoutMs?: number;
  onFailure: PostPrGateOnFailure;
  with?: unknown;
}

export interface PostPrGateRunOn {
  botPrsOnly: boolean;
  draftPrs: boolean;
  baseBranches: string[];
}

export interface PostPrGateConfig<StepId extends string = string> {
  postPrGate: {
    runOn: PostPrGateRunOn;
    steps: PostPrGateConfigStep<StepId>[];
  };
}

export interface PostPrGateStepExecutionInput {
  context: PostPrGateStepContext;
  config: unknown;
  step: PostPrGateConfigStep;
}

export type PostPrGateStepHandler = (
  input: PostPrGateStepExecutionInput,
) => Promise<PostPrGateStepResult>;

export type PostPrGateStepRegistry = Record<string, PostPrGateStepHandler>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

---

### Task B2: Config loader + schema + tests

**Files:**
- Create: `src/post-pr-gate/config.ts`
- Create: `src/post-pr-gate/config.test.ts`

- [ ] **Step 1: Write the loader**

```ts
// src/post-pr-gate/config.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { postPrGateStepRegistry, type PostPrGateStepId } from "./steps/index.js";
import type { PostPrGateConfig } from "./types.js";

const postPrGateConfigSchema = z
  .object({
    postPrGate: z
      .object({
        runOn: z
          .object({
            botPrsOnly: z.boolean(),
            draftPrs: z.boolean(),
            baseBranches: z.array(z.string().min(1)),
          })
          .strict(),
        steps: z.array(
          z
            .object({
              uses: z.string().min(1),
              name: z.string().trim().min(1).optional(),
              timeoutMs: z.number().int().positive().optional(),
              onFailure: z.enum(["continue", "fail"]),
              with: z.unknown().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export function defaultPostPrGateConfigPath(): string {
  return resolve(process.cwd(), "post-pr-gate.yaml");
}

export function loadPostPrGateConfig(
  configPath = defaultPostPrGateConfigPath(),
): PostPrGateConfig<PostPrGateStepId> {
  let parsedYaml: unknown;
  try {
    parsedYaml = parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (isNodeErrorWithCode(err, "ENOENT")) {
      throw new Error(`Missing post-pr-gate config at ${configPath}`);
    }
    throw new Error(
      `Failed to read post-pr-gate config at ${configPath}: ${errorMessage(err)}`,
    );
  }
  return parsePostPrGateConfig(parsedYaml);
}

export function parsePostPrGateConfig(
  value: unknown,
): PostPrGateConfig<PostPrGateStepId> {
  const result = postPrGateConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Invalid post-pr-gate config:\n" +
        result.error.issues
          .map((issue) => `  ${formatPath(issue.path)}: ${issue.message}`)
          .join("\n"),
    );
  }
  const unknown = result.data.postPrGate.steps
    .map((step, index) => ({ index, uses: step.uses }))
    .filter((s) => !(s.uses in postPrGateStepRegistry));
  if (unknown.length > 0) {
    throw new Error(
      "Invalid post-pr-gate config:\n" +
        unknown
          .map(
            (s) =>
              `  postPrGate.steps.${s.index}.uses: unknown post-pr-gate step "${s.uses}"`,
          )
          .join("\n"),
    );
  }
  return result.data as PostPrGateConfig<PostPrGateStepId>;
}

function formatPath(path: Array<string | number>): string {
  return path.length > 0 ? path.join(".") : "root";
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
```

- [ ] **Step 2: Write the test**

```ts
// src/post-pr-gate/config.test.ts
import { describe, expect, it } from "vitest";
import { parsePostPrGateConfig } from "./config.js";

const valid = {
  postPrGate: {
    runOn: { botPrsOnly: true, draftPrs: false, baseBranches: [] },
    steps: [
      { uses: "pr-title-format", onFailure: "continue" },
    ],
  },
};

describe("parsePostPrGateConfig", () => {
  it("accepts a minimal valid config", () => {
    const parsed = parsePostPrGateConfig(valid);
    expect(parsed.postPrGate.steps).toHaveLength(1);
  });

  it("rejects unknown step names", () => {
    expect(() =>
      parsePostPrGateConfig({
        ...valid,
        postPrGate: {
          ...valid.postPrGate,
          steps: [{ uses: "does-not-exist", onFailure: "continue" }],
        },
      }),
    ).toThrow(/unknown post-pr-gate step/);
  });

  it("rejects invalid onFailure values", () => {
    expect(() =>
      parsePostPrGateConfig({
        ...valid,
        postPrGate: {
          ...valid.postPrGate,
          steps: [{ uses: "pr-title-format", onFailure: "move_to_backlog" }],
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parsePostPrGateConfig({ ...valid, extra: 1 })).toThrow();
  });

  it("rejects missing runOn fields", () => {
    expect(() =>
      parsePostPrGateConfig({
        postPrGate: {
          runOn: { botPrsOnly: true },
          steps: [],
        },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run the test (should fail — registry not yet defined)**

Run: `pnpm test -- src/post-pr-gate/config.test.ts`
Expected: FAIL — `Cannot find module './steps/index.js'`. Next task creates it.

---

### Task B3: `pr-title-format` step + registry

**Files:**
- Create: `src/post-pr-gate/steps/pr-title-format.ts`
- Create: `src/post-pr-gate/steps/index.ts`

- [ ] **Step 1: Write the step**

```ts
// src/post-pr-gate/steps/pr-title-format.ts
import { z } from "zod";
import type { PostPrGateStepHandler } from "../types.js";

const DEFAULT_PATTERN =
  "^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\\([^)]+\\))?: .+";

const withSchema = z
  .object({
    pattern: z.string().min(1).default(DEFAULT_PATTERN),
  })
  .default({});

export const prTitleFormat: PostPrGateStepHandler = async ({ context, config }) => {
  const { pattern } = withSchema.parse(config ?? {});
  const regex = new RegExp(pattern);
  if (regex.test(context.pr.title)) {
    return {
      conclusion: "success",
      summary: "PR title matches the required format.",
    };
  }
  return {
    conclusion: "failure",
    summary: "PR title does not match Conventional Commits format.",
    details:
      "**Expected pattern:**\n\n" +
      "```\n" +
      pattern +
      "\n```\n\n" +
      "**Got:** `" +
      context.pr.title +
      "`",
  };
};
```

- [ ] **Step 2: Write the registry**

```ts
// src/post-pr-gate/steps/index.ts
import type { PostPrGateStepRegistry } from "../types.js";
import { prTitleFormat } from "./pr-title-format.js";

export const postPrGateStepRegistry = {
  "pr-title-format": prTitleFormat,
} satisfies PostPrGateStepRegistry;

export type PostPrGateStepId = keyof typeof postPrGateStepRegistry;
```

- [ ] **Step 3: Re-run config test from B2**

Run: `pnpm test -- src/post-pr-gate/config.test.ts`
Expected: 5 passing.

- [ ] **Step 4: Commit B1–B3**

```bash
git add src/post-pr-gate/
git commit -m "feat: add post-pr-gate types, config schema, and pr-title-format step"
```

---

### Task B4: Upstash gate store (dedupe + force-push pointer)

**Files:**
- Create: `src/post-pr-gate/gate-store.ts`

- [ ] **Step 1: Write the module**

```ts
// src/post-pr-gate/gate-store.ts
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

/**
 * Application-level dedupe, force-push tracking, and per-PR locking for
 * post-pr-gate runs.
 *
 * Three keys per PR:
 *   gate:lock:{repo}#{pr}        — short-TTL mutex around the webhook critical
 *                                  section. Released in `finally`; if the route
 *                                  process dies, the TTL releases it.
 *   gate:dedupe:{repo}#{pr}@{sha} — SET NX with the real `handle.runId`.
 *                                  Absent value means "never claimed for this SHA".
 *   gate:current:{repo}#{pr}     — JSON pointer to the latest run.
 *                                  Used to cancel the previous run on force-push.
 *
 * Lifetime: 14 days. PRs older than that fall back to "fresh" behavior on
 * re-delivery; acceptable for our use case.
 *
 * The `envPrefix` is passed in (not read from `process.env` at module load),
 * so namespacing is explicit and unit-testable. Production callers pass
 * `env.VERCEL_ENV` from the validated env schema.
 */

const TTL_SECONDS = 60 * 60 * 24 * 14;
const LOCK_TTL_SECONDS = 30;

export interface CurrentGateRun {
  runId: string;
  headSha: string;
  checkRunIds: number[];
}

export class GateStore {
  private redis: Redis;
  private envPrefix: string;

  constructor(opts: { url: string; token: string; envPrefix: string }) {
    this.redis = new Redis({ url: opts.url, token: opts.token });
    this.envPrefix = opts.envPrefix;
  }

  private lockKey(repo: string, pr: number): string {
    return `blazebot:gate:lock:${this.envPrefix}:${repo}#${pr}`;
  }

  private currentKey(repo: string, pr: number): string {
    return `blazebot:gate:current:${this.envPrefix}:${repo}#${pr}`;
  }

  private dedupeKey(repo: string, pr: number, headSha: string): string {
    return `blazebot:gate:dedupe:${this.envPrefix}:${repo}#${pr}@${headSha}`;
  }

  /**
   * Acquire the per-PR lock. Returns a token if acquired, null if busy.
   * Caller MUST call `releaseLock` with the same token in a `finally`.
   */
  async acquireLock(repo: string, pr: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.redis.set(this.lockKey(repo, pr), token, {
      nx: true,
      ex: LOCK_TTL_SECONDS,
    });
    return res === "OK" ? token : null;
  }

  /**
   * Release the per-PR lock — only if our token still owns it. A no-op if the
   * lock TTL'd out and another holder took over.
   */
  async releaseLock(repo: string, pr: number, token: string): Promise<void> {
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    await this.redis.eval(script, [this.lockKey(repo, pr)], [token]);
  }

  /**
   * Atomically claim a {repo, pr, headSha} as a unique gate run.
   * Returns the existing runId if already claimed, null if we won the race.
   * Designed to be called *inside* `acquireLock`, but the SET NX is a
   * defense-in-depth in case the lock TTL'd out mid-critical-section.
   */
  async claimRun(
    repo: string,
    pr: number,
    headSha: string,
    runId: string,
  ): Promise<string | null> {
    const res = await this.redis.set(
      this.dedupeKey(repo, pr, headSha),
      runId,
      { nx: true, ex: TTL_SECONDS },
    );
    if (res === "OK") return null;
    return (await this.redis.get<string>(this.dedupeKey(repo, pr, headSha))) ?? null;
  }

  async getDedupe(
    repo: string,
    pr: number,
    headSha: string,
  ): Promise<string | null> {
    return (await this.redis.get<string>(this.dedupeKey(repo, pr, headSha))) ?? null;
  }

  async getCurrent(repo: string, pr: number): Promise<CurrentGateRun | null> {
    return this.redis.get<CurrentGateRun>(this.currentKey(repo, pr));
  }

  async setCurrent(
    repo: string,
    pr: number,
    value: CurrentGateRun,
  ): Promise<void> {
    await this.redis.set(this.currentKey(repo, pr), value, { ex: TTL_SECONDS });
  }

  async appendCheckRunIds(
    repo: string,
    pr: number,
    ids: number[],
  ): Promise<void> {
    const current = await this.getCurrent(repo, pr);
    if (!current) return;
    await this.setCurrent(repo, pr, {
      ...current,
      checkRunIds: [...current.checkRunIds, ...ids],
    });
  }

  async clearCurrent(repo: string, pr: number): Promise<void> {
    await this.redis.del(this.currentKey(repo, pr));
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/post-pr-gate/gate-store.ts
git commit -m "feat: add GateStore for post-pr-gate dedupe and force-push tracking"
```

---

### Task B5: Runner

The runner is invoked from inside the WDK workflow (Task B6). It runs steps sequentially. Each step's check run is created eagerly (in `queued` state) at the start; the runner flips to `in_progress` before invoking the handler and to `completed` afterward.

**Files:**
- Create: `src/post-pr-gate/runner.ts`

- [ ] **Step 1: Write the runner**

```ts
// src/post-pr-gate/runner.ts
import type {
  PostPrGateConfig,
  PostPrGateConfigStep,
  PostPrGateStepContext,
  PostPrGateStepRegistry,
  PostPrGateStepResult,
} from "./types.js";
import { postPrGateTicketInputFields } from "./types.js";
import type {
  CheckRunCapableVCS,
  CheckRunConclusion,
} from "../adapters/vcs/types.js";
import { hasCheckRunCapability } from "../adapters/vcs/types.js";

interface RunnerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface RunPostPrGateInput {
  context: PostPrGateStepContext;
  config: PostPrGateConfig;
  /** Pre-created check run ids, in the same order as config.postPrGate.steps. */
  checkRunIds: number[];
  registry: PostPrGateStepRegistry;
  logger?: RunnerLogger;
}

export interface PostPrGateRunSummary {
  ranSteps: number;
  failed: boolean;
}

/**
 * Sequentially run gate steps. Each step's check run id is provided by the
 * caller (the workflow eagerly creates them all up front so they appear on
 * the PR immediately).
 *
 * Failure handling:
 *   - step throws or times out → conclusion = failure, details = error message
 *   - onFailure: "fail" + failure conclusion → mark remaining check runs as
 *     "cancelled" and stop the loop
 *   - onFailure: "continue" → log and proceed
 */
export async function executePostPrGatePhase(
  input: RunPostPrGateInput,
): Promise<PostPrGateRunSummary> {
  const { context, config, checkRunIds, registry, logger } = input;
  if (!hasCheckRunCapability(context.adapters.vcs)) {
    throw new Error("VCS adapter does not support check runs");
  }
  const vcs = context.adapters.vcs as typeof context.adapters.vcs & CheckRunCapableVCS;

  const steps = config.postPrGate.steps;
  if (steps.length !== checkRunIds.length) {
    throw new Error(
      `checkRunIds length (${checkRunIds.length}) must equal steps length (${steps.length})`,
    );
  }

  let failed = false;
  let ranSteps = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const checkRunId = checkRunIds[i];
    const displayName = step.name ?? step.uses;

    if (failed) {
      // Previous step had onFailure: "fail" — cancel remaining.
      await vcs.updateCheckRun(checkRunId, {
        status: "completed",
        conclusion: "cancelled",
        summary: "Skipped — previous required gate step failed.",
      });
      continue;
    }

    ranSteps++;

    let result: PostPrGateStepResult;
    try {
      const handler = registry[step.uses];
      if (!handler) {
        throw new Error(`Step "${step.uses}" is not registered`);
      }
      result = await withTimeout(
        handler({
          context: {
            ...context,
            ticket: selectTicketFields(context.ticket, step),
          },
          config: step.with,
          step,
        }),
        step.timeoutMs,
        displayName,
      );
    } catch (err) {
      const message = errorMessage(err);
      logger?.warn({ step: displayName, err: message }, "post_pr_gate_step_error");
      result = {
        conclusion: "failure",
        summary: `Gate step "${displayName}" errored.`,
        details: message,
      };
    }

    await vcs.updateCheckRun(checkRunId, {
      status: "completed",
      conclusion: result.conclusion as CheckRunConclusion,
      summary: result.summary,
      details: result.details,
      annotations: result.annotations,
    });

    if (result.conclusion === "failure" && step.onFailure === "fail") {
      failed = true;
    }
  }

  return { ranSteps, failed };
}

function selectTicketFields(
  ticket: PostPrGateStepContext["ticket"],
  step: PostPrGateConfigStep,
): PostPrGateStepContext["ticket"] {
  if (ticket === null) return null;
  const selected = selectedTicketFields(step.with);
  const result: NonNullable<PostPrGateStepContext["ticket"]> = {};
  for (const field of selected) {
    if (ticket[field] !== undefined) {
      (result as Record<string, unknown>)[field] = ticket[field];
    }
  }
  return result;
}

function selectedTicketFields(
  config: unknown,
): Array<(typeof postPrGateTicketInputFields)[number]> {
  if (!isRecord(config)) return [...postPrGateTicketInputFields];
  const input = config.input;
  if (!isRecord(input)) return [...postPrGateTicketInputFields];
  const fields = input.ticket;
  if (!Array.isArray(fields)) return [...postPrGateTicketInputFields];
  return postPrGateTicketInputFields.filter((f) => fields.includes(f));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  stepName: string,
): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Step "${stepName}" timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/post-pr-gate/runner.ts
git commit -m "feat: add post-pr-gate runner with check-run lifecycle"
```

---

### Task B6: WDK workflow entry

The workflow is the durable WDK function the webhook starts. It fetches PR context, eagerly creates all check runs (`in_progress`), then delegates to the runner.

**Files:**
- Create: `src/workflows/post-pr-gate.ts`

- [ ] **Step 1: Write the workflow**

```ts
// src/workflows/post-pr-gate.ts
import type {
  CheckRunCapableVCS,
} from "../adapters/vcs/types.js";

export interface PostPrGateWorkflowInput {
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  author: string;
  isDraft: boolean;
  url: string;
  /** Owner/repo string for gate-store keys. */
  ownerRepo: string;
}

/**
 * Detached workflow triggered by the GitHub webhook. Does NOT block agent.ts
 * and is NOT called from inside the implementation workflow. Coupling is
 * one-way: agent.ts creates a PR → that PR fires `pull_request` → this runs.
 */
export async function postPrGateWorkflow(
  input: PostPrGateWorkflowInput,
): Promise<{ ranSteps: number; failed: boolean }> {
  "use workflow";
  const summary = await runGate(input);
  return summary;
}

// NOTE: WDK step retries are intentionally configured to 0 for this step.
// The step contains non-idempotent side effects (GitHub `checks.create`,
// Upstash writes) — re-running on a transient error would produce duplicate
// check runs on the PR head SHA. If `runGate` errors, the gate run fails
// loud and check runs are left in whatever state they reached. See the
// "Decisions Locked" table row 5.
//
// Configure retries=0 via the WDK step config — verify the current WDK
// surface against https://vercel.com/docs/workflow before merging.
async function runGate(input: PostPrGateWorkflowInput) {
  "use step";
  const { loadPostPrGateConfig } = await import("../post-pr-gate/config.js");
  const { postPrGateStepRegistry } = await import("../post-pr-gate/steps/index.js");
  const { executePostPrGatePhase } = await import("../post-pr-gate/runner.js");
  const { GateStore } = await import("../post-pr-gate/gate-store.js");
  const { ticketKeyFromBranch } = await import("../lib/branch-prefix.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { logger } = await import("../lib/logger.js");
  const { env } = await import("../../env.js");
  const { hasCheckRunCapability } = await import("../adapters/vcs/types.js");

  const config = loadPostPrGateConfig();
  const adapters = createAdapters();
  const gateStore = new GateStore({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
    envPrefix: env.VERCEL_ENV ?? "development",
  });

  // Run-on filter
  if (config.postPrGate.runOn.botPrsOnly && !input.headRef.startsWith("blazebot/")) {
    logger.info({ headRef: input.headRef }, "post_pr_gate_skipped_not_bot_branch");
    return { ranSteps: 0, failed: false };
  }
  if (!config.postPrGate.runOn.draftPrs && input.isDraft) {
    logger.info({ pr: input.prNumber }, "post_pr_gate_skipped_draft");
    return { ranSteps: 0, failed: false };
  }
  const baseFilter = config.postPrGate.runOn.baseBranches;
  if (baseFilter.length > 0 && !baseFilter.includes(input.baseRef)) {
    logger.info({ baseRef: input.baseRef }, "post_pr_gate_skipped_base_branch");
    return { ranSteps: 0, failed: false };
  }

  if (!hasCheckRunCapability(adapters.vcs)) {
    throw new Error("VCS adapter does not support check runs (post-pr-gate requires GitHub)");
  }
  const vcs = adapters.vcs;

  // Ticket linkage
  const ticketKey = ticketKeyFromBranch(input.headRef);
  let ticket = null;
  if (ticketKey) {
    try {
      const fetched = await adapters.issueTracker.fetchTicket(ticketKey);
      ticket = {
        identifier: fetched.identifier,
        title: fetched.title,
        description: fetched.description,
        acceptanceCriteria: fetched.acceptanceCriteria,
        comments: fetched.comments,
        labels: fetched.labels,
      };
    } catch (err) {
      logger.warn(
        { ticketKey, err: (err as Error).message },
        "post_pr_gate_ticket_fetch_failed",
      );
    }
  }

  // Eager check-run creation
  const checkRunIds: number[] = [];
  for (const step of config.postPrGate.steps) {
    const name = `blazebot / ${step.name ?? step.uses}`;
    const id = await (vcs as unknown as CheckRunCapableVCS).createCheckRun(
      name,
      input.headSha,
    );
    checkRunIds.push(id);
  }
  await gateStore.appendCheckRunIds(input.ownerRepo, input.prNumber, checkRunIds);

  // Diff and files are null in v1 — the pr-title-format step doesn't need them.
  // When the first diff-consuming step lands, add a `fetchDiff` step before
  // executePostPrGatePhase and thread the result through `context.diff`.
  return executePostPrGatePhase({
    context: {
      pr: {
        number: input.prNumber,
        url: input.url,
        headSha: input.headSha,
        headRef: input.headRef,
        baseRef: input.baseRef,
        title: input.title,
        body: input.body,
        author: input.author,
        isDraft: input.isDraft,
      },
      ticket,
      diff: null,
      files: null,
      adapters: {
        vcs: adapters.vcs,
        issueTracker: adapters.issueTracker,
      },
    },
    config,
    checkRunIds,
    registry: postPrGateStepRegistry,
    logger,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/post-pr-gate.ts
git commit -m "feat: add post-pr-gate workflow entry"
```

---

### Task B7: Webhook route

The handler:
1. Verifies the `X-Hub-Signature-256` HMAC.
2. Switches on `X-GitHub-Event`. Only `pull_request` is handled in v1.
3. Filters action to `opened | synchronize | reopened` and ignores re-opens with unchanged head SHA.
4. Looks up `gate:current:{repo}#{pr}` — if the previous run is for a different SHA, cancel it (via `getRun(oldRunId).cancel()`) and mark its in-progress check runs as `cancelled`.
5. Tries to `claimRun({repo, pr, sha}, futureRunId)`. If already claimed, return `dispatched: false`.
6. Starts the workflow, writes the new pointer.

**Files:**
- Create: `src/routes/webhooks/github.post.ts`

No unit test for this route. HMAC verification has dedicated coverage in `src/lib/github-webhook-sig.test.ts` (Task A4) and is the only branch worth isolating in-process. Dispatch, dedupe, force-push cancellation, event filtering, and `reopened`-with-same-SHA all involve real Upstash + real WDK + real Octokit — mocking them produces a test that passes while the real wiring is broken (the exact failure mode the e2e-first decision was meant to avoid). All those paths are covered by Phase C tier2 cases against a deployed instance.

- [ ] **Step 1: Write the route**

```ts
// src/routes/webhooks/github.post.ts
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { start, getRun } from "workflow/api";
import { env } from "../../../env.js";
import { verifyGitHubWebhookSignature } from "../../lib/github-webhook-sig.js";
import { GateStore, type CurrentGateRun } from "../../post-pr-gate/gate-store.js";
import { postPrGateWorkflow } from "../../workflows/post-pr-gate.js";
import { logger } from "../../lib/logger.js";
import { createAdapters } from "../../lib/adapters.js";
import { hasCheckRunCapability } from "../../adapters/vcs/types.js";

const ALLOWED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  // HMAC verification is unconditional — GITHUB_WEBHOOK_SECRET is required
  // in env.ts. Missing or invalid signature → 401.
  try {
    verifyGitHubWebhookSignature(
      rawBody,
      getHeader(event, "x-hub-signature-256"),
      env.GITHUB_WEBHOOK_SECRET,
    );
  } catch (err) {
    throw createError({ statusCode: 401, statusMessage: (err as Error).message });
  }

  const ghEvent = getHeader(event, "x-github-event");
  if (ghEvent !== "pull_request") {
    return { status: "ignored", reason: "not_pull_request_event" };
  }

  const body = rawBody ? JSON.parse(rawBody) : {};
  const action = body?.action;
  const pr = body?.pull_request;
  const repo = body?.repository;
  if (!pr || !repo) {
    return { status: "ignored", reason: "malformed_payload" };
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return { status: "ignored", reason: `action_${action}` };
  }

  const ownerRepo = `${repo.owner.login}/${repo.name}`;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const headRef = pr.head.ref;

  const gateStore = new GateStore({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
    envPrefix: env.VERCEL_ENV ?? "development",
  });

  // ---------------------------------------------------------------------------
  // Critical section: lock per-PR, then handle reopened-same-SHA / force-push /
  // dedupe / start atomically. The lock has a 30s TTL — if the route process
  // dies, the lock releases automatically.
  // ---------------------------------------------------------------------------
  const lockToken = await gateStore.acquireLock(ownerRepo, prNumber);
  if (!lockToken) {
    logger.info({ ownerRepo, prNumber, headSha }, "post_pr_gate_webhook_lock_busy");
    return { status: "ignored", reason: "lock_busy" };
  }

  try {
    // 1. reopened with unchanged SHA → no-op.
    if (action === "reopened") {
      const cur = await gateStore.getCurrent(ownerRepo, prNumber);
      if (cur && cur.headSha === headSha) {
        return { status: "ignored", reason: "reopened_same_sha" };
      }
    }

    // 2. SHA-level dedupe — if we've already claimed this SHA, return ignored.
    const existingClaim = await gateStore.getDedupe(ownerRepo, prNumber, headSha);
    if (existingClaim !== null) {
      logger.info(
        { ownerRepo, prNumber, headSha, existingClaim },
        "post_pr_gate_webhook_already_claimed",
      );
      return { status: "ignored", reason: "already_claimed", runId: existingClaim };
    }

    // 3. Force-push cancel — previous run was for a different SHA.
    const previous = await gateStore.getCurrent(ownerRepo, prNumber);
    if (previous && previous.headSha !== headSha) {
      await cancelPreviousRun(previous, ownerRepo);
    }

    // 4. Start the workflow — get a real runId.
    const handle = await start(postPrGateWorkflow, [
      {
        prNumber,
        headSha,
        headRef,
        baseRef: pr.base.ref,
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "unknown",
        isDraft: !!pr.draft,
        url: pr.html_url,
        ownerRepo,
      },
    ]);

    // 5. Claim dedupe + write current pointer with the real runId. The
    //    `claimRun` SET NX is defense-in-depth in case the lock TTL'd out
    //    mid-section; if it lost the race, cancel the workflow we just started.
    const claimed = await gateStore.claimRun(ownerRepo, prNumber, headSha, handle.runId);
    if (claimed !== null) {
      logger.warn(
        { ownerRepo, prNumber, headSha, runId: handle.runId, winner: claimed },
        "post_pr_gate_lock_ttl_lost_race",
      );
      await getRun(handle.runId).cancel().catch(() => undefined);
      return { status: "ignored", reason: "already_claimed", runId: claimed };
    }
    await gateStore.setCurrent(ownerRepo, prNumber, {
      runId: handle.runId,
      headSha,
      checkRunIds: [],
    });

    logger.info(
      { ownerRepo, prNumber, headSha, runId: handle.runId },
      "post_pr_gate_started",
    );
    return { status: "dispatched", runId: handle.runId };
  } finally {
    await gateStore.releaseLock(ownerRepo, prNumber, lockToken);
  }
});

async function cancelPreviousRun(
  previous: CurrentGateRun,
  ownerRepo: string,
): Promise<void> {
  try {
    const run = getRun(previous.runId);
    await run.cancel();
  } catch (err) {
    logger.warn(
      { runId: previous.runId, err: (err as Error).message },
      "post_pr_gate_cancel_previous_failed",
    );
  }

  // Mark any in-progress check runs from the old run as cancelled.
  if (previous.checkRunIds.length > 0) {
    const adapters = createAdapters();
    if (hasCheckRunCapability(adapters.vcs)) {
      const vcs = adapters.vcs;
      for (const id of previous.checkRunIds) {
        await vcs.updateCheckRun(id, {
          status: "completed",
          conclusion: "cancelled",
          summary: "Cancelled — newer commit replaces this gate run.",
        }).catch((err) => {
          logger.warn(
            { ownerRepo, checkRunId: id, err: (err as Error).message },
            "post_pr_gate_cancel_check_failed",
          );
        });
      }
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/webhooks/github.post.ts
git commit -m "feat: add github webhook route for post-pr-gate"
```

---

### Task B8: Env additions + example config

**Files:**
- Modify: `env.ts`
- Create: `post-pr-gate.yaml`

- [ ] **Step 1: Add the env var**

In `env.ts`, near the existing `JIRA_WEBHOOK_SECRET`, add:

```ts
GITHUB_WEBHOOK_SECRET: z.string().min(1),
```

The secret is **required**, not optional. The webhook handler verifies HMAC unconditionally — a missing or invalid `X-Hub-Signature-256` returns 401. Deployments cannot ship without setting it (see Phase D).

- [ ] **Step 2: Add the example config**

```yaml
# post-pr-gate.yaml
postPrGate:
  runOn:
    botPrsOnly: true
    draftPrs: false
    baseBranches: []   # empty = all base branches

  steps:
    # The `name` field becomes part of the GitHub Check Run name
    # ("blazebot / <name>"). GitHub does NOT allow renaming check runs after
    # creation — changing `name` between commits produces parallel check runs
    # with different names on the PR's check history. Pick a stable value.
    - uses: pr-title-format
      name: pr-title-format
      onFailure: continue
      # Override the default regex if your project uses a different convention.
      # with:
      #   pattern: '^(feat|fix): .+'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add env.ts post-pr-gate.yaml
git commit -m "feat: add GITHUB_WEBHOOK_SECRET env and example post-pr-gate.yaml"
```

End of Phase B. The system is wired but has no e2e coverage yet.

---

## Phase C — Tier2 E2E Tests

Each tier2 test mirrors the shape of `e2e/tier2/us03-review-fix-cycle.test.ts`: create real GH branches/PRs via `e2e/helpers/github.ts`, wait for the gate to react, assert via the GitHub API, and clean up in `afterAll`.

### Task C1: Add `listCheckRuns` e2e helper

**Files:**
- Modify: `e2e/helpers/github.ts`

- [ ] **Step 1: Add the helper**

Append to `e2e/helpers/github.ts`:

```ts
export async function listCheckRuns(
  headSha: string,
): Promise<Array<{ id: number; name: string; status: string; conclusion: string | null }>> {
  const { data } = await octokit.checks.listForRef({ ...ownerRepo, ref: headSha });
  return data.check_runs.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    conclusion: c.conclusion ?? null,
  }));
}

export async function getPRHeadSha(prNumber: number): Promise<string> {
  const { data } = await octokit.pulls.get({ ...ownerRepo, pull_number: prNumber });
  return data.head.sha;
}
```

- [ ] **Step 2: Commit**

```bash
git add e2e/helpers/github.ts
git commit -m "test(e2e): add listCheckRuns and getPRHeadSha helpers"
```

---

### Task C2: E2E — title passes (`success` conclusion)

**Files:**
- Create: `e2e/tier2/us20-gate-pr-title-pass.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  closePR,
  deleteBranch,
  findPR,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";
import { openPR } from "../helpers/github.js";

/**
 * US-20: Post-PR gate produces a passing check run when PR title matches
 * Conventional Commits.
 */
describe("US-20: post-pr-gate pr-title-format — pass", () => {
  const ticketKey = `AWT-${Date.now()}-pass`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("marks the pr-title-format check as success", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "feat: add new feature", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    const checks = await waitFor(
      async () => {
        const runs = await listCheckRuns(sha);
        const titleCheck = runs.find((r) => r.name === "blazebot / pr-title-format");
        return titleCheck?.status === "completed" ? runs : null;
      },
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );

    const titleCheck = checks!.find((r) => r.name === "blazebot / pr-title-format");
    expect(titleCheck?.conclusion).toBe("success");
  });
});
```

- [ ] **Step 2: Run the e2e test against a deployed instance**

Run: `pnpm test:e2e -- e2e/tier2/us20-gate-pr-title-pass.test.ts`
Expected: 1 passing. Cleanup runs in `afterAll`.

- [ ] **Step 3: Commit**

```bash
git add e2e/tier2/us20-gate-pr-title-pass.test.ts e2e/helpers/github.ts
git commit -m "test(e2e): add tier2 gate pass case"
```

---

### Task C3: E2E — title fails (`failure` conclusion)

**Files:**
- Create: `e2e/tier2/us21-gate-pr-title-fail.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";

describe("US-21: post-pr-gate pr-title-format — fail", () => {
  const ticketKey = `AWT-${Date.now()}-fail`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("marks the pr-title-format check as failure for a non-conventional title", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "just doing stuff", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    const checks = await waitFor(
      async () => {
        const runs = await listCheckRuns(sha);
        const c = runs.find((r) => r.name === "blazebot / pr-title-format");
        return c?.status === "completed" ? runs : null;
      },
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );

    const titleCheck = checks!.find((r) => r.name === "blazebot / pr-title-format");
    expect(titleCheck?.conclusion).toBe("failure");
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us21-gate-pr-title-fail.test.ts
git add e2e/tier2/us21-gate-pr-title-fail.test.ts
git commit -m "test(e2e): add tier2 gate failure case"
```

---

### Task C4: E2E — non-bot branch is skipped

**Files:**
- Create: `e2e/tier2/us22-gate-skips-non-bot.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";

describe("US-22: post-pr-gate skips non-blazebot branches", () => {
  const branchName = `manual/test-${Date.now()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does NOT create blazebot check runs when botPrsOnly is true and branch is not blazebot/*", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/manual.md`, "x", "chore: seed");
    const pr = await openPR(branchName, "feat: manual change", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);

    // Wait long enough that, if the gate were going to run, it would have.
    // 30s buffer beyond webhook delivery + workflow start.
    await new Promise((r) => setTimeout(r, 30_000));

    const runs = await listCheckRuns(sha);
    const blazebotChecks = runs.filter((r) => r.name.startsWith("blazebot / "));
    expect(blazebotChecks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us22-gate-skips-non-bot.test.ts
git add e2e/tier2/us22-gate-skips-non-bot.test.ts
git commit -m "test(e2e): add tier2 gate skip-non-bot case"
```

---

### Task C5: E2E — force-push cancels previous run

**Files:**
- Create: `e2e/tier2/us23-gate-force-push-cancel.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";

describe("US-23: post-pr-gate cancels previous run on force-push", () => {
  const ticketKey = `AWT-${Date.now()}-force`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("cancels the old check runs when a new commit is pushed", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "first", "feat: seed");
    const pr = await openPR(branchName, "feat: add thing", "smoke");
    prNumber = pr.number;

    const firstSha = await getPRHeadSha(pr.number);

    // Wait until the first run's check appears as in_progress or completed.
    await waitFor(
      async () => {
        const runs = await listCheckRuns(firstSha);
        return runs.some((r) => r.name === "blazebot / pr-title-format") ? runs : null;
      },
      { timeoutMs: 60_000, intervalMs: 3_000 },
    );

    // Push a new commit (synchronize event) — moves the head SHA.
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "second", "feat: update");

    const newSha = await waitFor(
      async () => {
        const s = await getPRHeadSha(pr.number);
        return s !== firstSha ? s : null;
      },
      { timeoutMs: 30_000, intervalMs: 2_000 },
    );

    // The old check runs (against firstSha) must be cancelled.
    const oldRuns = await waitFor(
      async () => {
        const runs = await listCheckRuns(firstSha);
        const c = runs.find((r) => r.name === "blazebot / pr-title-format");
        return c?.conclusion === "cancelled" ? runs : null;
      },
      { timeoutMs: 60_000, intervalMs: 3_000 },
    );

    expect(oldRuns).toBeTruthy();

    // The new SHA gets its own run.
    const newRuns = await waitFor(
      async () => {
        const runs = await listCheckRuns(newSha!);
        const c = runs.find((r) => r.name === "blazebot / pr-title-format");
        return c?.status === "completed" ? runs : null;
      },
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );

    const newCheck = newRuns!.find((r) => r.name === "blazebot / pr-title-format");
    expect(newCheck?.conclusion).toBe("success");
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us23-gate-force-push-cancel.test.ts
git add e2e/tier2/us23-gate-force-push-cancel.test.ts
git commit -m "test(e2e): add tier2 gate force-push cancel case"
```

---

### Task C6: E2E — reopened with same SHA short-circuits

Reopen an already-gated PR without pushing a new commit. The webhook handler should ignore the event (`reopened_same_sha`) and the existing check runs on the head SHA should be untouched (no duplicate `blazebot / pr-title-format`).

**Files:**
- Create: `e2e/tier2/us24-gate-reopened-same-sha.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  reopenPR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";

describe("US-24: post-pr-gate ignores reopened with same SHA", () => {
  const ticketKey = `AWT-${Date.now()}-reopen`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does NOT create a second pr-title-format check run on reopen", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "feat: add thing", "smoke");
    prNumber = pr.number;
    const sha = await getPRHeadSha(pr.number);

    await waitFor(
      async () => {
        const runs = await listCheckRuns(sha);
        const c = runs.find((r) => r.name === "blazebot / pr-title-format");
        return c?.status === "completed" ? runs : null;
      },
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );

    const beforeCount = (await listCheckRuns(sha))
      .filter((r) => r.name === "blazebot / pr-title-format").length;
    expect(beforeCount).toBe(1);

    // Close + reopen without changing SHA.
    await closePR(pr.number);
    await reopenPR(pr.number);

    // Wait long enough for a re-dispatch to have created another check run, if any.
    await new Promise((r) => setTimeout(r, 30_000));

    const afterCount = (await listCheckRuns(sha))
      .filter((r) => r.name === "blazebot / pr-title-format").length;
    expect(afterCount).toBe(1);
  });
});
```

> The `reopenPR` helper is new — add to `e2e/helpers/github.ts` in this task. Signature: `reopenPR(prNumber: number): Promise<void>` → `octokit.pulls.update({ ...ownerRepo, pull_number: prNumber, state: "open" })`.

- [ ] **Step 2: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us24-gate-reopened-same-sha.test.ts
git add e2e/tier2/us24-gate-reopened-same-sha.test.ts e2e/helpers/github.ts
git commit -m "test(e2e): add tier2 gate reopened-same-sha case"
```

---

### Task C7: E2E — `onFailure: "fail"` cascades remaining steps to `cancelled`

The v1 config has one step, so cascading is dead at test time. This test temporarily ships a two-step config (both `pr-title-format` with different patterns; the first fails, the second is set up to pass but should be cancelled).

**Files:**
- Modify: `post-pr-gate.yaml` (test fixture) or create `post-pr-gate.test.yaml` and have `loadPostPrGateConfig` honor a `POST_PR_GATE_CONFIG_PATH` env override.
- Create: `e2e/tier2/us25-gate-onfailure-cascade.test.ts`

- [ ] **Step 1: Add an env override to `loadPostPrGateConfig`**

In `src/post-pr-gate/config.ts`, change `defaultPostPrGateConfigPath` to honor `POST_PR_GATE_CONFIG_PATH`:

```ts
export function defaultPostPrGateConfigPath(): string {
  return process.env.POST_PR_GATE_CONFIG_PATH
    ?? resolve(process.cwd(), "post-pr-gate.yaml");
}
```

Set this env var on the deployment used for tier2 tests to point at a two-step config:

```yaml
# post-pr-gate.test.yaml
postPrGate:
  runOn:
    botPrsOnly: true
    draftPrs: false
    baseBranches: []
  steps:
    - uses: pr-title-format
      name: pr-title-format-strict
      onFailure: fail
      with:
        pattern: '^(feat|fix): .+'
    - uses: pr-title-format
      name: pr-title-format-permissive
      onFailure: continue
```

- [ ] **Step 2: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";
import { waitFor } from "../helpers/wait.js";

describe("US-25: post-pr-gate cascades remaining steps to cancelled on hard failure", () => {
  const ticketKey = `AWT-${Date.now()}-cascade`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("marks the second step as cancelled when the first fails with onFailure: fail", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    // Title does NOT match the strict pattern → first step fails → second is cancelled.
    const pr = await openPR(branchName, "chore: bump deps", "smoke");
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    const runs = await waitFor(
      async () => {
        const r = await listCheckRuns(sha);
        const second = r.find((c) => c.name === "blazebot / pr-title-format-permissive");
        return second?.status === "completed" ? r : null;
      },
      { timeoutMs: 120_000, intervalMs: 5_000 },
    );

    const strict = runs!.find((r) => r.name === "blazebot / pr-title-format-strict");
    const permissive = runs!.find((r) => r.name === "blazebot / pr-title-format-permissive");
    expect(strict?.conclusion).toBe("failure");
    expect(permissive?.conclusion).toBe("cancelled");
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us25-gate-onfailure-cascade.test.ts
git add e2e/tier2/us25-gate-onfailure-cascade.test.ts src/post-pr-gate/config.ts post-pr-gate.test.yaml
git commit -m "test(e2e): add tier2 gate onFailure cascade case"
```

---

### Task C8: E2E — `runOn` filters (draft PR + base branch)

A single test exercising both branches of the runOn filter:
- a draft PR with a blazebot branch must NOT produce check runs (draftPrs: false).
- a PR targeting a non-allowed base branch must NOT produce check runs when `baseBranches` is non-empty.

**Files:**
- Create: `e2e/tier2/us26-gate-runon-filters.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, it } from "vitest";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  closePR,
  deleteBranch,
  listCheckRuns,
  getPRHeadSha,
} from "../helpers/github.js";

describe("US-26: post-pr-gate runOn filters", () => {
  const ticketKey = `AWT-${Date.now()}-draft`;
  const branchName = `blazebot/${ticketKey.toLowerCase()}`;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (prNumber) await closePR(prNumber);
    await deleteBranch(branchName);
  });

  it("does NOT run on draft PRs when draftPrs: false", async () => {
    await createBranch(branchName, "main");
    await createOrUpdateFile(branchName, `gate-fixtures/${ticketKey}.md`, "x", "feat: seed");
    const pr = await openPR(branchName, "feat: draft change", "smoke", { draft: true });
    prNumber = pr.number;

    const sha = await getPRHeadSha(pr.number);
    await new Promise((r) => setTimeout(r, 30_000));

    const runs = await listCheckRuns(sha);
    const blazebotChecks = runs.filter((r) => r.name.startsWith("blazebot / "));
    expect(blazebotChecks).toHaveLength(0);
  });
});
```

> Extend `openPR` to accept `{ draft?: boolean }` — pass through to `octokit.pulls.create({ draft: true })`.
>
> Base-branch filter coverage is omitted from CI because the demo repo only has `main`. Cover it manually via the smoke-test in Phase D step 5 against a repo with multiple base branches.

- [ ] **Step 2: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us26-gate-runon-filters.test.ts
git add e2e/tier2/us26-gate-runon-filters.test.ts e2e/helpers/github.ts
git commit -m "test(e2e): add tier2 gate runOn filter case"
```

---

### Task C9: E2E — HMAC failure returns 401

Direct POST to the webhook URL with a bad `X-Hub-Signature-256` should return 401 and produce no side effects. Cheap to run as a single fetch — no GitHub state required.

**Files:**
- Create: `e2e/tier2/us27-gate-hmac-failure.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";

const deploymentUrl = process.env.BLAZEBOT_DEPLOYMENT_URL;
if (!deploymentUrl) throw new Error("BLAZEBOT_DEPLOYMENT_URL is not set");

describe("US-27: post-pr-gate webhook rejects invalid HMAC", () => {
  it("returns 401 when X-Hub-Signature-256 is missing", async () => {
    const res = await fetch(`${deploymentUrl}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Hub-Signature-256 is invalid", async () => {
    const res = await fetch(`${deploymentUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm test:e2e -- e2e/tier2/us27-gate-hmac-failure.test.ts
git add e2e/tier2/us27-gate-hmac-failure.test.ts
git commit -m "test(e2e): add tier2 gate HMAC failure case"
```

---

## Phase D — Operational Setup (one-time per deployment)

Not code — these are the manual steps the deployer must perform after Phase B ships. Capture in setup notes (or extend `init-vcs.md` / similar).

- [ ] **Step 1: Update the GitHub App manifest**

   GitHub UI: Settings → Developer settings → GitHub Apps → the Blazebot App.

   Permissions:
   - Repository permissions → **Checks: Read and write** (add).

   Subscribe to events:
   - **Pull request** (enable).

- [ ] **Step 2: Re-accept on each installed repo**

   GitHub will mark the installation as "pending acceptance" on every repo where the App is installed. A repo admin must click "Review request" on `https://github.com/organizations/{org}/settings/installations/{installation_id}` and accept the new permission set.

- [ ] **Step 3: Configure the webhook**

   On the App configuration page:
   - **Webhook URL:** `https://<your-deployment>/webhooks/github`
   - **Webhook secret:** generate a random value, paste it.

- [ ] **Step 4: Set `GITHUB_WEBHOOK_SECRET` on Vercel (required)**

   ```bash
   vercel env add GITHUB_WEBHOOK_SECRET
   # Paste the same secret you set on the App.
   ```

   The secret is required. Deployments without it will fail env-schema validation at boot, and the webhook handler returns 401 on every request. Set the value in **all** environments (production, preview, development) — the webhook fires on preview deployments too.

- [ ] **Step 5: Smoke-test against the demo repo**

   Open a hand-crafted PR with title `feat: smoke check` on the demo repo (`reference_demo_repo` in memory). Assert the `blazebot / pr-title-format` check appears and resolves to `success`. Close the PR + delete the branch when done.

---

## Self-Review

**Spec coverage check:** every grilling decision (1–13) maps to a task above (1→B6, 2→B7, 3→B8, 4→B1/B5, 5→B5/B6 (retries=0), 6→B5, 7→B4/B7 (per-PR lock + dedupe + force-push pointer), 8→B5/B6, 9→A4/B7/B8/D (HMAC required), 10→A1/B1–B7, 11→B3, 12→D, 13→A4/B2/C).

**Placeholder scan:** no TODOs left in implementation. The `diff`/`files` fields are passed as `null` in v1; the comment in `src/workflows/post-pr-gate.ts` documents where to add the diff-fetching step when the first diff-consuming gate step lands.

**Type consistency:** `PostPrGateStepResult`, `PostPrGateStepContext`, `CheckRunUpdate`, `CheckRunAnnotation`, `CurrentGateRun`, `branchForTicket`, `ticketKeyFromBranch`, `BRANCH_PREFIX` are defined exactly once and referenced consistently.

**Concurrency model:** the webhook critical section is wrapped in a per-PR Upstash lock (`gate:lock:{repo}#{pr}`, 30s TTL). Inside the lock: read `gate:current` for reopened-same-SHA and force-push handling, read `gate:dedupe` for SHA-level dedupe, then `start()` the workflow and `claimRun` with the real `handle.runId`. The lock prevents both the dedupe-race and force-push-TOCTOU classes from Critical Issues #1 and #2 of the spec review. WDK step retries are configured to 0 (Decision 5) — non-idempotent operations are safe because the step never re-runs; a transient failure fails the gate run loud.

**Test boundary clarity:** the webhook route (`src/routes/webhooks/github.post.ts`) has no in-process unit test by design. HMAC verification lives in `src/lib/github-webhook-sig.test.ts`. The route's branches are covered by Phase C tier2 e2e against a deployed instance: dispatch (C2/C3), skip non-bot branch (C4), force-push cancel (C5), reopened-same-SHA (C6), onFailure cascade (C7), draft-PR filter (C8), HMAC failure (C9). Base-branch filter is covered by the Phase D manual smoke (the demo repo has only `main`, so CI can't exercise it).
