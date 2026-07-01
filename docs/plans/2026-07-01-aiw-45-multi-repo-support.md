# AIW-45 Multi-Repo Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add multi-repo execution so one ticket run can select, clone, modify, push, and create PRs/MRs across multiple provider-accessible repositories.

**Architecture:** Keep GitHub and GitLab adapters as per-repo adapters. Add provider-level repository discovery, Workflow-Owned Branch records, a pre-sandbox repo-selection result, and a workspace manifest that tracks selected repos through sandbox provisioning, commit guards, push, and PR/MR creation. Runtime clone-on-demand is not implemented in this ticket, but the manifest/workspace layout must allow it later.

**Tech Stack:** TypeScript, Nitro/Vercel Workflows, Vercel Sandbox, Vitest, Octokit GitHub App auth, `@gitbeaker/rest`, pnpm.

---

## Notes Before Execution

- Use @superpowers:test-driven-development for every behavior change.
- Base branch is `origin/dev`.
- Design doc: `docs/plans/2026-07-01-aiw-45-multi-repo-support-design.md`.
- Implementation update: ownership is branch-level. A Workflow-Owned Branch is
  an AI Workflow database record for a ticket/repository branch, with optional
  PR/MR metadata attached after review is opened. Do not infer ownership from
  open PR/MR search results or matching branch names alone.
- The local worktree dependency setup may require `pnpm approve-builds` policy outside this plan. Do not commit `allowBuilds` placeholders that pnpm writes into `pnpm-workspace.yaml`.
- Run tests with `CI=true` when using pnpm in a non-interactive shell.
- GitHub official endpoint: `GET /installation/repositories` lists repositories accessible to an installation and supports `per_page` up to 100.
- GitLab official endpoint: `GET /projects` lists projects accessible to the authenticated user and supports pagination.

---

### Task 1: Repository Metadata Types And Per-Repo VCS Factory

**Files:**
- Create: `apps/worker/src/adapters/vcs/repository-directory.ts`
- Modify: `apps/worker/src/lib/create-vcs.ts:1-30`
- Test: `apps/worker/src/lib/create-vcs.test.ts`

**Step 1: Write failing tests**

Create `apps/worker/src/lib/create-vcs.test.ts` with tests for per-repo adapter creation:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/vcs/github.js", () => ({
  GitHubAdapter: vi.fn().mockImplementation((config) => ({ kind: "github-test", config })),
}));

vi.mock("../adapters/vcs/gitlab.js", () => ({
  GitLabAdapter: vi.fn().mockImplementation((config) => ({ kind: "gitlab-test", config })),
}));

import { createVCSForRepository } from "./create-vcs.js";

