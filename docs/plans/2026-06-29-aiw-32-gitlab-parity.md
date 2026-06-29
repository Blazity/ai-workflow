# AIW-32 GitLab.com Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete GitLab.com single-project parity with the current GitHub workflow, including post-PR gate webhooks, visible gate statuses, changed-file listing, and setup documentation.

**Architecture:** Keep one post-PR gate workflow and normalize provider webhooks into the existing workflow input. Replace the GitHub-specific check-run capability with provider-neutral gate statuses: GitHub implements them with Check Runs, GitLab implements them with commit statuses on the MR head SHA. Store provider-specific gate status references so force-push cancellation works for both providers.

**Tech Stack:** TypeScript, Nitro/h3 routes, Vercel Workflow, Vitest, Drizzle/Postgres, GitHub Octokit, GitLab REST API via existing token config.

---

## Preflight

The worktree is `/Users/karol/Desktop/ai-workflow/.worktrees/aiw-32-gitlab-parity` on branch `codex/aiw-32-gitlab-parity`.

Dependency setup in this session was blocked by registry DNS after pnpm recreated `node_modules`. Before implementation, run this from the worktree with network/cache available:

```bash
env CI=true pnpm install
pnpm --filter worker test -- apps/worker/src/adapters/vcs/gitlab.test.ts
```

Expected:

- `pnpm install` completes without `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- Existing GitLab adapter tests pass before code changes.

If setup is still blocked, do not start implementation. Fix dependency setup first so failures are attributable to the change being made.

---

### Task 1: Make webhook secrets provider-specific

**Files:**

- Modify: `apps/worker/env.ts`
- Modify: `apps/worker/env.test.ts`

**Step 1: Write failing env tests**

In `apps/worker/env.test.ts`, update the existing GitLab env test so it removes `GITHUB_WEBHOOK_SECRET` and sets `GITLAB_WEBHOOK_SECRET`:

```ts
it("parses valid GitLab env without GitHub webhook secret", async () => {
  const gitlabEnv = { ...VALID_ENV };
  gitlabEnv.VCS_KIND = "gitlab";
  delete (gitlabEnv as any).GITHUB_APP_ID;
  delete (gitlabEnv as any).GITHUB_APP_PRIVATE_KEY;
  delete (gitlabEnv as any).GITHUB_INSTALLATION_ID;
  delete (gitlabEnv as any).GITHUB_OWNER;
  delete (gitlabEnv as any).GITHUB_REPO;
  delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
  delete (gitlabEnv as any).GITHUB_WEBHOOK_SECRET;
  (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
  (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
  (gitlabEnv as any).GITLAB_BASE_BRANCH = "develop";
  (gitlabEnv as any).GITLAB_WEBHOOK_SECRET = "gitlab-webhook-secret";
  Object.assign(process.env, gitlabEnv);

  const { env, getVcsConfig } = await import("./env.js");
  expect(env.GITLAB_WEBHOOK_SECRET).toBe("gitlab-webhook-secret");
  const vcs = getVcsConfig();
  expect(vcs.kind).toBe("gitlab");
  expect(vcs.repoPath).toBe("group/repo");
});
```

Add two provider-specific failure tests:

```ts
it("requires GITHUB_WEBHOOK_SECRET when VCS_KIND=github", async () => {
  const partial = { ...VALID_ENV };
  delete (partial as any).GITHUB_WEBHOOK_SECRET;
  Object.assign(process.env, partial);

  await expect(async () => {
    await import("./env.js");
  }).rejects.toThrow("VCS_KIND=github requires GITHUB_WEBHOOK_SECRET");
});

it("requires GITLAB_WEBHOOK_SECRET when VCS_KIND=gitlab", async () => {
  const gitlabEnv = { ...VALID_ENV };
  gitlabEnv.VCS_KIND = "gitlab";
  delete (gitlabEnv as any).GITHUB_APP_ID;
  delete (gitlabEnv as any).GITHUB_APP_PRIVATE_KEY;
  delete (gitlabEnv as any).GITHUB_INSTALLATION_ID;
  delete (gitlabEnv as any).GITHUB_OWNER;
  delete (gitlabEnv as any).GITHUB_REPO;
  delete (gitlabEnv as any).GITHUB_BASE_BRANCH;
  delete (gitlabEnv as any).GITHUB_WEBHOOK_SECRET;
  (gitlabEnv as any).GITLAB_TOKEN = "glpat-test";
  (gitlabEnv as any).GITLAB_PROJECT_ID = "group/repo";
  Object.assign(process.env, gitlabEnv);

  await expect(async () => {
    await import("./env.js");
  }).rejects.toThrow("VCS_KIND=gitlab requires GITLAB_WEBHOOK_SECRET");
});
```

**Step 2: Run the failing env tests**

Run:

```bash
pnpm --filter worker test -- env.test.ts
```

Expected: FAIL because `GITHUB_WEBHOOK_SECRET` is currently unconditionally required and `GITLAB_WEBHOOK_SECRET` is not in the schema.

**Step 3: Implement the env schema and cross-field validation**

In `apps/worker/env.ts`, change the webhook fields:

```ts
// GitHub Webhook
GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),

// GitLab Webhook
GITLAB_WEBHOOK_SECRET: z.string().min(1).optional(),
```

In the cross-field validation block, add provider-specific webhook secret checks inside the existing VCS branches:

```ts
if (env.VCS_KIND === "gitlab") {
  if (!env.GITLAB_TOKEN || !env.GITLAB_PROJECT_ID) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  VCS_KIND=gitlab requires GITLAB_TOKEN and GITLAB_PROJECT_ID",
    );
  }
  if (!env.GITLAB_WEBHOOK_SECRET) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  VCS_KIND=gitlab requires GITLAB_WEBHOOK_SECRET",
    );
  }
} else if (env.VCS_KIND === "github") {
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_INSTALLATION_ID ||
    !env.GITHUB_OWNER ||
    !env.GITHUB_REPO
  ) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  VCS_KIND=github requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID, GITHUB_OWNER, and GITHUB_REPO",
    );
  }
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new Error(
      "Invalid environment variables:\n" +
        "  VCS_KIND=github requires GITHUB_WEBHOOK_SECRET",
    );
  }
}
```

Leave `getVcsConfig()` unchanged except for any formatting needed by the file.

**Step 4: Run env tests**

Run:

```bash
pnpm --filter worker test -- env.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/worker/env.ts apps/worker/env.test.ts
git commit -m "Make VCS webhook secrets provider-specific"
```

---

### Task 2: Replace numeric check-run IDs with provider-neutral gate status refs

**Files:**

- Modify: `apps/worker/src/adapters/vcs/types.ts`
- Modify: `apps/worker/src/db/schema.ts`
- Create: `apps/worker/drizzle/0007_gate_status_refs.sql`
- Modify: `apps/worker/drizzle/meta/_journal.json`
- Modify or regenerate: `apps/worker/drizzle/meta/0007_snapshot.json`
- Modify: `apps/worker/src/post-pr-gate/gate-store.ts`
- Modify: `apps/worker/src/post-pr-gate/gate-store.test.ts`

**Step 1: Write failing gate-store tests for status refs**

In `apps/worker/src/post-pr-gate/gate-store.test.ts`, change the `current` fixture:

```ts
const current = {
  runId: "run_a",
  headSha: "sha1",
  gateStatusRefs: [] as Array<{ provider: "github"; id: number }>,
};
```

Update existing `checkRunIds` expectations to `gateStatusRefs`.

Replace the append test with:

```ts
it("appendGateStatusRefsForSha appends provider refs when SHA matches", async () => {
  await store.setCurrent("o/r", 1, current);
  expect(
    await store.appendGateStatusRefsForSha("o/r", 1, "sha1", [
      { provider: "github", id: 30000000001 },
    ]),
  ).toBe(true);
  expect(
    await store.appendGateStatusRefsForSha("o/r", 1, "sha1", [
      { provider: "gitlab", name: "blazebot / code-hygiene", headSha: "sha1" },
    ]),
  ).toBe(true);
  expect((await store.getCurrent("o/r", 1))!.gateStatusRefs).toEqual([
    { provider: "github", id: 30000000001 },
    { provider: "gitlab", name: "blazebot / code-hygiene", headSha: "sha1" },
  ]);
});
```

Update the mismatch/no-op tests to call `appendGateStatusRefsForSha`.

**Step 2: Run the failing gate-store tests**

Run:

```bash
pnpm --filter worker test -- gate-store.test.ts
```

Expected: FAIL because the schema and store still expose `checkRunIds`.

**Step 3: Add gate status types**

In `apps/worker/src/adapters/vcs/types.ts`, replace `CheckRunCapableVCS` with provider-neutral names:

```ts
export type GateStatusRef =
  | { provider: "github"; id: number }
  | { provider: "gitlab"; name: string; headSha: string };

