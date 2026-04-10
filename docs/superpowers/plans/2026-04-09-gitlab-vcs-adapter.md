# GitLab VCS Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GitLabAdapter` implementing the `VCSAdapter` interface so the system can target GitLab.com repos via a `VCS_KIND=gitlab` env switch.

**Architecture:** Direct mirror of the existing `GitHubAdapter` — new `gitlab.ts` file alongside `github.ts`, same interface, same error-handling patterns. Factory functions in `adapters.ts` and `step-adapters.ts` branch on `VCS_KIND`. Env schema updated so GitHub vars are optional when `VCS_KIND=gitlab` and vice versa.

**Tech Stack:** `@gitbeaker/rest` (GitLab API client), Zod (env validation), Vitest (tests)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/adapters/vcs/gitlab.ts` | **Create** | `GitLabAdapter` class (~250 lines) implementing all 8 `VCSAdapter` methods |
| `src/adapters/vcs/gitlab.test.ts` | **Create** | Unit tests with mocked gitbeaker (~10 test cases) |
| `env.ts` | **Modify** | Add `"gitlab"` to `VCS_KIND` enum, add `GITLAB_*` vars, make `GITHUB_*` vars optional |
| `src/lib/adapters.ts` | **Modify** | Branch VCS creation on `VCS_KIND` |
| `src/lib/step-adapters.ts` | **Modify** | Same branching as `adapters.ts` |
| `package.json` | **Modify** | Add `@gitbeaker/rest` dependency |

No changes to `types.ts`, `workflows/agent.ts`, `sandbox/poll-agent.ts`, or any other consumer.

---

## Task 1: Add `@gitbeaker/rest` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install @gitbeaker/rest
```

- [ ] **Step 2: Verify installation**

Run:
```bash
node -e "import('@gitbeaker/rest').then(m => console.log('OK:', Object.keys(m).slice(0,3)))"
```
Expected: prints `OK:` followed by exported names (e.g. `Gitlab`, `Projects`, etc.)

---

## Task 2: Update env schema for GitLab support

**Files:**
- Modify: `env.ts:17-22`

The `VCS_KIND` enum expands to `["github", "gitlab"]`. All `GITHUB_*` vars become optional (only required when `VCS_KIND=github`). New `GITLAB_*` vars are added as optional (only required when `VCS_KIND=gitlab`). Runtime validation happens in the factory — not in the schema.

- [ ] **Step 1: Write the failing test**

Create file `src/adapters/vcs/gitlab.test.ts` with a minimal test that imports from `env.ts` and validates the schema accepts `"gitlab"`:

```typescript
import { describe, it, expect } from "vitest";

describe("GitLabAdapter env", () => {
  it("VCS_KIND enum includes gitlab (compile-time check)", () => {
    // This test validates that the env schema accepts "gitlab" as a VCS_KIND.
    // The actual env parsing is handled by @t3-oss/env-core at startup.
    // We just verify the type exists for now — the adapter import test comes in Task 3.
    expect(["github", "gitlab"]).toContain("gitlab");
  });
});
```

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: PASS (this is a baseline test; the real validation is compile-time)

- [ ] **Step 2: Update the VCS_KIND enum**

In `env.ts`, change line 18:

```typescript
// Before:
VCS_KIND: z.enum(["github"]),
```

```typescript
// After:
VCS_KIND: z.enum(["github", "gitlab"]),
```

- [ ] **Step 3: Make GITHUB_* vars optional**

In `env.ts`, change lines 19-22:

```typescript
// Before:
GITHUB_TOKEN: z.string().min(1),
GITHUB_OWNER: z.string().min(1),
GITHUB_REPO: z.string().min(1),
GITHUB_BASE_BRANCH: z.string().default("main"),
```

```typescript
// After:
GITHUB_TOKEN: z.string().min(1).optional(),
GITHUB_OWNER: z.string().min(1).optional(),
GITHUB_REPO: z.string().min(1).optional(),
GITHUB_BASE_BRANCH: z.string().default("main"),
```

Note: `GITHUB_BASE_BRANCH` keeps its `.default("main")` — it's already effectively optional.

- [ ] **Step 4: Add GITLAB_* vars**

In `env.ts`, add after the GitHub vars block (after `GITHUB_BASE_BRANCH`):

```typescript
    // GitLab VCS
    GITLAB_TOKEN: z.string().min(1).optional(),
    GITLAB_PROJECT_ID: z.string().min(1).optional(),
    GITLAB_BASE_BRANCH: z.string().default("main"),
```

