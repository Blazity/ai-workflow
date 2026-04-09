# GitLab VCS Adapter Design

**Date:** 2026-04-09
**Approach:** Direct Mirror (Approach A)

## Goal

Add a `GitLabAdapter` that implements the existing `VCSAdapter` interface, supporting all 8 methods currently provided by `GitHubAdapter`. The adapter targets GitLab.com only, uses `@gitbeaker/rest` as the API client, and fetches CI logs from GitLab CI/CD pipelines.

## Decisions

| Question | Decision |
|----------|----------|
| GitLab.com vs self-hosted | GitLab.com only |
| API client | `@gitbeaker/rest` |
| CI log source | GitLab CI pipelines only (no external commit statuses) |
| Architecture | Direct mirror — new file alongside `github.ts`, factory switch on `VCS_KIND` |

## Files Changed

| File | Change |
|------|--------|
| `src/adapters/vcs/gitlab.ts` | **New** — `GitLabAdapter` class (~250 lines) |
| `src/adapters/vcs/gitlab.test.ts` | **New** — unit tests with mocked gitbeaker (~150 lines) |
| `env.ts` | Add `"gitlab"` to `VCS_KIND` enum, add `GITLAB_*` env vars |
| `src/lib/adapters.ts` | Conditional VCS adapter creation based on `VCS_KIND` |
| `src/lib/step-adapters.ts` | Same conditional as `adapters.ts` |
| `package.json` | Add `@gitbeaker/rest` dependency |

No changes to `types.ts`, `workflows/agent.ts`, `sandbox/poll-agent.ts`, or any other consumer — the `VCSAdapter` interface is unchanged.

## GitLabAdapter Configuration

```typescript
export interface GitLabConfig {
  token: string;       // GitLab personal access token (glpat-...)
  projectId: string;   // "owner/repo" path or numeric project ID
  baseBranch: string;  // Target branch for MRs (default: "main")
}
```

### Environment Variables

```
VCS_KIND=gitlab
GITLAB_TOKEN=glpat-xxxxxxxxxxxx
GITLAB_PROJECT_ID=blazity/demo-app
GITLAB_BASE_BRANCH=main
```

All `GITLAB_*` vars are optional at the schema level (only required when `VCS_KIND=gitlab`). All `GITHUB_*` vars become optional too (only required when `VCS_KIND=github`).

## API Mapping

Each `VCSAdapter` method maps to GitLab REST API equivalents via `@gitbeaker/rest`:

### `createBranch(name, base)`

| Step | GitHub (`@octokit/rest`) | GitLab (`@gitbeaker/rest`) |
|------|--------------------------|---------------------------|
| Get base ref | `git.getRef(heads/{base})` | Not needed — GitLab accepts branch name directly |
| Create branch | `git.createRef(refs/heads/{name}, sha)` | `Branches.create(projectId, name, base)` |
| Handle empty repo (409) | Seed README via `repos.createOrUpdateFileContents` | Seed README via `RepositoryFiles.create` |
| Handle existing branch (422/400) | `git.updateRef(force: true)` | `Branches.remove` + `Branches.create` |

### `createPR(branch, title, body)`

| Step | GitHub | GitLab |
|------|--------|--------|
| Create | `pulls.create(head, base, title, body)` | `MergeRequests.create(projectId, source, target, title, {description})` |
| Return value | `{id: data.number, url: data.html_url}` | `{id: mr.iid, url: mr.web_url}` |
| Fatal errors | 422, 404 | 409, 404 |

**Note:** GitLab uses `iid` (project-scoped ID) not `id` (global ID). The `iid` is the MR number visible in the UI (e.g., `!42`), analogous to GitHub's PR number.

### `push(branch, files, options?)`

| Step | GitHub | GitLab |
|------|--------|--------|
| Push files | `getRef` → `getCommit` → `createBlob` (per file) → `createTree` → `createCommit` → `updateRef` | `Commits.create(projectId, branch, message, actions)` |

GitLab's Commits API is significantly simpler — a single call replaces 5-6 GitHub API calls. Each file becomes an action:

```typescript
const actions = files.map(f => ({
  action: "update" as const,  // or "create" for new files
  filePath: f.path,
  content: f.content,
}));
```