export interface GateStatusCapableVCS {
  createGateStatus(name: string, headSha: string): Promise<GateStatusRef>;
  updateGateStatus(ref: GateStatusRef, update: CheckRunUpdate): Promise<void>;
}

export function hasGateStatusCapability(
  adapter: VCSAdapter,
): adapter is VCSAdapter & GateStatusCapableVCS {
  return (
    typeof (adapter as Partial<GateStatusCapableVCS>).createGateStatus === "function" &&
    typeof (adapter as Partial<GateStatusCapableVCS>).updateGateStatus === "function"
  );
}
```

Keep `CheckRunUpdate`, `CheckRunConclusion`, and `CheckRunAnnotation` names for now to avoid a broad rename. Add a short comment that the update shape is shared by GitHub Check Runs and GitLab commit statuses.

Remove `CheckRunCapableVCS` and `hasCheckRunCapability` after all call sites are migrated in later tasks.

**Step 4: Add the database column and schema field**

In `apps/worker/src/db/schema.ts`, import `jsonb` from `drizzle-orm/pg-core` and add a typed JSON column:

```ts
import type { GateStatusRef } from "../adapters/vcs/types.js";
```

In `gateCurrent`:

```ts
gateStatusRefs: jsonb("gate_status_refs")
  .$type<GateStatusRef[]>()
  .notNull()
  .default(sql`'[]'::jsonb`),