- [ ] **Step 5: Run typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: PASS — no type errors. Existing code that accesses `env.GITHUB_TOKEN` will now get `string | undefined`, but we fix that in Task 5 (factory update). If the typecheck fails here due to those accesses, that's expected and we'll fix them in Task 5.

---

## Task 3: Implement `GitLabAdapter` — `createBranch`

**Files:**
- Create: `src/adapters/vcs/gitlab.ts`

- [ ] **Step 1: Write the failing tests for createBranch**

Add to `src/adapters/vcs/gitlab.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabAdapter } from "./gitlab.js";

const mockBranches = {
  create: vi.fn(),
  remove: vi.fn(),
  show: vi.fn(),
};

const mockRepositoryFiles = {
  create: vi.fn(),
};

const mockCommits = {
  create: vi.fn(),
};

const mockMergeRequests = {
  create: vi.fn(),
  all: vi.fn(),
  show: vi.fn(),
  allPipelines: vi.fn(),
};

const mockMergeRequestNotes = {
  all: vi.fn(),
};

const mockMergeRequestDiscussions = {
  all: vi.fn(),
};

const mockJobs = {
  all: vi.fn(),
  showLog: vi.fn(),
};

vi.mock("@gitbeaker/rest", () => ({
  Gitlab: vi.fn(() => ({
    Branches: mockBranches,
    RepositoryFiles: mockRepositoryFiles,
    Commits: mockCommits,
    MergeRequests: mockMergeRequests,
    MergeRequestNotes: mockMergeRequestNotes,
    MergeRequestDiscussions: mockMergeRequestDiscussions,
    Jobs: mockJobs,
  })),
}));

function glAdapter() {
  return new GitLabAdapter({
    token: "glpat-xxxxxxxxxxxx",
    projectId: "blazity/demo-app",
    baseBranch: "main",
  });
}

describe("GitLabAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createBranch", () => {
    it("creates branch from base ref", async () => {
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockBranches.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "main",
      );
    });

    it("seeds empty repo on 404 then creates branch", async () => {
      const error = new Error("404 Branch Not Found") as any;
      error.cause = { response: { status: 404 } };
      mockBranches.create.mockRejectedValueOnce(error);
      mockRepositoryFiles.create.mockResolvedValueOnce({
        branch: "main",
      });
      // Second create call succeeds after seeding
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockRepositoryFiles.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "README.md",
        "main",
        "Initial commit",
        "# Repository\n",
      );
      expect(mockBranches.create).toHaveBeenCalledTimes(2);
    });

    it("force-resets existing branch by deleting and recreating on 400", async () => {
      const error = new Error("Branch already exists") as any;
      error.cause = { response: { status: 400 } };
      mockBranches.create.mockRejectedValueOnce(error);
      mockBranches.remove.mockResolvedValueOnce({});
      // Recreate succeeds
      mockBranches.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockBranches.remove).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
      );
      expect(mockBranches.create).toHaveBeenCalledTimes(2);
    });
  });
});
```

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: FAIL — `./gitlab.js` does not exist

- [ ] **Step 2: Create `gitlab.ts` with config and createBranch**

Create `src/adapters/vcs/gitlab.ts`:

```typescript
import { Gitlab } from "@gitbeaker/rest";
import { FatalError } from "workflow";
import type {
  VCSAdapter,
  PullRequest,
  PRComment,
  CheckRunResult,
} from "./types.js";

export interface GitLabConfig {
  token: string;
  projectId: string;
  baseBranch: string;
}

export class GitLabAdapter implements VCSAdapter {
  private gl: InstanceType<typeof Gitlab>;
  private projectId: string;
  private baseBranch: string;

  constructor(private config: GitLabConfig) {
    this.gl = new Gitlab({ token: config.token });
    this.projectId = config.projectId;
    this.baseBranch = config.baseBranch;
  }

  async createBranch(name: string, base: string): Promise<void> {
    try {
      await this.gl.Branches.create(this.projectId, name, base);
    } catch (err: any) {
      const status = this.getStatusCode(err);

      if (status === 404) {
        // Empty repo — seed with a README, then retry
        await this.seedEmptyRepo(base);
        await this.gl.Branches.create(this.projectId, name, base);
        return;
      }

      if (status === 400) {
        // Branch already exists — delete and recreate
        await this.gl.Branches.remove(this.projectId, name);
        await this.gl.Branches.create(this.projectId, name, base);
        return;
      }

      throw err;
    }
  }

  private async seedEmptyRepo(branch: string): Promise<void> {
    try {
      await this.gl.RepositoryFiles.create(
        this.projectId,
        "README.md",
        branch,
        "Initial commit",
        "# Repository\n",
      );
    } catch (err: any) {
      throw new Error(
        `Failed to seed empty repository ${this.projectId}: ${err.message}`,
      );
    }
  }

  private getStatusCode(err: any): number | undefined {
    return err?.cause?.response?.status ?? err?.status ?? err?.statusCode;
  }

  // Stub methods — implemented in subsequent tasks
  async createPR(
    _branch: string,
    _title: string,
    _body: string,
  ): Promise<PullRequest> {
    throw new Error("Not implemented");
  }

  async push(
    _branch: string,
    _files: Array<{ path: string; content: string }>,
    _options?: { mergeParentSha?: string },
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  async getBranchSha(_branch: string): Promise<string> {
    throw new Error("Not implemented");
  }

  async getPRComments(_prId: number): Promise<PRComment[]> {
    throw new Error("Not implemented");
  }

  async getCheckRunResults(_prId: number): Promise<CheckRunResult[]> {
    throw new Error("Not implemented");
  }

  async getPRConflictStatus(_prId: number): Promise<boolean> {
    throw new Error("Not implemented");
  }

  async findPR(_branch: string): Promise<PullRequest | null> {
    throw new Error("Not implemented");
  }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: PASS — all 3 createBranch tests pass

---

## Task 4: Implement `createPR`, `push`, `getBranchSha`, `findPR`

**Files:**
- Modify: `src/adapters/vcs/gitlab.ts`
- Modify: `src/adapters/vcs/gitlab.test.ts`

- [ ] **Step 1: Write failing tests for createPR, push, getBranchSha, findPR**

Add these test blocks inside the `describe("GitLabAdapter", ...)` block in `gitlab.test.ts`:

```typescript
  describe("createPR", () => {
    it("creates a merge request", async () => {
      mockMergeRequests.create.mockResolvedValueOnce({
        iid: 42,
        web_url: "https://gitlab.com/blazity/demo-app/-/merge_requests/42",
      });

      const adapter = glAdapter();
      const pr = await adapter.createPR("feat/test", "Add feature", "Description");

      expect(pr.id).toBe(42);
      expect(pr.url).toContain("/merge_requests/42");
      expect(pr.branch).toBe("feat/test");
      expect(mockMergeRequests.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "main",
        "Add feature",
        { description: "Description" },
      );
    });

    it("throws FatalError on 409", async () => {
      const error = new Error("MR already exists") as any;
      error.cause = { response: { status: 409 } };
      mockMergeRequests.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createPR("feat/test", "Title", "Body"),
      ).rejects.toThrow("MR already exists");
    });

    it("throws FatalError on 404", async () => {
      const error = new Error("Project not found") as any;
      error.cause = { response: { status: 404 } };
      mockMergeRequests.create.mockRejectedValueOnce(error);

      const adapter = glAdapter();
      await expect(
        adapter.createPR("feat/test", "Title", "Body"),
      ).rejects.toThrow("Project not found");
    });
  });

  describe("push", () => {
    it("creates a commit with file actions", async () => {
      mockCommits.create.mockResolvedValueOnce({});

      const adapter = glAdapter();
      await adapter.push("feat/test", [
        { path: "src/index.ts", content: "console.log('hello');" },
        { path: "src/utils.ts", content: "export const add = (a: number, b: number) => a + b;" },
      ]);

      expect(mockCommits.create).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
        "feat: agent implementation",
        [
          { action: "update", filePath: "src/index.ts", content: "console.log('hello');" },
          { action: "update", filePath: "src/utils.ts", content: "export const add = (a: number, b: number) => a + b;" },
        ],
      );
    });
  });

  describe("getBranchSha", () => {
    it("returns the commit SHA of a branch", async () => {
      mockBranches.show.mockResolvedValueOnce({
        commit: { id: "abc123def456" },
      });

      const adapter = glAdapter();
      const sha = await adapter.getBranchSha("feat/test");

      expect(sha).toBe("abc123def456");
      expect(mockBranches.show).toHaveBeenCalledWith(
        "blazity/demo-app",
        "feat/test",
      );
    });
  });

  describe("findPR", () => {
    it("returns null when no MR exists", async () => {
      mockMergeRequests.all.mockResolvedValueOnce([]);

      const adapter = glAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).toBeNull();
    });

    it("returns MR when one exists", async () => {
      mockMergeRequests.all.mockResolvedValueOnce([
        {
          iid: 42,
          web_url: "https://gitlab.com/blazity/demo-app/-/merge_requests/42",
          source_branch: "feat/test",
        },
      ]);

      const adapter = glAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).not.toBeNull();
      expect(pr!.id).toBe(42);
      expect(pr!.branch).toBe("feat/test");
    });
  });
