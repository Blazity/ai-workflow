# Empty Repository Initialization Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle GitHub's 409 "Git Repository is empty" error in `createBranch` by seeding the repo with a README via `repos.createOrUpdateFileContents` — the only endpoint that works on empty repos.

**Architecture:** When `getRef` returns 409, use `repos.createOrUpdateFileContents` to create a README.md (this is the only GitHub API endpoint that can bootstrap an empty repo — the low-level git API endpoints like `git.createTree` and `git.createCommit` also return 409 on empty repos). The response contains the commit SHA, which we use directly for branch creation without a second `getRef` call.

**Tech Stack:** TypeScript, Octokit REST (`repos.createOrUpdateFileContents`), Vitest

---

## Task 1: Handle empty repo in `createBranch`

**Files:**
- Modify: `src/adapters/github-client.ts:15-67`
- Modify: `src/adapters/github-client.test.ts`

- [x] **Step 1: Write the failing test for 409 handling**

Add `createOrUpdateFileContents: vi.fn()` to the `repos` mock object. Add test:

```typescript
it("initializes empty repo and creates branch when getRef returns 409", async () => {
  const { Octokit } = await import("@octokit/rest");
  const { GitHubClient } = await import("./github-client.js");
  const client = new GitHubClient("test-token");

  const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;

  mockInstance.git.getRef.mockRejectedValueOnce(
    Object.assign(new Error("Git Repository is empty"), { status: 409 }),
  );

  mockInstance.repos.createOrUpdateFileContents.mockResolvedValue({
    data: { commit: { sha: "init-sha" } },
  });
  mockInstance.git.createRef.mockResolvedValue({ data: {} });

  await client.createBranch("owner", "repo", "blazebot/PROJ-42", "main");

  expect(mockInstance.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
    owner: "owner",
    repo: "repo",
    path: "README.md",
    message: "Initial commit",
    content: expect.any(String),
  });
  expect(mockInstance.git.getRef).toHaveBeenCalledTimes(1);
  expect(mockInstance.git.createRef).toHaveBeenCalledWith({
    owner: "owner",
    repo: "repo",
    ref: "refs/heads/blazebot/PROJ-42",
    sha: "init-sha",
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/github-client.test.ts`
Expected: FAIL — `createBranch` doesn't catch 409

- [x] **Step 3: Write the failing test for non-409 error propagation**

```typescript
it("propagates non-409 errors from getRef", async () => {
  const { Octokit } = await import("@octokit/rest");
  const { GitHubClient } = await import("./github-client.js");
  const client = new GitHubClient("test-token");

  const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
  mockInstance.git.getRef.mockRejectedValue(
    Object.assign(new Error("Internal Server Error"), { status: 500 }),
  );

  await expect(
    client.createBranch("owner", "repo", "blazebot/PROJ-42", "main"),
  ).rejects.toThrow("Internal Server Error");

  expect(mockInstance.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
});
```

- [x] **Step 4: Implement `createBranch` fix**

In `src/adapters/github-client.ts`, wrap `getRef` in try/catch. On 409, seed the repo with `repos.createOrUpdateFileContents` and use the commit SHA directly:

```typescript
async createBranch(
  repoOwner: string,
  repoName: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  let refSha: string;
  try {
    const { data: ref } = await this.octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${baseBranch}`,
    });
    refSha = ref.object.sha;
  } catch (err: unknown) {
    const error = err as { status?: number };
    // GitHub returns 409 for all git operations on repos with no commits;
    // createOrUpdateFileContents is the only endpoint that can bootstrap one
    if (error.status !== 409) throw err;

    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      owner: repoOwner,
      repo: repoName,
      path: 'README.md',
      message: 'Initial commit',
      content: Buffer.from(`# ${repoName}\n`).toString('base64'),
    });
    refSha = data.commit.sha!;
  }

  try {
    await this.octokit.git.createRef({
      owner: repoOwner,
      repo: repoName,
      ref: `refs/heads/${branchName}`,
      sha: refSha,
    });
  } catch (err: unknown) {
    const error = err as { status?: number };
    if (error.status === 422) return;
    throw err;
  }
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: ALL PASS (157 tests across 16 files)

## Lessons Learned

GitHub's low-level git API endpoints (`git.createTree`, `git.createCommit`, `git.createRef`) **also return 409 on empty repos**. The only endpoint capable of bootstrapping an empty repository is `repos.createOrUpdateFileContents`, which means creating at least one file (e.g. README.md) is unavoidable.