describe("createVCSForRepository", () => {
  it("creates a GitHub adapter for an arbitrary selected repo", async () => {
    const adapter = createVCSForRepository(
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        repoPath: "default/repo",
        baseBranch: "main",
        host: "https://github.com",
      },
      { repoPath: "org/api", baseBranch: "develop" },
    ) as any;

    expect(adapter.config).toMatchObject({
      owner: "org",
      repo: "api",
      baseBranch: "develop",
    });
  });

  it("creates a GitLab adapter for an arbitrary selected project", async () => {
    const adapter = createVCSForRepository(
      {
        kind: "gitlab",
        token: "glpat",
        repoPath: "default/repo",
        baseBranch: "main",
        host: "https://gitlab.example.com",
      },
      { repoPath: "group/service", baseBranch: "trunk" },
    ) as any;

    expect(adapter.config).toMatchObject({
      token: "glpat",
      projectId: "group/service",
      baseBranch: "trunk",
      host: "https://gitlab.example.com",
    });
  });

  it("rejects malformed GitHub repo paths", () => {
    expect(() =>
      createVCSForRepository(
        {
          kind: "github",
          auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
          repoPath: "default/repo",
          baseBranch: "main",
          host: "https://github.com",
        },
        { repoPath: "missing-owner", baseBranch: "main" },
      ),
    ).toThrow(/expected exactly "owner\/repo"/);
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/lib/create-vcs.test.ts
```

Expected: FAIL because `createVCSForRepository` does not exist.

**Step 3: Add repository metadata types**

Create `apps/worker/src/adapters/vcs/repository-directory.ts`:

```ts
export type VcsProvider = "github" | "gitlab";

export interface RepositoryMetadata {
  provider: VcsProvider;
  repoPath: string;
  name: string;
  owner: string;
  defaultBranch: string;
  description: string;
  webUrl: string;
  topics: string[];
  archived: boolean;
  private: boolean;
}

export interface RepositoryDirectory {
  listRepositories(): Promise<RepositoryMetadata[]>;
}

export interface WorkflowOwnedPr {
  id: number;
  url: string;
  branch: string;
}

export interface SelectedRepository {
  provider: VcsProvider;
  repoPath: string;
  defaultBranch: string;
  selectedRationale: string;
  workflowOwnedPr?: WorkflowOwnedPr;
}
```

**Step 4: Add per-repo VCS factory**

Modify `apps/worker/src/lib/create-vcs.ts`:

```ts
import { getVcsConfig, type VcsConfig } from "../../env.js";
import { GitHubAdapter } from "../adapters/vcs/github.js";
import { GitLabAdapter } from "../adapters/vcs/gitlab.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";

export interface RepoTarget {
  repoPath: string;
  baseBranch: string;
}

export function createVCS(): VCSAdapter {
  const vcs = getVcsConfig();
  return createVCSForRepository(vcs, {
    repoPath: vcs.repoPath,
    baseBranch: vcs.baseBranch,
  });
}

export function createVCSForRepository(
  vcs: VcsConfig,
  target: RepoTarget,
): VCSAdapter {
  if (vcs.kind === "gitlab") {
    return new GitLabAdapter({
      token: vcs.token,
      projectId: target.repoPath,
      baseBranch: target.baseBranch,
      host: vcs.host,
    });
  }

  if (vcs.kind !== "github") {
    throw new Error(`Unreachable: VCS kind ${(vcs as VcsConfig).kind} fell through GitHub branch`);
  }

  const parts = target.repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repoPath for GitHub: expected exactly "owner/repo", got "${target.repoPath}"`);
  }

  const [owner, repo] = parts;
  return new GitHubAdapter({
    auth: vcs.auth,
    owner,
    repo,
    baseBranch: target.baseBranch,
  });
}
```

**Step 5: Run tests to verify they pass**

Run:

```bash
CI=true pnpm --filter worker test -- src/lib/create-vcs.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/worker/src/adapters/vcs/repository-directory.ts apps/worker/src/lib/create-vcs.ts apps/worker/src/lib/create-vcs.test.ts
git commit -m "feat: add per-repo VCS factory"
```

---

### Task 2: Provider Repository Discovery

**Files:**
- Modify: `apps/worker/src/adapters/vcs/github.ts:1-40`
- Modify: `apps/worker/src/adapters/vcs/gitlab.ts:1-90`
- Modify: `apps/worker/src/lib/create-vcs.ts`
- Test: `apps/worker/src/adapters/vcs/github.test.ts`
- Test: `apps/worker/src/adapters/vcs/gitlab.test.ts`
- Test: `apps/worker/src/lib/create-vcs.test.ts`

**Step 1: Write failing GitHub discovery test**

Append to `apps/worker/src/adapters/vcs/github.test.ts`:

```ts
describe("GitHubRepositoryDirectory", () => {
  it("lists repositories accessible to the installation", async () => {
    mockOctokit.paginate = vi.fn().mockResolvedValueOnce([
      {
        full_name: "test-org/api",
        name: "api",
        owner: { login: "test-org" },
        default_branch: "main",
        description: "API service",
        html_url: "https://github.com/test-org/api",
        topics: ["backend"],
        archived: false,
        private: true,
      },
    ]);

    const { GitHubRepositoryDirectory } = await import("./github.js");
    const directory = new GitHubRepositoryDirectory({
      auth: { appId: 1, privateKeyBase64: "a2V5", installationId: 2 },
      host: "https://github.com",
    });

    await expect(directory.listRepositories()).resolves.toEqual([
      {
        provider: "github",
        repoPath: "test-org/api",
        name: "api",
        owner: "test-org",
        defaultBranch: "main",
        description: "API service",
        webUrl: "https://github.com/test-org/api",
        topics: ["backend"],
        archived: false,
        private: true,
      },
    ]);
    expect(mockOctokit.paginate).toHaveBeenCalled();
  });
});
```

If `mockOctokit` currently lacks `paginate`, add it to the mock object.

**Step 2: Write failing GitLab discovery test**

Append to `apps/worker/src/adapters/vcs/gitlab.test.ts`:

```ts
describe("GitLabRepositoryDirectory", () => {
  it("lists token-visible GitLab projects", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "x-next-page": "" }),
      json: async () => [
        {
          path_with_namespace: "group/api",
          name: "api",
          namespace: { full_path: "group" },
          default_branch: "main",
          description: "API service",
          web_url: "https://gitlab.example.com/group/api",
          topics: ["backend"],
          archived: false,
          visibility: "private",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GitLabRepositoryDirectory } = await import("./gitlab.js");
    const directory = new GitLabRepositoryDirectory({
      token: "glpat",
      host: "https://gitlab.example.com",
    });

    await expect(directory.listRepositories()).resolves.toEqual([
      {
        provider: "gitlab",
        repoPath: "group/api",
        name: "api",
        owner: "group",
        defaultBranch: "main",
        description: "API service",
        webUrl: "https://gitlab.example.com/group/api",
        topics: ["backend"],
        archived: false,
        private: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/api/v4/projects?membership=true&simple=true&per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ "PRIVATE-TOKEN": "glpat" }),
      }),
    );
  });
});
```

**Step 3: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.test.ts
```

Expected: FAIL because repository directory classes do not exist.

**Step 4: Implement GitHub discovery**

In `apps/worker/src/adapters/vcs/github.ts`, import `RepositoryDirectory` and `RepositoryMetadata`, then add:

```ts
export interface GitHubRepositoryDirectoryConfig {
  auth: GitHubAppAuth;
  host: string;
}

export class GitHubRepositoryDirectory implements RepositoryDirectory {
  private octokit: Octokit;

  constructor(private config: GitHubRepositoryDirectoryConfig) {
    this.octokit = buildOctokit(config.auth);
  }

  async listRepositories(): Promise<RepositoryMetadata[]> {
    const repos = await this.octokit.paginate(
      this.octokit.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );

    return repos
      .filter((repo) => !repo.archived && !repo.disabled)
      .map((repo) => ({
        provider: "github" as const,
        repoPath: repo.full_name,
        name: repo.name,
        owner: repo.owner?.login ?? repo.full_name.split("/")[0] ?? "",
        defaultBranch: repo.default_branch,
        description: repo.description ?? "",
        webUrl: repo.html_url,
        topics: Array.isArray(repo.topics) ? repo.topics : [],
        archived: repo.archived ?? false,
        private: repo.private ?? false,
      }));
  }
}
```

**Step 5: Implement GitLab discovery**

In `apps/worker/src/adapters/vcs/gitlab.ts`, add a small exported directory class. Keep it separate from `GitLabAdapter` so per-repo adapter behavior remains unchanged.

```ts
interface GitLabProjectListItem {
  path_with_namespace?: string;
  name?: string;
  namespace?: { full_path?: string };
  default_branch?: string;
  description?: string | null;
  web_url?: string;
  topics?: string[];
  tag_list?: string[];
  archived?: boolean;
  visibility?: string;
}

export interface GitLabRepositoryDirectoryConfig {
  token: string;
  host: string;
}

export class GitLabRepositoryDirectory implements RepositoryDirectory {
  constructor(private config: GitLabRepositoryDirectoryConfig) {}

  async listRepositories(): Promise<RepositoryMetadata[]> {
    const projects: GitLabProjectListItem[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(
        `${this.config.host.replace(/\/+$/, "")}/api/v4/projects?membership=true&simple=true&per_page=100&page=${page}`,
        { headers: { "PRIVATE-TOKEN": this.config.token } },
      );
      if (!res.ok) {
        throw new Error(`GitLab projects list failed: ${res.status} ${res.statusText}`);
      }
      projects.push(...((await res.json()) as GitLabProjectListItem[]));
      const nextPage = res.headers.get("x-next-page");
      if (!nextPage) break;
      page = Number(nextPage) - 1;
    }

    return projects
      .filter((project) => project.path_with_namespace && !project.archived)
      .map((project) => ({
        provider: "gitlab" as const,
        repoPath: project.path_with_namespace!,
        name: project.name ?? project.path_with_namespace!.split("/").at(-1) ?? project.path_with_namespace!,
        owner: project.namespace?.full_path ?? project.path_with_namespace!.split("/").slice(0, -1).join("/"),
        defaultBranch: project.default_branch ?? "main",
        description: project.description ?? "",
        webUrl: project.web_url ?? "",
        topics: project.topics ?? project.tag_list ?? [],
        archived: project.archived ?? false,
        private: project.visibility !== "public",
      }));
  }
}
```

**Step 6: Add directory factory**

Modify `apps/worker/src/lib/create-vcs.ts`:

```ts
import { GitHubRepositoryDirectory } from "../adapters/vcs/github.js";
import { GitLabRepositoryDirectory } from "../adapters/vcs/gitlab.js";
import type { RepositoryDirectory } from "../adapters/vcs/repository-directory.js";

export function createRepositoryDirectory(vcs: VcsConfig = getVcsConfig()): RepositoryDirectory {
  if (vcs.kind === "gitlab") {
    return new GitLabRepositoryDirectory({ token: vcs.token, host: vcs.host });
  }
  return new GitHubRepositoryDirectory({ auth: vcs.auth, host: vcs.host });
}
```

Add a factory test to `apps/worker/src/lib/create-vcs.test.ts`.

**Step 7: Run tests to verify they pass**

Run:

```bash
CI=true pnpm --filter worker test -- src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.test.ts src/lib/create-vcs.test.ts
```

Expected: PASS.

**Step 8: Commit**

```bash
git add apps/worker/src/adapters/vcs/github.ts apps/worker/src/adapters/vcs/gitlab.ts apps/worker/src/adapters/vcs/github.test.ts apps/worker/src/adapters/vcs/gitlab.test.ts apps/worker/src/lib/create-vcs.ts apps/worker/src/lib/create-vcs.test.ts
git commit -m "feat: list accessible VCS repositories"
```

---

### Task 3: Workflow-Owned Branch Records

**Files:**
- Modify: `apps/worker/src/db/schema.ts`
- Create: `apps/worker/src/db/queries/workflow-owned-prs.ts`
- Test: `apps/worker/src/db/queries/workflow-owned-prs.test.ts`
- Generate: `apps/worker/drizzle/*`

**Step 1: Write failing ownership-store tests**

Create `apps/worker/src/db/queries/workflow-owned-prs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db.js";
import {
  listWorkflowOwnedPrsForTicket,
  upsertWorkflowOwnedPr,
} from "./workflow-owned-prs.js";

describe("workflow-owned PR/MR records", () => {
  it("lists only PR/MRs AI Workflow recorded for the ticket", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedPr(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      prId: 42,
      url: "https://github.com/acme/web/pull/42",
      branchName: "blazebot/aiw-45",
    });
    await upsertWorkflowOwnedPr(db, {
      ticketKey: "AIW-46",
      provider: "github",
      repoPath: "acme/api",
      prId: 43,
      url: "https://github.com/acme/api/pull/43",
      branchName: "blazebot/aiw-46",
    });

    await expect(listWorkflowOwnedPrsForTicket(db, "AIW-45")).resolves.toEqual([
      expect.objectContaining({ repoPath: "acme/web", prId: 42 }),
    ]);
  });

  it("upserts by ticket and repository", async () => {
    const db = await createTestDb();

    await upsertWorkflowOwnedPr(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      prId: 42,
      url: "https://old",
      branchName: "blazebot/aiw-45",
    });
    await upsertWorkflowOwnedPr(db, {
      ticketKey: "AIW-45",
      provider: "github",
      repoPath: "acme/web",
      prId: 42,
      url: "https://new",
      branchName: "blazebot/aiw-45",
    });

    await expect(listWorkflowOwnedPrsForTicket(db, "AIW-45")).resolves.toEqual([
      expect.objectContaining({ repoPath: "acme/web", url: "https://new" }),
    ]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/db/queries/workflow-owned-prs.test.ts
```

Expected: FAIL because the table and query helper do not exist.

**Step 3: Add schema**

In `apps/worker/src/db/schema.ts`, add:

```ts
export const workflowOwnedPrs = pgTable(
  "workflow_owned_prs",
  {
    ticketKey: text("ticket_key").notNull(),
    provider: text("provider").notNull(),
    repoPath: text("repo_path").notNull(),
    prId: integer("pr_id").notNull(),
    prUrl: text("pr_url").notNull(),
    branchName: text("branch_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketKey, t.provider, t.repoPath] }),
    index("workflow_owned_prs_ticket_idx").on(t.ticketKey),
  ],
);
```

The primary key is the ownership rule: one ticket can own at most one PR/MR per
repository.

**Step 4: Add query helper**

Create `apps/worker/src/db/queries/workflow-owned-prs.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { workflowOwnedPrs } from "../schema.js";
import type { VcsProvider } from "../../adapters/vcs/repository-directory.js";

export interface WorkflowOwnedPrRecord {
  ticketKey: string;
  provider: VcsProvider;
  repoPath: string;
  prId: number;
  url: string;
  branchName: string;
}

export async function listWorkflowOwnedPrsForTicket(
  db: Db,
  ticketKey: string,
): Promise<WorkflowOwnedPrRecord[]> {
  const rows = await db
    .select()
    .from(workflowOwnedPrs)
    .where(eq(workflowOwnedPrs.ticketKey, ticketKey));

  return rows.map((row) => ({
    ticketKey: row.ticketKey,
    provider: row.provider as VcsProvider,
    repoPath: row.repoPath,
    prId: row.prId,
    url: row.prUrl,
    branchName: row.branchName,
  }));
}

export async function upsertWorkflowOwnedPr(
  db: Db,
  record: WorkflowOwnedPrRecord,
): Promise<void> {
  await db
    .insert(workflowOwnedPrs)
    .values({
      ticketKey: record.ticketKey,
      provider: record.provider,
      repoPath: record.repoPath,
      prId: record.prId,
      prUrl: record.url,
      branchName: record.branchName,
    })
    .onConflictDoUpdate({
      target: [
        workflowOwnedPrs.ticketKey,
        workflowOwnedPrs.provider,
        workflowOwnedPrs.repoPath,
      ],
      set: {
        prId: record.prId,
        prUrl: record.url,
        branchName: record.branchName,
        updatedAt: sql`now()`,
      },
    });
}
```

Remove unused imports after implementation if the final code does not need
them.

**Step 5: Generate migration**

Run:

```bash
pnpm --filter worker drizzle-kit generate
```

Commit the generated `apps/worker/drizzle/*` SQL and metadata with the schema
change. Do not hand-edit generated snapshots unless the generator produces a
known-bad diff that must be repaired.

**Step 6: Run tests to verify they pass**

Run:

```bash
CI=true pnpm --filter worker test -- src/db/queries/workflow-owned-prs.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/worker/src/db/schema.ts apps/worker/src/db/queries/workflow-owned-prs.ts apps/worker/src/db/queries/workflow-owned-prs.test.ts apps/worker/drizzle
git commit -m "feat: record workflow-owned pull requests"
```

### Task 4: Deterministic Repo Selection Step

**Files:**
- Create: `apps/worker/src/pre-sandbox/steps/repo-selection.ts`
- Modify: `apps/worker/src/pre-sandbox/steps/index.ts`
- Modify: `apps/worker/src/pre-sandbox/types.ts:1-106`
- Modify: `apps/worker/src/pre-sandbox/runner.ts:1-167`
- Test: `apps/worker/src/pre-sandbox/steps/repo-selection.test.ts`
- Test: `apps/worker/src/pre-sandbox/runner.test.ts`

**Step 1: Write failing selector tests**

Create `apps/worker/src/pre-sandbox/steps/repo-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectRepositoriesFromMetadata } from "./repo-selection.js";

const repos = [
  {
    provider: "github" as const,
    repoPath: "acme/web",
    name: "web",
    owner: "acme",
    defaultBranch: "main",
    description: "Next.js storefront",
    webUrl: "https://github.com/acme/web",
    topics: ["frontend"],
    archived: false,
    private: true,
  },
  {
    provider: "github" as const,
    repoPath: "acme/api",
    name: "api",
    owner: "acme",
    defaultBranch: "main",
    description: "Billing API and webhook handlers",
    webUrl: "https://github.com/acme/api",
    topics: ["backend"],
    archived: false,
    private: true,
  },
];

describe("selectRepositoriesFromMetadata", () => {
  it("selects repos with exact path matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Change the billing callback in acme/api.",
      repositories: repos,
      workflowOwnedPrs: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories.map((r) => r.repoPath)).toEqual(["acme/api"]);
  });

  it("selects repos by name and description terms", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedPrs: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories.map((r) => r.repoPath)).toEqual(["acme/api"]);
  });

  it("asks clarification when no repo matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update data warehouse model",
      repositories: repos,
      workflowOwnedPrs: [],
    });

    expect(selected).toEqual({
      status: "clarification_needed",
      questions: ["Which repository should this ticket modify?"],
    });
  });

  it("force-includes repos with Workflow-Owned PR/MRs", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Address review feedback",
      repositories: repos,
      workflowOwnedPrs: [{ repoPath: "acme/web", pr: { id: 42, url: "https://pr", branch: "blazebot/aiw-45" } }],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories[0]).toMatchObject({
      repoPath: "acme/web",
      workflowOwnedPr: { id: 42 },
    });
  });
});
```

**Step 2: Extend runner output tests**

In `apps/worker/src/pre-sandbox/runner.test.ts`, add a test that a step can return selected repositories and `executePreSandboxPhase` carries them into the final result.

**Step 3: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/pre-sandbox/steps/repo-selection.test.ts src/pre-sandbox/runner.test.ts
```

Expected: FAIL because selector and selected repo output do not exist.

**Step 4: Extend pre-sandbox types**

In `apps/worker/src/pre-sandbox/types.ts`, import `SelectedRepository` and add `selectedRepositories?: SelectedRepository[]` to continuing and halting step/result variants.

**Step 5: Accumulate selected repos in runner**

In `apps/worker/src/pre-sandbox/runner.ts`, maintain:

```ts
let selectedRepositories: SelectedRepository[] | undefined;
```

When a step result includes `selectedRepositories`, replace the current value. Return it on both continue and halt results.

**Step 6: Implement deterministic selector**

In `apps/worker/src/pre-sandbox/steps/repo-selection.ts`, export:

```ts
export function selectRepositoriesFromMetadata(input: {
  ticketText: string;
  repositories: RepositoryMetadata[];
  workflowOwnedPrs: Array<{ repoPath: string; pr: { id: number; url: string; branch: string } }>;
}): { status: "selected"; repositories: SelectedRepository[] } | { status: "clarification_needed"; questions: string[] } {
  // 1. Force include workflowOwnedPrs.
  // 2. Exact repoPath match wins.
  // 3. Score token overlap across repo name, path, description, and topics.
  // 4. Select the highest positive score. Include ties only when score >= 2.
  // 5. If no match and there is exactly one accessible repo, select it.
  // 6. Otherwise ask which repository to modify.
}
```

Keep stopwords small and local. Do not add dependencies.

**Step 7: Implement pre-sandbox handler**

In the same file, export a `PreSandboxStepHandler` that:

- Calls `createRepositoryDirectory().listRepositories()`.
- Calls `listWorkflowOwnedPrsForTicket(getDb(), context.ticket.identifier)` to load only PR/MR records AI Workflow created or recorded for this ticket.
- Does not call `findPR(context.run.branchName)` across Accessible Repositories; branch-name matches do not prove ownership.
- Builds ticket text from title, description, acceptance criteria, comments, and labels.
- Returns `status: "continue"` with selected repositories and a prompt addition listing selected repos.
- Returns `status: "halt"`, `outcome: "needs_clarification"` when no repo is selected.

**Step 8: Register step**

Modify `apps/worker/src/pre-sandbox/steps/index.ts`:

```ts
import { repoSelectionStep } from "./repo-selection.js";
import type { PreSandboxStepRegistry } from "../types.js";

export const preSandboxStepRegistry = {
  "repo-selection": repoSelectionStep,
} satisfies PreSandboxStepRegistry;
```

**Step 9: Run tests to verify they pass**

Run:

```bash
CI=true pnpm --filter worker test -- src/pre-sandbox/steps/repo-selection.test.ts src/pre-sandbox/runner.test.ts src/pre-sandbox/config.test.ts
```

Expected: PASS.

**Step 10: Commit**

```bash
git add apps/worker/src/pre-sandbox/types.ts apps/worker/src/pre-sandbox/runner.ts apps/worker/src/pre-sandbox/steps/index.ts apps/worker/src/pre-sandbox/steps/repo-selection.ts apps/worker/src/pre-sandbox/steps/repo-selection.test.ts apps/worker/src/pre-sandbox/runner.test.ts
git commit -m "feat: add pre-sandbox repository selection"
```

---

### Task 5: Workspace Manifest Utilities

**Files:**
- Create: `apps/worker/src/sandbox/repo-workspace.ts`
- Test: `apps/worker/src/sandbox/repo-workspace.test.ts`

**Step 1: Write failing tests**

Create `apps/worker/src/sandbox/repo-workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildRepoSlug,
  buildWorkspaceManifest,
  parseWorkspaceManifest,
} from "./repo-workspace.js";

describe("repo workspace manifest", () => {
  it("builds stable filesystem-safe slugs", () => {
    expect(buildRepoSlug("Acme/API Service")).toBe("acme__api-service");
    expect(buildRepoSlug("group/sub/repo")).toBe("group__sub__repo");
  });

  it("builds manifest entries from selected repositories", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
        },
      ],
    });

    expect(manifest.repositories).toEqual([
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox/repos/acme__api",
        branchName: "blazebot/aiw-45",
        defaultBranch: "main",
      }),
    ]);
  });

  it("parses valid manifest JSON", () => {
    const parsed = parseWorkspaceManifest(JSON.stringify({
      version: 1,
      repositories: [],
    }));
    expect(parsed.version).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/repo-workspace.test.ts
```

Expected: FAIL because module does not exist.

**Step 3: Implement manifest utilities**

Create `apps/worker/src/sandbox/repo-workspace.ts`:

```ts
import { z } from "zod";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

export const WORKSPACE_MANIFEST_PATH = "/vercel/sandbox/aiw-repos.json";
export const WORKSPACE_REPOS_DIR = "/vercel/sandbox/repos";

export const workspaceRepoSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  repoPath: z.string().min(1),
  slug: z.string().min(1),
  localPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  branchName: z.string().min(1),
  selectedRationale: z.string(),
  preAgentSha: z.string().optional(),
  workflowOwnedPr: z.object({
    id: z.number(),
    url: z.string(),
    branch: z.string(),
  }).optional(),
});

export const workspaceManifestSchema = z.object({
  version: z.literal(1),
  repositories: z.array(workspaceRepoSchema),
});

export type WorkspaceRepo = z.infer<typeof workspaceRepoSchema>;
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

export function buildRepoSlug(repoPath: string): string {
  return repoPath
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("__");
}

export function buildWorkspaceManifest(input: {
  branchName: string;
  repositories: SelectedRepository[];
}): WorkspaceManifest {
  return {
    version: 1,
    repositories: input.repositories.map((repo) => {
      const slug = buildRepoSlug(repo.repoPath);
      return {
        provider: repo.provider,
        repoPath: repo.repoPath,
        slug,
        localPath: `${WORKSPACE_REPOS_DIR}/${slug}`,
        defaultBranch: repo.defaultBranch,
        branchName: input.branchName,
        selectedRationale: repo.selectedRationale,
        ...(repo.workflowOwnedPr ? { workflowOwnedPr: repo.workflowOwnedPr } : {}),
      };
    }),
  };
}

export function parseWorkspaceManifest(raw: string): WorkspaceManifest {
  return workspaceManifestSchema.parse(JSON.parse(raw));
}
```

**Step 4: Run tests to verify they pass**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/repo-workspace.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/worker/src/sandbox/repo-workspace.ts apps/worker/src/sandbox/repo-workspace.test.ts
git commit -m "feat: add repository workspace manifest"
```

---

### Task 6: Multi-Repo Sandbox Provisioning

**Files:**
- Modify: `apps/worker/src/sandbox/manager.ts:5-105`
- Modify: `apps/worker/src/sandbox/manager.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts:218-302`

**Step 1: Write failing sandbox manager tests**

Extend `apps/worker/src/sandbox/manager.test.ts`:

```ts
it("clones every selected repository into the workspace manifest paths", async () => {
  const manager = new SandboxManager(baseConfig);
  await manager.provisionMultiRepo(
    {
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "test-org/api",
          defaultBranch: "main",
          selectedRationale: "api",
        },
        {
          provider: "github",
          repoPath: "test-org/web",
          defaultBranch: "main",
          selectedRationale: "web",
        },
      ],
    },
    makeFakeAgent(),
    { model: "any", anthropicApiKey: "k" },
  );

  expect(mockRunCommand).toHaveBeenCalledWith("mkdir", ["-p", "/vercel/sandbox/repos"]);
  expect(mockRunCommand).toHaveBeenCalledWith(
    "git",
    expect.arrayContaining(["clone", "--branch", "blazebot/aiw-45"]),
    expect.anything(),
  );
  expect(mockWriteFiles).toHaveBeenCalledWith([
    expect.objectContaining({ path: "/vercel/sandbox/aiw-repos.json" }),
  ]);
});

it("records pre-agent SHA per cloned repository", async () => {
  const manager = new SandboxManager(baseConfig);
  await manager.provisionMultiRepo(
    {
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "test-org/api",
          defaultBranch: "main",
          selectedRationale: "api",
        },
      ],
    },
    makeFakeAgent(),
    { model: "any", anthropicApiKey: "k" },
  );

  const shaCall = mockRunCommand.mock.calls.find(
    ([cmd, args]) => cmd === "git" && args?.[0] === "-C" && args?.includes("rev-parse"),
  );
  expect(shaCall).toBeDefined();
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/manager.test.ts
```

Expected: FAIL because `provisionMultiRepo` does not exist.

**Step 3: Implement `provisionMultiRepo`**

Keep existing `provision(...)` for single-repo compatibility. Add a new method:

```ts
async provisionMultiRepo(
  input: { branchName: string; repositories: SelectedRepository[]; mergeBase?: string },
  agent: AgentAdapter,
  configureOpts: ConfigureOpts,
): Promise<SandboxInstance> {
  if (input.repositories.length === 0) {
    throw new Error("Cannot provision sandbox without selected repositories");
  }
  const token = await this.config.getToken();
  const first = input.repositories[0];
  const firstUrls = buildVcsUrls({ ...this.config, repoPath: first.repoPath }, token);
  const sandbox = await Sandbox.create({ ...source from first repo... });

  await sandbox.runCommand("mkdir", ["-p", WORKSPACE_REPOS_DIR]);
  const manifest = buildWorkspaceManifest({ branchName: input.branchName, repositories: input.repositories });

  for (const repo of manifest.repositories) {
    const urls = buildVcsUrls({ ...this.config, repoPath: repo.repoPath }, token);
    await sandbox.runCommand("git", [
      "clone",
      "--branch",
      repo.branchName,
      urls.authUrl,
      repo.localPath,
    ]);
    await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", urls.cloneUrl]);
    await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.name", this.config.commitAuthor]);
    await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.email", this.config.commitEmail]);
    const sha = await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
    repo.preAgentSha = (await sha.stdout()).trim();
  }

  await sandbox.writeFiles([{ path: WORKSPACE_MANIFEST_PATH, content: Buffer.from(JSON.stringify(manifest, null, 2)) }]);
  await agent.install(sandbox);
  await agent.configure(sandbox, configureOpts);
  return sandbox;
}
```

Use `urls.authUrl` only during clone. Strip credentials immediately after clone.

If Vercel Sandbox cannot create without a git source, use the first selected repo as the bootstrap source, then clone all selected repos into `repos/`. Do not expose that bootstrap checkout in prompts; the manifest paths are authoritative.

**Step 4: Add workflow step wrapper**

Change `provisionSandbox(...)` in `apps/worker/src/workflows/agent.ts` to accept selected repositories and call `provisionMultiRepo(...)`.

**Step 5: Run tests to verify they pass**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/manager.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/worker/src/sandbox/manager.ts apps/worker/src/sandbox/manager.test.ts apps/worker/src/workflows/agent.ts
git commit -m "feat: provision multi-repo sandboxes"
```

---

### Task 7: Multi-Repo Commit Guards

**Files:**
- Create: `apps/worker/src/sandbox/agents/commit-guard.ts`
- Test: `apps/worker/src/sandbox/agents/commit-guard.test.ts`
- Modify: `apps/worker/src/sandbox/agents/claude.ts:58-80`
- Modify: `apps/worker/src/sandbox/agents/codex.ts:220-260`

**Step 1: Write failing tests**

Create `apps/worker/src/sandbox/agents/commit-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCommitGuardCheckScript } from "./commit-guard.js";

describe("buildCommitGuardCheckScript", () => {
  it("checks every repo in the workspace manifest", () => {
    const script = buildCommitGuardCheckScript({
      manifestPath: "/vercel/sandbox/aiw-repos.json",
      ignoredDirs: [".claude"],
    });

    expect(script).toContain("/vercel/sandbox/aiw-repos.json");
    expect(script).toContain("git -C");
    expect(script).toContain("repositories");
  });

  it("falls back to current repository when no manifest exists", () => {
    const script = buildCommitGuardCheckScript({
      manifestPath: "/missing.json",
      ignoredDirs: [".codex"],
    });

    expect(script).toContain("git status --porcelain");
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/agents/commit-guard.test.ts
```

Expected: FAIL because helper does not exist.

**Step 3: Implement helper**

Create `apps/worker/src/sandbox/agents/commit-guard.ts`:

```ts
export function buildCommitGuardCheckScript(opts: {
  manifestPath: string;
  ignoredDirs: string[];
}): string {
  const ignoredPattern = opts.ignoredDirs.map((dir) => `^.. \\\\${dir}/|^\\\\?\\\\? \\\\${dir}/`).join("|");
  return [
    "input=$(cat)",
    `if echo "$input" | grep -q -E '"stop_hook_active":true|"already_blocked":true'; then exit 0; fi`,
    `if [ -f ${opts.manifestPath} ]; then`,
    "  changes=$(node - <<'NODE'",
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const manifest = JSON.parse(fs.readFileSync('${opts.manifestPath}', 'utf8'));`,
    "const changed = [];",
    "for (const repo of manifest.repositories || []) {",
    "  const out = cp.execFileSync('git', ['-C', repo.localPath, 'status', '--porcelain'], { encoding: 'utf8' });",
    "  if (out.trim()) changed.push(`${repo.repoPath}\\n${out.trim()}`);",
    "}",
    "process.stdout.write(changed.join('\\n'));",
    "NODE",
    "  )",
    "else",
    `  changes=$(git status --porcelain | grep -v -E '${ignoredPattern}' || true)`,
    "fi",
  ].join("\n");
}
```

Adjust shell quoting carefully. Keep tests focused on generated content; final verification catches runtime syntax.

**Step 4: Wire Claude and Codex**

Replace inline status checks in `claude.ts` and `codex.ts` with `buildCommitGuardCheckScript(...)`, preserving each agent's output protocol.

**Step 5: Run tests**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/agents/commit-guard.test.ts src/sandbox/agents/claude.test.ts src/sandbox/agents/codex.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/worker/src/sandbox/agents/commit-guard.ts apps/worker/src/sandbox/agents/commit-guard.test.ts apps/worker/src/sandbox/agents/claude.ts apps/worker/src/sandbox/agents/codex.ts
git commit -m "feat: check commits across workspace repositories"
```

---

### Task 8: Multi-Repo Push And PR/MR Creation

**Files:**
- Modify: `apps/worker/src/sandbox/poll-agent.ts:1-127`
- Modify: `apps/worker/src/sandbox/poll-agent.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts:360-460`

**Step 1: Write failing push tests**

Extend `apps/worker/src/sandbox/poll-agent.test.ts` with tests for a new function:

```ts
import { pushWorkspaceFromSandbox } from "./poll-agent.js";

describe("pushWorkspaceFromSandbox", () => {
  it("returns no-commit error when no manifest repo changed", async () => {
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "cat") {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue(JSON.stringify({
          version: 1,
          repositories: [
            {
              provider: "github",
              repoPath: "test-owner/api",
              localPath: "/vercel/sandbox/repos/api",
              defaultBranch: "main",
              branchName: "blazebot/task-1",
              preAgentSha: "abc123",
              selectedRationale: "api",
            },
          ],
        })) };
      }
      if (args?.includes("rev-parse")) {
        return { exitCode: 0, stdout: vi.fn().mockResolvedValue("abc123") };
      }
      return { exitCode: 0, stdout: vi.fn().mockResolvedValue(""), stderr: vi.fn().mockResolvedValue("") };
    });

    const result = await pushWorkspaceFromSandbox("sbx-test-123");
    expect(result.pushed).toBe(false);
    expect(result.error).toContain("made no commits");
  });

  it("pushes only changed manifest repos", async () => {
    // Manifest has api and web. api HEAD changed, web did not.
    // Assert git push runs once with -C /vercel/sandbox/repos/api.
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/poll-agent.test.ts
```

Expected: FAIL because `pushWorkspaceFromSandbox` does not exist.

**Step 3: Implement workspace push**

In `apps/worker/src/sandbox/poll-agent.ts`, add:

```ts
export interface WorkspacePushRepoResult {
  repoPath: string;
  branchName: string;
  pushed: boolean;
  changed: boolean;
  error?: string;
}

export interface WorkspacePushResult {
  pushed: boolean;
  repositories: WorkspacePushRepoResult[];
  error?: string;
}

export async function pushWorkspaceFromSandbox(sandboxId: string): Promise<WorkspacePushResult> {
  "use step";
  // Read WORKSPACE_MANIFEST_PATH with cat.
  // For each repo:
  //   git -C localPath rev-parse HEAD
  //   compare with preAgentSha
  //   skip unchanged repos
  //   set remote auth URL from provider config + repoPath
  //   unshallow if needed
  //   git -C localPath push --force origin HEAD:refs/heads/<branchName>
  // If no changed repos, return pushed:false with "Agent reported success but made no commits".
  // If any changed repo fails, return pushed:false with the first error and all repo results.
}
```

Keep existing `pushFromSandbox` as the single-repo compatibility wrapper until the workflow no longer imports it.

**Step 4: Add PR/MR helper step**

In `apps/worker/src/workflows/agent.ts`, add a step:

```ts
async function createOrUseWorkflowOwnedPullRequestsForRepos(input: {
  ticketKey: string;
  repositories: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    defaultBranch: string;
    branchName: string;
    workflowOwnedPr?: { id: number; url: string; branch: string };
  }>;
  title: string;
}): Promise<Array<{ repoPath: string; id: number; url: string; branch: string }>> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { getDb } = await import("../db/client.js");
  const { upsertWorkflowOwnedPr } = await import("../db/queries/workflow-owned-prs.js");
  const { createVCSForRepository } = await import("../lib/create-vcs.js");
  const vcsConfig = getVcsConfig();
  const prs = [];
  for (const repo of input.repositories) {
    const vcs = createVCSForRepository(vcsConfig, {
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    const existing = repo.workflowOwnedPr;
    const pr = existing ?? await vcs.createPR(repo.branchName, input.title, "");
    if (!existing) {
      await upsertWorkflowOwnedPr(getDb(), {
        ticketKey: input.ticketKey,
        provider: repo.provider,
        repoPath: repo.repoPath,
        prId: pr.id,
        url: pr.url,
        branchName: pr.branch,
      });
    }
    prs.push(pr);
  }
  return prs.map((pr, index) => ({ repoPath: input.repositories[index].repoPath, id: pr.id, url: pr.url, branch: pr.branch }));
}
```

Only call this for repos that were pushed/changed.
Do not call `findPR(repo.branchName)` here; a branch-name match is not a
Workflow-Owned PR/MR unless it has an ownership record.

**Step 5: Run tests**

Run:

```bash
CI=true pnpm --filter worker test -- src/sandbox/poll-agent.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/worker/src/sandbox/poll-agent.ts apps/worker/src/sandbox/poll-agent.test.ts apps/worker/src/workflows/agent.ts
git commit -m "feat: push changed workspace repositories"
```

---

### Task 9: Wire Agent Workflow To Selected Repos

**Files:**
- Modify: `apps/worker/src/workflows/agent.ts:630-1010`
- Modify: `apps/worker/src/sandbox/context.ts`
- Test: add focused tests where practical, otherwise keep coverage through lower-level tests and typecheck.

**Step 1: Add selected repo guard in workflow**

After `runPreSandboxPhaseStep`, before Arthur task creation, require selected repos:

```ts
const selectedRepositories = preSandboxResult.selectedRepositories ?? [];
if (selectedRepositories.length === 0) {
  await unregisterRun(ticket.identifier);
  const commentUrl = await postClarificationAndMoveBack(
    ticketId,
    ["Which repository should this ticket modify?"],
    env.COLUMN_BACKLOG,
  );
  await notifyTicket(ticket.identifier, {
    kind: "needs_clarification",
    commentUrl: commentUrl ?? undefined,
    usageReport: usageReportOrUndefined(),
  });
  runOutcome = "success";
  return;
}
```

This should be unreachable when `repo-selection` is configured, but it prevents silent single-repo fallback.

**Step 2: Replace single PR context with selected repo contexts**

Do not use the old `fetchPRContext(branchName)` as the source of truth for multi-repo. Repo selection already loaded Workflow-Owned PR/MR records. Use selected repo `workflowOwnedPr` entries for reruns and prompt context.

**Step 3: Create/reset branches per selected repo**

Add a step:

```ts
async function prepareSelectedRepositoryBranches(
  branchName: string,
  repositories: SelectedRepository[],
): Promise<void> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { createVCSForRepository } = await import("../lib/create-vcs.js");
  const config = getVcsConfig();
  for (const repo of repositories) {
    if (repo.workflowOwnedPr) continue;
    await createVCSForRepository(config, {
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    }).createBranch(branchName, repo.defaultBranch);
  }
}
```

**Step 4: Provision sandbox with selected repos**

Change the `provisionSandbox` wrapper to accept selected repositories and call `manager.provisionMultiRepo(...)`.

**Step 5: Add selected repos to prompts**

In `apps/worker/src/sandbox/context.ts`, add an optional selected repositories section in research, implementation, and review contexts:

```md
## Selected Repositories

- `acme/api` at `/vercel/sandbox/repos/acme__api` - ticket mentions billing API
- `acme/web` at `/vercel/sandbox/repos/acme__web` - Workflow-Owned PR/MR for this ticket
```

The prompt should instruct the agent to edit only these workspace repos.

**Step 6: Replace post-phase push and PR flow**

In `agentWorkflow`, replace:

```ts
let pushResult = await pushFromSandbox(sandboxId, branchName);
...
const pr = isNewPr ? await createPullRequest(...) : await findPRForBranch(...);
```

with:

```ts
let pushResult = await pushWorkspaceFromSandbox(sandboxId);
if (!pushResult.pushed && pushResult.error) {
  pushResult = await fixAndRetryWorkspacePush(sandboxId, pushResult.error, agentKind, activeModel);
}
...
const changedRepos = pushResult.repositories.filter((repo) => repo.changed && repo.pushed);
const prs = await createOrUseWorkflowOwnedPullRequestsForRepos({
  ticketKey: ticket.identifier,
  repositories: selectedRepositories.filter((repo) =>
    changedRepos.some((changed) => changed.repoPath === repo.repoPath),
  ),
  title: ticket.title,
});
```

If `fixAndRetryWorkspacePush` is too large for this task, keep one retry function that calls the existing fix agent but updates its prompt to say "fix push failures across workspace repositories", then reruns `pushWorkspaceFromSandbox`.

**Step 7: Jira comment with all links**

Replace `postPrLinkComment(ticketId, pr.url, pr.id)` with:

```ts
async function postPrLinksComment(ticketId: string, prs: Array<{ repoPath: string; url: string; id: number }>): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const lines = prs.map((pr) => `- ${pr.repoPath}: #${pr.id} ${pr.url}`);
  await issueTracker.postComment(ticketId, `Pull requests ready for review:\n${lines.join("\n")}`);
}
```

Post once when at least one new PR/MR was created. For reruns where all PRs/MRs already exist, skip duplicate comments.

**Step 8: Telemetry and notifications**

Keep `prForTelemetry` as the first PR/MR for backward compatibility. Include all PR/MR links in the Jira comment. Do not change dashboard/shared contracts in this task unless tests force it.

**Step 9: Run focused tests and typecheck**

Run:

```bash
CI=true pnpm --filter worker test -- src/pre-sandbox/runner.test.ts src/sandbox/manager.test.ts src/sandbox/poll-agent.test.ts src/sandbox/context.test.ts
CI=true pnpm --filter worker typecheck
```

Expected: PASS.

**Step 10: Commit**

```bash
git add apps/worker/src/workflows/agent.ts apps/worker/src/sandbox/context.ts
git commit -m "feat: wire agent workflow to selected repositories"
```

---

### Task 10: Enable Repo Selection In Config And Docs

**Files:**
- Modify: `apps/worker/pre-sandbox.yaml`
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `docs/GITLAB-SETUP.md`

**Step 1: Add repo-selection to config**

Modify `apps/worker/pre-sandbox.yaml`:

```yaml
preSandbox:
  runOn:
    newTicket: true
    existingPr: true
    mergeConflict: true
  steps:
    - uses: repo-selection
      name: Select repositories
      timeoutMs: 30000
      onFailure: fail
```

**Step 2: Run config validation**

Run:

```bash
CI=true pnpm --filter worker validate:pre-sandbox
```

Expected: PASS.

**Step 3: Update README workflow description**

Update `README.md` to state:

- The workflow lists accessible provider repositories.
- A pre-sandbox repo-selection step chooses selected repos.
- Sandbox clones selected repos into a workspace manifest.
- Push/PR creation happens once per changed repo.

Keep the docs short; do not rewrite unrelated sections.

**Step 4: Update setup docs**

Update setup docs only where single-repo language is wrong:

- GitHub App install can use "Only select repositories"; AIW-45 lists the installed repositories.
- GitLab token must be able to list projects and push to selected projects.
- `GITLAB_PROJECT_ID` / `GITHUB_OWNER` + `GITHUB_REPO` remain backward-compatible default/smoke settings if still used by post-PR gate or single-repo paths, but the agent workflow uses provider-visible repos.

**Step 5: Commit**

```bash
git add apps/worker/pre-sandbox.yaml README.md SETUP.md docs/GITLAB-SETUP.md
git commit -m "docs: document multi-repo selection"
```

---

### Task 11: Final Verification

**Files:**
- No planned edits unless verification reveals issues.

**Step 1: Run targeted tests**

Run:

```bash
CI=true pnpm --filter worker test -- src/lib/create-vcs.test.ts src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.test.ts src/db/queries/workflow-owned-prs.test.ts src/pre-sandbox/steps/repo-selection.test.ts src/pre-sandbox/runner.test.ts src/pre-sandbox/config.test.ts src/sandbox/repo-workspace.test.ts src/sandbox/manager.test.ts src/sandbox/agents/commit-guard.test.ts src/sandbox/poll-agent.test.ts src/sandbox/context.test.ts
```

Expected: PASS.

**Step 2: Run worker typecheck**

Run:

```bash
CI=true pnpm --filter worker typecheck
```

Expected: PASS.

**Step 3: Run worker unit suite**

Run:

```bash
CI=true pnpm --filter worker test
```

Expected: PASS.

If pnpm writes `allowBuilds` placeholders to `pnpm-workspace.yaml`, remove them before committing.

**Step 4: Inspect git status**

Run:

```bash
git status --short --branch
```

Expected: branch ahead of `origin/dev`, no unstaged changes.

**Step 5: Summarize implementation**

Summarize:

- Provider repo discovery.
- Pre-sandbox repo selection.
- Workspace manifest and sandbox provisioning.
- Multi-repo commit guard and push.
- One Jira comment with all PR/MR links.
- Tests run and any environment blockers.