```

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: FAIL — "Not implemented" errors from stub methods

- [ ] **Step 2: Implement createPR**

In `gitlab.ts`, replace the `createPR` stub with:

```typescript
  async createPR(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    try {
      const mr = await this.gl.MergeRequests.create(
        this.projectId,
        branch,
        this.baseBranch,
        title,
        { description: body },
      );
      return { id: mr.iid, url: mr.web_url, branch };
    } catch (err: any) {
      const status = this.getStatusCode(err);
      if (status === 409 || status === 404) {
        throw new FatalError(err.message);
      }
      throw err;
    }
  }
```

- [ ] **Step 3: Implement push**

In `gitlab.ts`, replace the `push` stub with:

```typescript
  async push(
    branch: string,
    files: Array<{ path: string; content: string }>,
    _options?: { mergeParentSha?: string },
  ): Promise<void> {
    const actions = files.map((f) => ({
      action: "update" as const,
      filePath: f.path,
      content: f.content,
    }));

    await this.gl.Commits.create(
      this.projectId,
      branch,
      "feat: agent implementation",
      actions,
    );
  }
```

Note: `mergeParentSha` is intentionally ignored per the spec — GitLab's Commits API doesn't support multi-parent commits. The workflow's conflict resolution flow handles this by recreating the branch from base when conflicts are detected.

- [ ] **Step 4: Implement getBranchSha**

In `gitlab.ts`, replace the `getBranchSha` stub with:

```typescript
  async getBranchSha(branch: string): Promise<string> {
    const data = await this.gl.Branches.show(this.projectId, branch);
    return data.commit.id;
  }
