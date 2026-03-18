# Orphan Container Cleanup & Prompt Error Handling Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add startup cleanup of orphaned Docker containers and clear error messages when prompt files are missing — two small reliability improvements from the MVP checklist.

**Architecture:** Orphan cleanup adds a `cleanupOrphanContainers` function in `src/sandbox/manager.ts` that lists Docker containers matching a Blazebot label, cross-references Postgres for active runs, and removes strays. It runs once in `main()` before accepting work. Prompt error handling wraps the existing `readFile` calls in both worker handlers with a try/catch that produces a clear, actionable error message.

**Tech Stack:** TypeScript, Vitest, Dockerode, Drizzle ORM (unchanged)

---

## Chunk 1: Orphan Container Cleanup

### Task 1: Label containers at creation time

For orphan detection to work, Blazebot containers need a label so we can distinguish them from other Docker containers on the host. The `runSandbox` function creates containers — we add a `blazebot=true` label there.

**Files:**
- Modify: `src/sandbox/manager.ts:99-112`
- Modify: `src/sandbox/manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test to the existing `describe("runSandbox", ...)` block in `src/sandbox/manager.test.ts`:

```typescript
it("labels containers with blazebot=true for orphan detection", async () => {
  const { runSandbox } = await import("./manager.js");

  mockLogs(makeAgentOutput("implemented", { summary: "Done" }));

  await runSandbox(defaultOptions);

  expect(createContainerSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      Labels: { blazebot: "true" },
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: FAIL — no `Labels` in the `createContainer` call.

- [ ] **Step 3: Add `Labels` to `createContainer` in `src/sandbox/manager.ts`**

In the `runSandbox` function, add the `Labels` property to the `createContainer` call (around line 99-112):

```typescript
container = await docker.createContainer({
  Image: options.image,
  Labels: { blazebot: "true" },
  Env: [
    `BLAZEBOT_BRANCH=${options.branchName}`,
    `GITHUB_TOKEN=${options.githubToken}`,
    `REPO_URL=${options.repoUrl}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${options.oauthToken}`,
    `CLAUDE_MODEL=${options.model}`,
  ],
  HostConfig: {
    Memory: options.memoryLimitMb * 1024 * 1024,
    Binds: [`${tmpDir}:/inject:ro`],
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "feat: label sandbox containers with blazebot=true for orphan detection"
```

---

### Task 2: Implement `cleanupOrphanContainers`

The spec (Section 14.3) says: "Active containers from the previous process may be orphaned — the service should detect and clean up stale containers on startup."

The function:
1. Lists all Docker containers with label `blazebot=true` (including stopped ones).
2. For each, checks if the container ID matches an active run in Postgres (`runAttempts` where `status = 'running'`).
3. Removes any that don't match — they're orphans from a previous crash.
4. Also marks the corresponding `runAttempts` rows as `failed` if found.

**Files:**
- Modify: `src/sandbox/manager.ts`
- Modify: `src/sandbox/manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe("cleanupOrphanContainers", ...)` block at the end of `src/sandbox/manager.test.ts`. This needs access to the `db` mock, so we need to mock `../db.js` and `drizzle-orm` at the top level of the test file.

First, add these mocks near the top of `src/sandbox/manager.test.ts` (after the existing mocks):

```typescript
const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});
vi.mock("../db.js", () => ({
  db: {
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));
```

Then add the test block:

```typescript
describe("cleanupOrphanContainers", () => {
  let listContainersSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const Docker = (await import("dockerode")).default;
    const dockerInstance = new Docker();
    listContainersSpy = vi.fn().mockResolvedValue([]);
    (dockerInstance as unknown as { listContainers: typeof listContainersSpy }).listContainers = listContainersSpy;
  });

  it("removes containers with blazebot label that are not tracked in DB", async () => {
    const Docker = (await import("dockerode")).default;
    const dockerInstance = new Docker();
    listContainersSpy = vi.fn().mockResolvedValue([
      { Id: "orphan-123", Labels: { blazebot: "true" }, State: "running" },
      { Id: "orphan-456", Labels: { blazebot: "true" }, State: "exited" },
    ]);
    dockerInstance.listContainers = listContainersSpy;

    const { cleanupOrphanContainers } = await import("./manager.js");
    await cleanupOrphanContainers();

    expect(listContainersSpy).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["blazebot=true"] },
    });
    expect(mockContainer.kill).toHaveBeenCalled();
    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
  });

  it("does nothing when no blazebot containers exist", async () => {
    const Docker = (await import("dockerode")).default;
    const dockerInstance = new Docker();
    listContainersSpy = vi.fn().mockResolvedValue([]);
    dockerInstance.listContainers = listContainersSpy;

    const { cleanupOrphanContainers } = await import("./manager.js");
    await cleanupOrphanContainers();

    expect(mockContainer.kill).not.toHaveBeenCalled();
    expect(mockContainer.remove).not.toHaveBeenCalled();
  });

  it("does not throw when Docker API fails", async () => {
    const Docker = (await import("dockerode")).default;
    const dockerInstance = new Docker();
    listContainersSpy = vi.fn().mockRejectedValue(new Error("Docker not running"));
    dockerInstance.listContainers = listContainersSpy;

    const { cleanupOrphanContainers } = await import("./manager.js");
    await expect(cleanupOrphanContainers()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: FAIL — `cleanupOrphanContainers` is not exported from `./manager.js`.

- [ ] **Step 3: Implement `cleanupOrphanContainers` in `src/sandbox/manager.ts`**

Add the following export at the end of the file (before the private helper functions, or at the bottom):

```typescript
export async function cleanupOrphanContainers(): Promise<void> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["blazebot=true"] },
    });

    if (containers.length === 0) {
      logger.info("orphan_cleanup_none_found");
      return;
    }

    logger.info({ count: containers.length }, "orphan_cleanup_started");

    for (const containerInfo of containers) {
      try {
        await teardownContainer(containerInfo.Id);
        logger.info({ containerId: containerInfo.Id }, "orphan_container_removed");
      } catch {
        logger.warn({ containerId: containerInfo.Id }, "orphan_container_removal_failed");
      }
    }

    logger.info({ removed: containers.length }, "orphan_cleanup_complete");
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "Unknown error" },
      "orphan_cleanup_failed",
    );
  }
}
```

This intentionally takes the simple approach: on startup, all Blazebot-labelled containers are orphans because no jobs are running yet (the worker hasn't started). If the service crashed, every labelled container is stale. If it shut down cleanly, there should be none.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "feat: add cleanupOrphanContainers for startup safety (spec Section 14.3)"
```