```

Leave `checkRunIds` in place for this migration to avoid destructive schema churn. New code should no longer read or write it.

Create `apps/worker/drizzle/0007_gate_status_refs.sql`:

```sql
ALTER TABLE "gate_current" ADD COLUMN "gate_status_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "gate_current"
SET "gate_status_refs" = COALESCE(
  (
    SELECT jsonb_agg(jsonb_build_object('provider', 'github', 'id', id))
    FROM unnest("check_run_ids") AS id
  ),
  '[]'::jsonb
);
```

Regenerate or hand-update drizzle metadata to include the new migration. Prefer:

```bash
pnpm --filter worker db:generate
```

If generation is unavailable, update `_journal.json` and create `0007_snapshot.json` consistently with the existing snapshots.

**Step 5: Update GateStore**

In `apps/worker/src/post-pr-gate/gate-store.ts`:

```ts
import type { GateStatusRef } from "../adapters/vcs/types.js";
```

Change `CurrentGateRun`:

```ts
export interface CurrentGateRun {
  runId: string;
  headSha: string;
  gateStatusRefs: GateStatusRef[];
}
```

Update `getCurrent()` select:

```ts
gateStatusRefs: gateCurrent.gateStatusRefs,
```

Update `setCurrent()` values and conflict update:

```ts
.values({ repo, pr, ...value, expiresAt: TTL })
...
gateStatusRefs: value.gateStatusRefs,
```

Replace `appendCheckRunIdsForSha()` with:

```ts
async appendGateStatusRefsForSha(
  repo: string,
  pr: number,
  expectedHeadSha: string,
  refs: GateStatusRef[],
): Promise<boolean> {
  if (refs.length === 0) return true;
  const rows = await this.db
    .update(gateCurrent)
    .set({
      gateStatusRefs: sql`${gateCurrent.gateStatusRefs} || ${JSON.stringify(refs)}::jsonb`,
    })
    .where(
      and(
        eq(gateCurrent.repo, repo),
        eq(gateCurrent.pr, pr),
        eq(gateCurrent.headSha, expectedHeadSha),
        sql`${gateCurrent.expiresAt} > now()`,
      ),
    )
    .returning({ pr: gateCurrent.pr });
  return rows.length > 0;
}
```

If TypeScript rejects the JSON interpolation, use a typed raw literal helper:

```ts
const literal = sql.raw(`'${JSON.stringify(refs).replaceAll("'", "''")}'::jsonb`);
```

and then:

```ts
gateStatusRefs: sql`${gateCurrent.gateStatusRefs} || ${literal}`,
```

**Step 6: Run gate-store tests**

Run:

```bash
pnpm --filter worker test -- gate-store.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/worker/src/adapters/vcs/types.ts apps/worker/src/db/schema.ts apps/worker/src/post-pr-gate/gate-store.ts apps/worker/src/post-pr-gate/gate-store.test.ts apps/worker/drizzle
git commit -m "Generalize stored post-PR gate status refs"
```

---

### Task 3: Update GitHub to the gate status capability

**Files:**

- Modify: `apps/worker/src/adapters/vcs/github.ts`
- Modify: `apps/worker/src/adapters/vcs/github.test.ts`
- Modify: `apps/worker/src/post-pr-gate/runner.ts`
- Modify: `apps/worker/src/workflows/post-pr-gate.ts`
- Modify: `apps/worker/src/routes/webhooks/github.post.ts`

**Step 1: Add GitHub adapter tests**

In `apps/worker/src/adapters/vcs/github.test.ts`, expand the `mockOctokit`:

```ts
checks: {
  create: vi.fn(),
  update: vi.fn(),
},
```

Add tests:

```ts
describe("gate statuses", () => {
  it("creates a GitHub check run and returns a gate status ref", async () => {
    mockOctokit.checks.create.mockResolvedValueOnce({ data: { id: 123 } });

    const adapter = ghAdapter();
    const ref = await adapter.createGateStatus("blazebot / code-hygiene", "sha1");

    expect(ref).toEqual({ provider: "github", id: 123 });
    expect(mockOctokit.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-org",
        repo: "test-repo",
        name: "blazebot / code-hygiene",
        head_sha: "sha1",
        status: "in_progress",
      }),
    );
  });

  it("updates a GitHub gate status ref", async () => {
    mockOctokit.checks.update.mockResolvedValueOnce({ data: {} });

    const adapter = ghAdapter();
    await adapter.updateGateStatus(
      { provider: "github", id: 123 },
      { status: "completed", conclusion: "success", summary: "ok" },
    );

    expect(mockOctokit.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-org",
        repo: "test-repo",
        check_run_id: 123,
        status: "completed",
        conclusion: "success",
      }),
    );
  });
});
```

**Step 2: Run the failing GitHub tests**

Run:

```bash
pnpm --filter worker test -- github.test.ts
```

Expected: FAIL because the adapter still exposes `createCheckRun/updateCheckRun`.

**Step 3: Rename GitHub capability methods**

In `apps/worker/src/adapters/vcs/github.ts`:

- Replace `CheckRunCapableVCS` with `GateStatusCapableVCS`.
- Rename `createCheckRun()` to `createGateStatus()` and return `{ provider: "github", id: data.id }`.
- Rename `updateCheckRun()` to `updateGateStatus(ref, update)`.
- At the top of `updateGateStatus()`, validate the ref:

```ts
if (ref.provider !== "github") {
  throw new Error(`GitHubAdapter cannot update ${ref.provider} gate status`);
}
```

- Use `ref.id` where `id` was previously used.

**Step 4: Update workflow and runner call sites**

In `apps/worker/src/post-pr-gate/runner.ts`:

- Rename input field `checkRunIds` to `gateStatusRefs`.
- Use `hasGateStatusCapability`.
- Call `vcs.updateGateStatus(gateStatusRef, update)`.
- Update length error text to `gateStatusRefs length (...) must equal steps length (...)`.

In `apps/worker/src/workflows/post-pr-gate.ts`:

- Use `GateStatusCapableVCS` and `hasGateStatusCapability`.
- Build `gateStatusRefs`:

```ts
const gateStatusRefs = [];
for (const step of config.postPrGate.steps) {
  const name = `blazebot / ${step.name ?? step.uses}`;
  const ref = await (vcs as GateStatusCapableVCS).createGateStatus(name, input.headSha);
  gateStatusRefs.push(ref);
}
const appended = await gateStore.appendGateStatusRefsForSha(
  input.ownerRepo,
  input.prNumber,
  input.headSha,
  gateStatusRefs,
);
```

In `apps/worker/src/routes/webhooks/github.post.ts`:

- Initialize `gateStatusRefs: []` in `setCurrent`.
- In `cancelPreviousRun`, check `previous.gateStatusRefs.length`.
- Use `hasGateStatusCapability`.
- Loop refs:

```ts
for (const ref of previous.gateStatusRefs) {
  await adapters.vcs.updateGateStatus(ref, {
    status: "completed",
    conclusion: "cancelled",
    summary: "Cancelled - newer commit replaces this gate run.",
  }).catch((err) => {
    logger.warn(
      { ownerRepo, gateStatusRef: ref, err: (err as Error).message },
      "post_pr_gate_cancel_status_failed",
    );
  });
}
```

**Step 5: Run targeted tests**

Run:

```bash
pnpm --filter worker test -- github.test.ts gate-store.test.ts
pnpm --filter worker typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/worker/src/adapters/vcs/github.ts apps/worker/src/adapters/vcs/github.test.ts apps/worker/src/post-pr-gate/runner.ts apps/worker/src/workflows/post-pr-gate.ts apps/worker/src/routes/webhooks/github.post.ts
git commit -m "Rename post-PR checks to gate statuses"
```

---

### Task 4: Add GitLab gate statuses and MR file listing

**Files:**

- Modify: `apps/worker/src/adapters/vcs/gitlab.ts`
- Modify: `apps/worker/src/adapters/vcs/gitlab.test.ts`

**Step 1: Add failing GitLab adapter tests**

In `apps/worker/src/adapters/vcs/gitlab.test.ts`, add a fetch mock because the new status and file-listing code will use GitLab REST endpoints directly:

```ts
const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
```

Add tests:

```ts
describe("gate statuses", () => {
  it("creates a GitLab commit status and returns a gate status ref", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    const adapter = glAdapter();
    const ref = await adapter.createGateStatus("blazebot / code-hygiene", "sha1");

    expect(ref).toEqual({
      provider: "gitlab",
      name: "blazebot / code-hygiene",
      headSha: "sha1",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/blazity%2Fdemo-app/statuses/sha1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "glpat-xxxxxxxxxxxx" }),
      }),
    );
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      state: "running",
      name: "blazebot / code-hygiene",
    });
  });

  it("updates a GitLab gate status ref to failure", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    const adapter = glAdapter();
    await adapter.updateGateStatus(
      { provider: "gitlab", name: "blazebot / code-hygiene", headSha: "sha1" },
      { status: "completed", conclusion: "failure", summary: "Found issues" },
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      state: "failed",
      name: "blazebot / code-hygiene",
      description: "Found issues",
    });
  });
});
```

Add MR file listing test:

```ts
describe("listPRFiles", () => {
  it("maps GitLab MR changes to PR files", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          changes: [
            {
              old_path: "src/old.ts",
              new_path: "src/new.ts",
              new_file: false,
              deleted_file: false,
              renamed_file: true,
              diff: "@@ -1 +1 @@\n-old\n+new",
            },
            {
              old_path: "README.md",
              new_path: "README.md",
              new_file: true,
              deleted_file: false,
              renamed_file: false,
              diff: "@@ -0,0 +1 @@\n+hello",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const adapter = glAdapter();
    const files = await adapter.listPRFiles(42);

    expect(files).toEqual([
      {
        path: "src/new.ts",
        additions: 0,
        deletions: 0,
        changeType: "renamed",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      {
        path: "README.md",
        additions: 0,
        deletions: 0,
        changeType: "added",
        patch: "@@ -0,0 +1 @@\n+hello",
      },
    ]);
  });
});
```

**Step 2: Run the failing GitLab tests**

Run:

```bash
pnpm --filter worker test -- gitlab.test.ts
```

Expected: FAIL because GitLab does not yet expose gate statuses or file listing.

**Step 3: Implement direct GitLab REST helpers**

In `apps/worker/src/adapters/vcs/gitlab.ts`, update imports:

```ts
  GateStatusCapableVCS,
  GateStatusRef,
  PRFile,
  PRFilesCapableVCS,
  CheckRunUpdate,
```

Update class declaration:

```ts
export class GitLabAdapter implements VCSAdapter, GateStatusCapableVCS, PRFilesCapableVCS {
```

Add local response shapes:

```ts
interface GitLabMRChangesResponse {
  changes?: GitLabMRChange[];
}

interface GitLabMRChange {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}
```

Add helpers near `getStatusCode()`:

```ts
private apiUrl(path: string): string {
  const host = (this.config.host ?? "https://gitlab.com").replace(/\/$/, "");
  return `${host}/api/v4${path}`;
}

private projectPath(): string {
  return encodeURIComponent(this.projectId);
}

private async gitlabFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(this.apiUrl(path), {
    ...init,
    headers: {
      "PRIVATE-TOKEN": this.config.token,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitLab API ${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}
```

**Step 4: Implement gate status methods**

Add:

```ts
async createGateStatus(name: string, headSha: string): Promise<GateStatusRef> {
  await this.postCommitStatus(headSha, name, {
    status: "in_progress",
    summary: "Gate step is running.",
  });
  return { provider: "gitlab", name, headSha };
}

async updateGateStatus(ref: GateStatusRef, update: CheckRunUpdate): Promise<void> {
  if (ref.provider !== "gitlab") {
    throw new Error(`GitLabAdapter cannot update ${ref.provider} gate status`);
  }
  await this.postCommitStatus(ref.headSha, ref.name, update);
}

private async postCommitStatus(
  headSha: string,
  name: string,
  update: Pick<CheckRunUpdate, "status" | "conclusion" | "summary">,
): Promise<void> {
  await this.gitlabFetch(`/projects/${this.projectPath()}/statuses/${encodeURIComponent(headSha)}`, {
    method: "POST",
    body: JSON.stringify({
      state: this.mapGateStatusState(update),
      name,
      description: truncateStatusDescription(update.summary ?? ""),
    }),
  });
}

private mapGateStatusState(
  update: Pick<CheckRunUpdate, "status" | "conclusion">,
): "pending" | "running" | "success" | "failed" | "canceled" | "skipped" {
  if (update.status === "in_progress") return "running";
  switch (update.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
      return "failed";
    case "cancelled":
      return "canceled";
    case "skipped":
      return "skipped";
    case "neutral":
      return "success";
    default:
      return "pending";
  }
}
```

Add file-level helper:

```ts
function truncateStatusDescription(value: string): string {
  return value.length <= 255 ? value : `${value.slice(0, 252)}...`;
}
```

**Step 5: Implement MR file listing**

Add:

```ts
async listPRFiles(prId: number): Promise<PRFile[]> {
  const data = await this.gitlabFetch<GitLabMRChangesResponse>(
    `/projects/${this.projectPath()}/merge_requests/${prId}/changes`,
  );
  return (data.changes ?? []).map((change) => ({
    path: change.new_path ?? change.old_path ?? "unknown",
    additions: 0,
    deletions: 0,
    changeType: mapGitLabChangeType(change),
    patch: change.diff,
  }));
}
```

Add helper:

```ts
function mapGitLabChangeType(change: GitLabMRChange): PRFile["changeType"] {
  if (change.new_file) return "added";
  if (change.deleted_file) return "removed";
  if (change.renamed_file) return "renamed";
  return "modified";
}
```

**Step 6: Run GitLab tests**

Run:

```bash
pnpm --filter worker test -- gitlab.test.ts
pnpm --filter worker typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/worker/src/adapters/vcs/gitlab.ts apps/worker/src/adapters/vcs/gitlab.test.ts
git commit -m "Add GitLab gate statuses and MR file listing"
```

---

### Task 5: Extract shared post-PR gate webhook dispatch

**Files:**

- Create: `apps/worker/src/routes/webhooks/post-pr-gate-dispatch.ts`
- Modify: `apps/worker/src/routes/webhooks/github.post.ts`

**Step 1: Create the shared dispatcher by moving GitHub route logic**

Create `apps/worker/src/routes/webhooks/post-pr-gate-dispatch.ts`:

```ts
import { start, getRun } from "workflow/api";
import { GateStore, type CurrentGateRun } from "../../post-pr-gate/gate-store.js";
import { getDb } from "../../db/client.js";
import { postPrGateWorkflow, type PostPrGateWorkflowInput } from "../../workflows/post-pr-gate.js";
import { logger } from "../../lib/logger.js";
import { createAdapters } from "../../lib/adapters.js";
import { hasGateStatusCapability } from "../../adapters/vcs/types.js";

export interface DispatchPostPrGateInput {
  action: string;
  workflowInput: PostPrGateWorkflowInput;
}

export async function dispatchPostPrGateWebhook(input: DispatchPostPrGateInput) {
  const { action, workflowInput } = input;
  const { ownerRepo, prNumber, headSha } = workflowInput;
  const gateStore = new GateStore(getDb());

  const lockToken = await gateStore.acquireLock(ownerRepo, prNumber);
  if (!lockToken) {
    logger.info({ ownerRepo, prNumber, headSha }, "post_pr_gate_webhook_lock_busy");
    return { status: "ignored", reason: "lock_busy" };
  }

  try {
    if (action === "reopened") {
      const cur = await gateStore.getCurrent(ownerRepo, prNumber);
      if (cur && cur.headSha === headSha) {
        return { status: "ignored", reason: "reopened_same_sha" };
      }
    }

    const existingClaim = await gateStore.getDedupe(ownerRepo, prNumber, headSha);
    if (existingClaim !== null) {
      logger.info(
        { ownerRepo, prNumber, headSha, existingClaim },
        "post_pr_gate_webhook_already_claimed",
      );
      return { status: "ignored", reason: "already_claimed", runId: existingClaim };
    }

    const previous = await gateStore.getCurrent(ownerRepo, prNumber);
    if (previous && previous.headSha !== headSha) {
      await cancelPreviousRun(previous, ownerRepo);
    }

    await gateStore.setCurrent(ownerRepo, prNumber, {
      runId: "",
      headSha,
      gateStatusRefs: [],
    });

    const handle = await start(postPrGateWorkflow, [workflowInput]);

    const claimed = await gateStore.claimRun(ownerRepo, prNumber, headSha, handle.runId);
    if (claimed !== null) {
      logger.warn(
        { ownerRepo, prNumber, headSha, runId: handle.runId, winner: claimed },
        "post_pr_gate_lock_ttl_lost_race",
      );
      await getRun(handle.runId).cancel().catch(() => undefined);
      return { status: "ignored", reason: "already_claimed", runId: claimed };
    }

    await gateStore.updateRunIdIfHeadSha(ownerRepo, prNumber, headSha, handle.runId);

    logger.info(
      { ownerRepo, prNumber, headSha, runId: handle.runId },
      "post_pr_gate_started",
    );
    return { status: "dispatched", runId: handle.runId };
  } finally {
    await gateStore.releaseLock(ownerRepo, prNumber, lockToken);
  }
}

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

  if (previous.gateStatusRefs.length === 0) return;

  const adapters = createAdapters();
  if (!hasGateStatusCapability(adapters.vcs)) return;

  for (const ref of previous.gateStatusRefs) {
    await adapters.vcs.updateGateStatus(ref, {
      status: "completed",
      conclusion: "cancelled",
      summary: "Cancelled - newer commit replaces this gate run.",
    }).catch((err) => {
      logger.warn(
        { ownerRepo, gateStatusRef: ref, err: (err as Error).message },
        "post_pr_gate_cancel_status_failed",
      );
    });
  }
}
```

**Step 2: Simplify GitHub route to use the dispatcher**

In `apps/worker/src/routes/webhooks/github.post.ts`:

- Remove imports for `workflow/api`, `GateStore`, `getDb`, `postPrGateWorkflow`, `createAdapters`, and capability checks.
- Import `dispatchPostPrGateWebhook`.
- Replace the lock/dedupe/start block with:

```ts
return dispatchPostPrGateWebhook({
  action,
  workflowInput: {
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
});
```

Leave GitHub HMAC validation, event filtering, action filtering, and repo filtering in the route.

**Step 3: Run typecheck and targeted tests**

Run:

```bash
pnpm --filter worker typecheck
pnpm --filter worker test -- gate-store.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add apps/worker/src/routes/webhooks/post-pr-gate-dispatch.ts apps/worker/src/routes/webhooks/github.post.ts
git commit -m "Share post-PR gate webhook dispatch"
```

---

### Task 6: Add GitLab webhook parsing and route

**Files:**

- Create: `apps/worker/src/lib/gitlab-webhook.ts`
- Create: `apps/worker/src/lib/gitlab-webhook.test.ts`
- Create: `apps/worker/src/routes/webhooks/gitlab.post.ts`

**Step 1: Write GitLab webhook helper tests**

Create `apps/worker/src/lib/gitlab-webhook.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  verifyGitLabWebhookToken,
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
} from "./gitlab-webhook.js";

const payload = {
  object_kind: "merge_request",
  user: { username: "alice" },
  project: {
    id: 123,
    path_with_namespace: "group/demo",
  },
  object_attributes: {
    iid: 42,
    action: "open",
    source_branch: "blazebot/AIW-32",
    target_branch: "main",
    title: "AIW-32 GitLab parity",
    description: "Body",
    url: "https://gitlab.com/group/demo/-/merge_requests/42",
    draft: false,
    work_in_progress: false,
    last_commit: { id: "sha1" },
  },
};

describe("verifyGitLabWebhookToken", () => {
  it("accepts a valid token", () => {
    expect(() => verifyGitLabWebhookToken("secret", "secret")).not.toThrow();
  });

  it("rejects missing token", () => {
    expect(() => verifyGitLabWebhookToken(undefined, "secret")).toThrow(/Missing/);
  });

  it("rejects invalid token", () => {
    expect(() => verifyGitLabWebhookToken("wrong", "secret")).toThrow(/Invalid/);
  });
});

describe("normalizeGitLabMergeRequestEvent", () => {
  it("normalizes a merge request payload", () => {
    expect(normalizeGitLabMergeRequestEvent(payload)).toEqual({
      action: "opened",
      workflowInput: {
        prNumber: 42,
        headSha: "sha1",
        headRef: "blazebot/AIW-32",
        baseRef: "main",
        title: "AIW-32 GitLab parity",
        body: "Body",
        author: "alice",
        isDraft: false,
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
        ownerRepo: "group/demo",
      },
    });
  });

  it("treats draft or WIP merge requests as draft", () => {
    const result = normalizeGitLabMergeRequestEvent({
      ...payload,
      object_attributes: {
        ...payload.object_attributes,
        title: "Draft: AIW-32",
        draft: true,
      },
    });
    expect(result.workflowInput.isDraft).toBe(true);
  });
});

describe("projectMatchesConfiguredId", () => {
  it("matches numeric id or path_with_namespace", () => {
    expect(projectMatchesConfiguredId(payload.project, "123")).toBe(true);
    expect(projectMatchesConfiguredId(payload.project, "group/demo")).toBe(true);
    expect(projectMatchesConfiguredId(payload.project, "other/demo")).toBe(false);
  });
});
```

**Step 2: Run failing helper tests**

Run:

```bash
pnpm --filter worker test -- gitlab-webhook.test.ts
```

Expected: FAIL because helper does not exist.

**Step 3: Implement GitLab webhook helpers**

Create `apps/worker/src/lib/gitlab-webhook.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import type { PostPrGateWorkflowInput } from "../workflows/post-pr-gate.js";

interface GitLabProject {
  id?: number;
  path_with_namespace?: string;
}

interface GitLabMergeRequestPayload {
  object_kind?: string;
  user?: { username?: string; name?: string };
  project?: GitLabProject;
  object_attributes?: {
    iid?: number;
    action?: string;
    source_branch?: string;
    target_branch?: string;
    title?: string;
    description?: string | null;
    url?: string;
    draft?: boolean;
    work_in_progress?: boolean;
    last_commit?: { id?: string };
  };
}

export function verifyGitLabWebhookToken(
  received: string | undefined,
  expected: string,
): void {
  if (!received) throw new Error("Missing X-Gitlab-Token header");
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid GitLab webhook token");
  }
}

export function normalizeGitLabMergeRequestEvent(
  payload: GitLabMergeRequestPayload,
): { action: string; workflowInput: PostPrGateWorkflowInput } {
  if (payload.object_kind !== "merge_request") {
    throw new Error("Not a GitLab merge request payload");
  }
  const attrs = payload.object_attributes;
  const project = payload.project;
  if (!attrs || !project) {
    throw new Error("Malformed GitLab merge request payload");
  }
  const prNumber = attrs.iid;
  const headSha = attrs.last_commit?.id;
  const headRef = attrs.source_branch;
  const baseRef = attrs.target_branch;
  const title = attrs.title ?? "";
  const url = attrs.url;
  const ownerRepo = project.path_with_namespace ?? String(project.id ?? "");
  if (!prNumber || !headSha || !headRef || !baseRef || !url || !ownerRepo) {
    throw new Error("Malformed GitLab merge request payload");
  }

  return {
    action: mapGitLabAction(attrs.action),
    workflowInput: {
      prNumber,
      headSha,
      headRef,
      baseRef,
      title,
      body: attrs.description ?? "",
      author: payload.user?.username ?? payload.user?.name ?? "unknown",
      isDraft: isDraftMergeRequest(attrs),
      url,
      ownerRepo,
    },
  };
}

export function projectMatchesConfiguredId(
  project: GitLabProject | undefined,
  configured: string,
): boolean {
  if (!project) return false;
  return String(project.id) === configured || project.path_with_namespace === configured;
}

function mapGitLabAction(action: string | undefined): string {
  if (action === "open") return "opened";
  if (action === "reopen") return "reopened";
  return action ?? "";
}

function isDraftMergeRequest(attrs: NonNullable<GitLabMergeRequestPayload["object_attributes"]>): boolean {
  return (
    attrs.draft === true ||
    attrs.work_in_progress === true ||
    /^(draft|wip):/i.test(attrs.title ?? "")
  );
}
```

**Step 4: Run helper tests**

Run:

```bash
pnpm --filter worker test -- gitlab-webhook.test.ts
```

Expected: PASS.

**Step 5: Implement the GitLab route**

Create `apps/worker/src/routes/webhooks/gitlab.post.ts`:

```ts
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import {
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
} from "../../lib/gitlab-webhook.js";
import { dispatchPostPrGateWebhook } from "./post-pr-gate-dispatch.js";
import { logger } from "../../lib/logger.js";

const ALLOWED_ACTIONS = new Set(["opened", "update", "reopened"]);

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    verifyGitLabWebhookToken(getHeader(event, "x-gitlab-token"), env.GITLAB_WEBHOOK_SECRET!);
  } catch (err) {
    throw createError({ statusCode: 401, statusMessage: (err as Error).message });
  }

  const glEvent = getHeader(event, "x-gitlab-event");
  if (glEvent !== "Merge Request Hook") {
    return { status: "ignored", reason: "not_merge_request_event" };
  }

  const body = rawBody ? JSON.parse(rawBody) : {};
  if (!projectMatchesConfiguredId(body.project, env.GITLAB_PROJECT_ID!)) {
    logger.info(
      { project: body.project, expected: env.GITLAB_PROJECT_ID },
      "post_pr_gate_gitlab_webhook_skipped_other_project",
    );
    return { status: "ignored", reason: "other_project" };
  }

  let normalized;
  try {
    normalized = normalizeGitLabMergeRequestEvent(body);
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  if (!ALLOWED_ACTIONS.has(normalized.action)) {
    return { status: "ignored", reason: `action_${normalized.action}` };
  }

  return dispatchPostPrGateWebhook(normalized);
});
```

**Step 6: Run typecheck**

Run:

```bash
pnpm --filter worker typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/worker/src/lib/gitlab-webhook.ts apps/worker/src/lib/gitlab-webhook.test.ts apps/worker/src/routes/webhooks/gitlab.post.ts
git commit -m "Add GitLab merge request webhook route"
```

---

### Task 7: Update docs for GitLab.com setup

**Files:**

- Create: `docs/GITLAB-SETUP.md`
- Modify: `README.md`
- Optional modify: `SETUP.md` if it has a VCS docs section.

**Step 1: Create GitLab setup docs**

Create `docs/GITLAB-SETUP.md` with this structure:

```md
# GitLab.com setup

Step-by-step guide for configuring ai-workflow against one GitLab.com project.

## What you'll end up with

Required Vercel env vars:

```text
VCS_KIND=gitlab
GITLAB_TOKEN=<project access token or bot PAT>
GITLAB_PROJECT_ID=<numeric project id or namespace/project path>
GITLAB_BASE_BRANCH=main
GITLAB_WEBHOOK_SECRET=<random secret>
```

## Token choice

Use a Project Access Token when available. If the GitLab.com plan or project
settings do not allow project access tokens, use a dedicated bot/service-account
Personal Access Token.

Do not use a human's day-to-day personal token for production automation.

## Required scopes

Use `api`. The workflow needs API writes for merge requests, comments, commit
statuses, branches, and project metadata, and the same token is used for Git
over HTTPS push from the sandbox. `write_repository` alone is not enough because
it does not authenticate GitLab REST API calls.

## Find the project id

Use either:

- Numeric project ID from GitLab project overview.
- Namespace/project path, for example `acme/demo-app`.

If using raw GitLab REST URLs manually, namespace/project paths must be URL
encoded as `acme%2Fdemo-app`. In env, set the readable path; the app encodes it.

## Configure the webhook

Project Settings -> Webhooks:

- URL: `https://<worker-deployment>/webhooks/gitlab`
- Secret token: same value as `GITLAB_WEBHOOK_SECRET`
- Trigger: Merge request events
- SSL verification: enabled

## Redeploy

After setting env vars, redeploy the worker so env validation runs with the new
configuration.
```

Add links to official GitLab docs at the bottom:

- Project access tokens
- Personal access tokens
- Project webhooks
- Merge Requests API
- Commits API

**Step 2: Link docs from README and SETUP**

In `README.md`, near the existing GitHub setup mention or setup section, add a GitLab setup link:

```md
For GitHub App setup, see [docs/GITHUB-APP-SETUP.md](./docs/GITHUB-APP-SETUP.md).
For GitLab.com setup, see [docs/GITLAB-SETUP.md](./docs/GITLAB-SETUP.md).
```

If `SETUP.md` has a VCS configuration section, add the same link there. Do not rewrite unrelated setup content.

**Step 3: Commit**

```bash
git add docs/GITLAB-SETUP.md README.md SETUP.md
git commit -m "Document GitLab.com setup"
```

---

### Task 8: Final verification and manual smoke notes

**Files:**

- Modify only if needed based on verification failures.

**Step 1: Run targeted unit tests**

Run:

```bash
pnpm --filter worker test -- env.test.ts gitlab.test.ts github.test.ts gitlab-webhook.test.ts gate-store.test.ts
```

Expected: PASS.

**Step 2: Run worker typecheck**

Run:

```bash
pnpm --filter worker typecheck
```

Expected: PASS.

**Step 3: Run worker unit suite**

Run:

```bash
pnpm --filter worker test
```

Expected: PASS.

**Step 4: Inspect diff for scope**

Run:

```bash
git status --short
git diff --stat main...HEAD
```

Expected:

- No unstaged changes.
- Diff limited to env validation, VCS adapter/capability, gate store/schema, webhook route/helper, and docs.

**Step 5: Manual GitLab.com smoke checklist**

Do not automate this unless a live GitLab.com test project is configured. Document results in the PR:

- Set `VCS_KIND=gitlab`, `GITLAB_TOKEN`, `GITLAB_PROJECT_ID`, `GITLAB_BASE_BRANCH`, and `GITLAB_WEBHOOK_SECRET`.
- Configure GitLab project webhook for merge request events.
- Open or update a `blazebot/<ticket>` MR.
- Confirm `/webhooks/gitlab` dispatches the post-PR gate.
- Confirm MR shows `blazebot / ...` commit statuses.
- Confirm force-pushing the MR branch cancels/replaces stale gate statuses for the old SHA.
- Confirm code hygiene can read changed files from GitLab MR changes.

**Step 6: Commit any verification fixes**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "Fix GitLab parity verification issues"
```

Otherwise, do not create an empty commit.