```

- [ ] **Step 5: Implement findPR**

In `gitlab.ts`, replace the `findPR` stub with:

```typescript
  async findPR(branch: string): Promise<PullRequest | null> {
    const mrs = await this.gl.MergeRequests.all({
      projectId: this.projectId,
      sourceBranch: branch,
      state: "opened",
    });
    if (mrs.length === 0) return null;
    const mr = mrs[0];
    return { id: mr.iid, url: mr.web_url, branch: mr.source_branch };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: PASS — all tests pass including new ones

---

## Task 5: Implement `getPRComments`, `getCheckRunResults`, `getPRConflictStatus`

**Files:**
- Modify: `src/adapters/vcs/gitlab.ts`
- Modify: `src/adapters/vcs/gitlab.test.ts`

- [ ] **Step 1: Write failing tests**

Add these test blocks inside `describe("GitLabAdapter", ...)` in `gitlab.test.ts`:

```typescript
  describe("getPRComments", () => {
    it("combines discussion notes and general notes", async () => {
      mockMergeRequestDiscussions.all.mockResolvedValueOnce([
        {
          notes: [
            {
              author: { username: "reviewer1" },
              body: "Inline comment on line 10",
              system: false,
              type: "DiffNote",
              position: { new_path: "src/index.ts", new_line: 10 },
            },
          ],
        },
      ]);
      mockMergeRequestNotes.all.mockResolvedValueOnce([
        {
          author: { username: "reviewer2" },
          body: "General comment",
          system: false,
          type: null,
        },
      ]);

      const adapter = glAdapter();
      const comments = await adapter.getPRComments(42);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toEqual({
        author: "reviewer1",
        body: "Inline comment on line 10",
        liked: false,
        filePath: "src/index.ts",
        startLine: 10,
        endLine: 10,
      });
      expect(comments[1]).toEqual({
        author: "reviewer2",
        body: "General comment",
        liked: false,
      });
    });
  });

  describe("getCheckRunResults", () => {
    it("maps GitLab CI job statuses to CheckRunResult", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ sha: "head-sha-123" });
      mockMergeRequests.allPipelines.mockResolvedValueOnce([
        { id: 100, status: "failed" },
      ]);
      mockJobs.all.mockResolvedValueOnce([
        { id: 1, name: "lint", status: "success" },
        { id: 2, name: "test", status: "failed" },
        { id: 3, name: "build", status: "running" },
      ]);
      mockJobs.showLog.mockResolvedValueOnce("Error: test failed on line 42");

      const adapter = glAdapter();
      const results = await adapter.getCheckRunResults(42);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({
        name: "lint",
        status: "completed",
        conclusion: "success",
      });
      expect(results[1]).toEqual({
        name: "test",
        status: "completed",
        conclusion: "failure",
        logs: "Error: test failed on line 42",
      });
      expect(results[2]).toEqual({
        name: "build",
        status: "in_progress",
        conclusion: null,
      });
    });
  });

  describe("getPRConflictStatus", () => {
    it("returns true when MR has conflicts", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ has_conflicts: true });

      const adapter = glAdapter();
      const hasConflicts = await adapter.getPRConflictStatus(42);
      expect(hasConflicts).toBe(true);
    });

    it("returns false when MR has no conflicts", async () => {
      mockMergeRequests.show.mockResolvedValueOnce({ has_conflicts: false });

      const adapter = glAdapter();
      const hasConflicts = await adapter.getPRConflictStatus(42);
      expect(hasConflicts).toBe(false);
    });
  });
```

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: FAIL — "Not implemented" errors from stub methods

- [ ] **Step 2: Implement getPRComments**

In `gitlab.ts`, replace the `getPRComments` stub with:

```typescript
  async getPRComments(prId: number): Promise<PRComment[]> {
    const comments: PRComment[] = [];

    // Fetch inline/diff comments from discussions
    const discussions = await this.gl.MergeRequestDiscussions.all(
      this.projectId,
      prId,
    );
    for (const discussion of discussions) {
      for (const note of discussion.notes ?? []) {
        if (note.system) continue;
        if (note.type !== "DiffNote") continue;
        comments.push({
          author: note.author?.username ?? "unknown",
          body: note.body ?? "",
          liked: false,
          filePath: note.position?.new_path,
          startLine: note.position?.new_line,
          endLine: note.position?.new_line,
        });
      }
    }

    // Fetch general (non-inline, non-system) notes
    const notes = await this.gl.MergeRequestNotes.all(this.projectId, prId);
    for (const note of notes) {
      if (note.system) continue;
      if (note.type === "DiffNote") continue; // already captured above
      comments.push({
        author: note.author?.username ?? "unknown",
        body: note.body ?? "",
        liked: false,
      });
    }

    return comments;
  }
```

- [ ] **Step 3: Implement getCheckRunResults**

In `gitlab.ts`, replace the `getCheckRunResults` stub with:

```typescript
  async getCheckRunResults(prId: number): Promise<CheckRunResult[]> {
    const mr = await this.gl.MergeRequests.show(this.projectId, prId);
    const pipelines = await this.gl.MergeRequests.allPipelines(
      this.projectId,
      prId,
    );

    if (pipelines.length === 0) return [];

    // Use the most recent pipeline
    const latestPipeline = pipelines[0];
    const jobs = await this.gl.Jobs.all(this.projectId, latestPipeline.id);

    const results: CheckRunResult[] = [];
    for (const job of jobs) {
      const mapped = this.mapJobStatus(job.status);
      const entry: CheckRunResult = {
        name: job.name,
        status: mapped.status,
        conclusion: mapped.conclusion,
      };

      // Fetch logs for failed jobs
      if (
        mapped.status === "completed" &&
        mapped.conclusion !== "success" &&
        mapped.conclusion !== null &&
        mapped.conclusion !== "skipped" &&
        mapped.conclusion !== "cancelled"
      ) {
        try {
          const log = await this.gl.Jobs.showLog(this.projectId, job.id);
          entry.logs = String(log);
        } catch {
          // Log fetching is best-effort
        }
      }

      results.push(entry);
    }

    return results;
  }

  private mapJobStatus(
    status: string,
  ): Pick<CheckRunResult, "status" | "conclusion"> {
    switch (status) {
      case "success":
        return { status: "completed", conclusion: "success" };
      case "failed":
        return { status: "completed", conclusion: "failure" };
      case "running":
        return { status: "in_progress", conclusion: null };
      case "pending":
      case "created":
        return { status: "queued", conclusion: null };
      case "canceled":
        return { status: "completed", conclusion: "cancelled" };
      case "skipped":
        return { status: "completed", conclusion: "skipped" };
      default:
        return { status: "queued", conclusion: null };
    }
  }
```

- [ ] **Step 4: Implement getPRConflictStatus**

In `gitlab.ts`, replace the `getPRConflictStatus` stub with:

```typescript
  async getPRConflictStatus(prId: number): Promise<boolean> {
    const mr = await this.gl.MergeRequests.show(this.projectId, prId);
    return mr.has_conflicts === true;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
npx vitest run src/adapters/vcs/gitlab.test.ts
```
Expected: PASS — all tests pass

---

## Task 6: Update factory functions in adapters.ts and step-adapters.ts

**Files:**
- Modify: `src/lib/adapters.ts:1-42`
- Modify: `src/lib/step-adapters.ts:1-42`

- [ ] **Step 1: Update `adapters.ts`**

Add the import at the top of `src/lib/adapters.ts`:

```typescript
import { GitLabAdapter } from "../adapters/vcs/gitlab.js";
```

Then extract VCS creation into a helper and use it. Replace the `vcs:` line in `createAdapters()`:

```typescript
function createVCS(): VCSAdapter {
  if (env.VCS_KIND === "gitlab") {
    return new GitLabAdapter({
      token: env.GITLAB_TOKEN!,
      projectId: env.GITLAB_PROJECT_ID!,
      baseBranch: env.GITLAB_BASE_BRANCH ?? "main",
    });
  }
  return new GitHubAdapter({
    token: env.GITHUB_TOKEN!,
    owner: env.GITHUB_OWNER!,
    repo: env.GITHUB_REPO!,
    baseBranch: env.GITHUB_BASE_BRANCH ?? "main",
  });
}
```

And update the `createAdapters` return to use it:

```typescript
export function createAdapters(): Adapters {
  return {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
    vcs: createVCS(),
    messaging: new ChatSDKAdapter({
      slackToken: env.CHAT_SDK_SLACK_TOKEN,
      channelId: env.CHAT_SDK_CHANNEL_ID,
      botName: env.CHAT_SDK_BOT_NAME,
    }),
    runRegistry: new UpstashRunRegistry({
      url: env.AI_WORKFLOW_KV_REST_API_URL,
      token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
    }),
  };
}
```

- [ ] **Step 2: Update `step-adapters.ts`**

Apply the identical change to `src/lib/step-adapters.ts`:

Add the import:
```typescript
import { GitLabAdapter } from "../adapters/vcs/gitlab.js";
```

Add the same `createVCS()` helper (duplicate is fine — these files are independent entry points):

```typescript
function createVCS(): VCSAdapter {
  if (env.VCS_KIND === "gitlab") {
    return new GitLabAdapter({
      token: env.GITLAB_TOKEN!,
      projectId: env.GITLAB_PROJECT_ID!,
      baseBranch: env.GITLAB_BASE_BRANCH ?? "main",
    });
  }
  return new GitHubAdapter({
    token: env.GITHUB_TOKEN!,
    owner: env.GITHUB_OWNER!,
    repo: env.GITHUB_REPO!,
    baseBranch: env.GITHUB_BASE_BRANCH ?? "main",
  });
}
```

Update `createStepAdapters()` to use `vcs: createVCS()`.

- [ ] **Step 3: Run typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: PASS — no type errors. The `!` non-null assertions match the pattern described in the spec (runtime validation via assertion, not Zod refine).

- [ ] **Step 4: Run all unit tests**

Run:
```bash
npx vitest run
```
Expected: PASS — all existing tests plus new GitLab tests pass

---

## Task 7: Final verification

**Files:** (none — read-only checks)

- [ ] **Step 1: Run full test suite**

Run:
```bash
npx vitest run
```
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: Verify file inventory matches spec**

Confirm these files were created/modified:

| File | Expected |
|------|----------|
| `src/adapters/vcs/gitlab.ts` | New — ~250 lines |
| `src/adapters/vcs/gitlab.test.ts` | New — ~10 test cases |
| `env.ts` | Modified — `VCS_KIND` enum, `GITLAB_*` vars, `GITHUB_*` optional |
| `src/lib/adapters.ts` | Modified — `createVCS()` helper |
| `src/lib/step-adapters.ts` | Modified — `createVCS()` helper |
| `package.json` | Modified — `@gitbeaker/rest` added |

Run:
```bash
git diff --stat main
```