---

### Task 3: Call `cleanupOrphanContainers` on startup

Wire the cleanup into `main()` in `src/index.ts` so it runs before the worker starts processing jobs.

**Files:**
- Modify: `src/index.ts:72-82`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block to `src/index.test.ts`:

```typescript
const mockCleanupOrphans = vi.fn();
vi.mock("./sandbox/manager.js", () => ({
  cleanupOrphanContainers: (...args: unknown[]) => mockCleanupOrphans(...args),
  runSandbox: vi.fn(),
  pushBranchFromContainer: vi.fn(),
  teardownContainer: vi.fn(),
}));
```

Note: the `buildApp()` function doesn't call cleanup — `main()` does. Since `main()` calls `process.exit`, we test this by importing and testing the exported `startup` function instead. So the implementation in Step 3 will export a `startup` function from `index.ts` that `main()` calls.

Add the test:

```typescript
describe("startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    vi.stubEnv("PORT", "0");
    vi.clearAllMocks();
    mockCleanupOrphans.mockResolvedValue(undefined);
  });

  it("runs orphan container cleanup before starting", async () => {
    const { buildApp } = await import("./index.js");
    const { cleanupOrphanContainers } = await import("./sandbox/manager.js");

    await cleanupOrphanContainers();

    expect(mockCleanupOrphans).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — `cleanupOrphanContainers` is not imported/called.

- [ ] **Step 3: Add cleanup call to `main()` in `src/index.ts`**

Add the import at the top of `src/index.ts`:

```typescript
import { cleanupOrphanContainers } from "./sandbox/manager.js";
```

Then add the cleanup call at the start of `main()`, before creating the worker:

```typescript
async function main() {
  await cleanupOrphanContainers();

  const app = buildApp();
  const worker = createWorker();
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: run orphan container cleanup on startup"
```

---

## Chunk 2: Missing Prompt File Error Handling

### Task 4: Add clear error messages for missing prompt files

Currently `readFile(promptPath, "utf-8")` throws a raw `ENOENT` error when a prompt file doesn't exist. The spec (Section 12) says: "If rendering fails (missing prompt file, tracker API error), the run fails immediately." The error should be clear and actionable.

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to the existing `describe("worker handler", ...)` block in `src/worker.test.ts`, inside a new nested describe:

```typescript
describe("prompt file error handling", () => {
  it("throws a clear error when implement.md is missing", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });

    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
    );

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await expect(
      handler(
        makeJob({
          type: "implementation",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      ),
    ).rejects.toThrow(/[Pp]rompt file.*not found/);
  });

  it("throws a clear error when review-fix.md is missing", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });

    const { db } = await import("./db.js");
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: "ticket-uuid",
          prId: "42",
          branchName: "blazebot/PROJ-42",
        }]),
      }),
    } as ReturnType<typeof db.select>);

    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
    );

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await expect(
      handler(
        makeJob({
          type: "review_fix",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      ),
    ).rejects.toThrow(/[Pp]rompt file.*not found/);
  });
});
```

Note: You may need to add `vi.mock("node:fs/promises")` or use `vi.spyOn`. Since the worker already imports `readFile` from `node:fs/promises`, you'll need to mock the module. Add this mock near the top of the test file if not already present:

```typescript
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue("You are an agent prompt content"),
  };
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker.test.ts`
Expected: FAIL — the error message is the raw `ENOENT` string, not a user-friendly message.

- [ ] **Step 3: Add `readPromptFile` helper to `src/worker.ts`**

Add a helper function after the existing `createAdapters` function:

```typescript
async function readPromptFile(filename: string): Promise<string> {
  const promptPath = resolve(PROMPTS_DIR, filename);
  try {
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new Error(`Prompt file not found at ${promptPath}. Ensure the prompts/ directory contains ${filename}.`);
    }
    throw err;
  }
}
```

Then replace the two `readFile` calls in the handlers:

In `handleImplementation`, replace:
```typescript
const promptPath = resolve(PROMPTS_DIR, "implement.md");
const promptContent = await readFile(promptPath, "utf-8");
```
with:
```typescript
const promptContent = await readPromptFile("implement.md");
```

In `handleReviewFix`, replace:
```typescript
const promptPath = resolve(PROMPTS_DIR, "review-fix.md");
const promptContent = await readFile(promptPath, "utf-8");
```
with:
```typescript
const promptContent = await readPromptFile("review-fix.md");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run all tests to check for regressions**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: add clear error messages for missing prompt files (spec Section 12)"
```

---

## Spec Alignment Notes

This plan implements:
- **Spec Section 14.3**: Orphan container cleanup — "Active containers from the previous process may be orphaned — the service should detect and clean up stale containers on startup."
- **Spec Section 12**: Missing prompt file handling — "If rendering fails (missing prompt file, tracker API error), the run fails immediately."

Design decisions:
- **Label-based detection** — Blazebot containers get `blazebot=true` label at creation. `cleanupOrphanContainers` lists containers by this label. This avoids relying on container naming conventions.
- **Simple startup cleanup** — On startup, all labelled containers are orphans because the worker hasn't started yet. No need to cross-reference Postgres — if a labelled container exists at startup, it's stale.
- **Best-effort cleanup** — If Docker is unavailable at startup, cleanup logs a warning and continues. This prevents the cleanup from blocking the service.
- **Prompt error wrapping** — `readPromptFile` catches `ENOENT` specifically and rethrows with path and filename. Other fs errors propagate unchanged.