**Merge commit handling:** When `mergeParentSha` is provided, the GitHub adapter creates a two-parent commit. GitLab's Commits API does not support multi-parent commits directly. Instead, we use the MergeRequests rebase API or handle conflict resolution at the MR level. For the initial implementation, we skip the merge-parent optimization and use a regular commit — the workflow's conflict resolution flow already recreates the branch from base when conflicts are detected.

### `getBranchSha(branch)`

| GitHub | GitLab |
|--------|--------|
| `git.getRef(heads/{branch})` → `data.object.sha` | `Branches.show(projectId, branch)` → `commit.id` |

### `getPRComments(prId)`

| Comment type | GitHub | GitLab |
|-------------|--------|--------|
| Review/inline comments | `pulls.listReviewComments` | `MergeRequestDiscussions.all` (filter for diff notes) |
| General comments | `issues.listComments` | `MergeRequestNotes.all` (filter for non-system notes) |
| Liked detection | `reactions.total_count > 0` | Note has award emoji (or simplified: skip, default `false`) |

GitLab distinguishes between "notes" (general comments) and "discussions" (threaded diff comments). Both map to `PRComment[]`.

For inline comments, GitLab notes include `position.new_path` and `position.new_line` which map to `filePath` and `startLine`/`endLine`.

### `getCheckRunResults(prId)`

| Step | GitHub | GitLab |
|------|--------|--------|
| Get head SHA | `pulls.get` → `head.sha` | `MergeRequests.show` → `sha` |
| List CI results | `checks.listForRef(sha)` | `MergeRequests.allPipelines` → `Jobs.all(pipelineId)` |
| Fetch failed logs | `actions.downloadJobLogsForWorkflowRun` | `Jobs.showLog(projectId, jobId)` |

**Status mapping:**

| GitLab job status | `CheckRunResult.status` | `CheckRunResult.conclusion` |
|-------------------|------------------------|-----------------------------|
| `success` | `"completed"` | `"success"` |
| `failed` | `"completed"` | `"failure"` |
| `running` | `"in_progress"` | `null` |
| `pending`, `created` | `"queued"` | `null` |
| `canceled` | `"completed"` | `"cancelled"` |
| `skipped` | `"completed"` | `"skipped"` |

### `getPRConflictStatus(prId)`

| GitHub | GitLab |
|--------|--------|
| `pulls.get` → `mergeable === false` | `MergeRequests.show` → `has_conflicts === true` |

### `findPR(branch)`

| GitHub | GitLab |
|--------|--------|
| `pulls.list({head: "owner:branch", state: "open"})` | `MergeRequests.all({projectId, sourceBranch: branch, state: "opened"})` |

## Error Handling

Follow the same pattern as `GitHubAdapter`:

- **Fatal (non-retryable):** 404 (project not found), 409 (MR already exists for this branch pair). Throw `FatalError`.
- **Transient (retryable):** 401 (token expired), 403 (rate limit), 429 (too many requests), 5xx. Let the error propagate for workflow retry.
- **Branch conflicts:** 400 on branch create → delete + recreate.

## Testing Strategy

Mirror `github.test.ts` structure:

1. Mock `@gitbeaker/rest` with `vi.mock`
2. Test all 8 methods with happy path
3. Test error handling: empty repo seed (createBranch), existing branch reset, fatal errors on createPR
4. Test status mapping for CI jobs

Target: ~8-10 test cases matching the GitHub adapter's coverage plus GitLab-specific edge cases (status mapping).

## Factory Update

Both `adapters.ts` and `step-adapters.ts` get a `createVCS()` helper:

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

## Env Validation

The `env.ts` schema makes all provider-specific vars optional. Runtime validation happens in the factory — if `VCS_KIND=gitlab` but `GITLAB_TOKEN` is missing, the `!` assertion will throw at startup. This matches how the project handles other conditional adapters.

A future improvement could add Zod `.refine()` for cross-field validation, but that's out of scope.

## Out of Scope

- Self-hosted GitLab support (configurable base URL)
- GitLab-specific features beyond VCSAdapter (e.g., GitLab-specific CI features)
- Merge commit with multiple parents via Commits API (use branch reset flow instead)
- Award emoji counting for `liked` field (default to `false` initially)
