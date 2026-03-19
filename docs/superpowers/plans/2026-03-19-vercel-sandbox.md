# Vercel Sandbox Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the sandbox layer pluggable with two backends — Docker (existing, self-hosted) and Vercel Sandbox (cloud, `@vercel/sandbox` SDK) — selectable via `SANDBOX_PROVIDER` env var.

**Architecture:** Extract a `SandboxProvider` interface from the existing Docker sandbox code. Wrap current Docker logic in `DockerSandboxProvider`. Build `VercelSandboxProvider` using `@vercel/sandbox` SDK. Factory function resolves the active provider from env. Workflows call through the interface.

**Tech Stack:** `@vercel/sandbox` SDK, Zod for env validation, Vitest for tests.

**Design doc:** `docs/superpowers/plans/2026-03-19-vercel-sandbox-design.md`

---

### Task 1: Define SandboxProvider interface and extract shared types

**Files:**
- Create: `packages/app/src/sandbox/types.ts`
- Modify: `packages/app/src/sandbox/manager.ts:7-34`

**Step 1: Create the types file**

Create `packages/app/src/sandbox/types.ts` with the interface and shared types extracted from `manager.ts`:

```ts
export interface SandboxOptions {
  branchName: string;
  requirementsMd: string;
  githubToken: string;
  repoUrl: string;
  oauthToken: string;
  model: string;
  timeoutMs: number;
  developerMode: boolean;
}

export type SandboxResult = {
  exitCode: number;
  status: "complete" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
  containerId?: string;
};

export interface AgentOutput {
  result: "implemented" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
}

export interface SandboxProvider {
  runSandbox(options: SandboxOptions): Promise<SandboxResult>;
  pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }>;
  teardown(handle: string): Promise<void>;
  cleanupOrphans(): Promise<void>;
}
```

Key changes from current `SandboxOptions`:
- Removed `image` (Docker-specific — will live in `DockerSandboxProvider`)
- Removed `memoryLimitMb` (Docker-specific — will live in `DockerSandboxProvider`)
- These Docker-specific fields will be read from `appEnv` inside the Docker provider

**Step 2: Update manager.ts imports**

In `packages/app/src/sandbox/manager.ts`, remove the `SandboxOptions`, `SandboxResult`, and `AgentOutput` type definitions (lines 7-34) and replace with imports from `types.ts`:

```ts
import type { SandboxOptions, SandboxResult, AgentOutput } from "./types.js";
```

The Docker provider still needs `image` and `memoryLimitMb`, so its `runSandbox` will read those from `appEnv` directly (added in Task 2).

**Step 3: Run tests to verify nothing broke**

Run: `cd packages/app && pnpm test -- --run`
Expected: All existing tests pass — this is a pure type extraction.

**Step 4: Commit**

```
feat(sandbox): extract SandboxProvider interface and shared types
```

---

### Task 2: Create DockerSandboxProvider class

**Files:**
- Create: `packages/app/src/sandbox/docker-provider.ts`
- Modify: `packages/app/src/sandbox/manager.ts`

**Step 1: Write the failing test**

Create `packages/app/src/sandbox/docker-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProvider } from "./types.js";

let mockContainer: {
  id: string;
  start: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
};
let createContainerSpy: ReturnType<typeof vi.fn>;
let listContainersSpy: ReturnType<typeof vi.fn>;

vi.mock("dockerode", () => {
  mockContainer = {
    id: "container-abc123",
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    logs: vi.fn(),
    remove: vi.fn(),
    kill: vi.fn(),
    commit: vi.fn(),
  };
  createContainerSpy = vi.fn().mockResolvedValue(mockContainer);
  listContainersSpy = vi.fn().mockResolvedValue([]);
  class MockDocker {
    createContainer = createContainerSpy;
    getContainer = vi.fn().mockReturnValue(mockContainer);
    listContainers = listContainersSpy;
  }
  return { default: MockDocker };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/blazebot-abc"),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("@blazebot/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

const makeAgentOutput = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Full text response from Claude...",
    structured_output: { result, ...extra },
    session_id: "test-session",
  });

function mockLogs(stdout: string, stderr = "") {
  mockContainer.logs.mockImplementation(() => {
    const frames: Buffer[] = [];
    if (stdout) {
      const payload = Buffer.from(stdout, "utf-8");
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      frames.push(header, payload);
    }
    if (stderr) {
      const payload = Buffer.from(stderr, "utf-8");
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(payload.length, 4);
      frames.push(header, payload);
    }
    return Promise.resolve(frames.length > 0 ? Buffer.concat(frames) : Buffer.alloc(0));
  });
}

describe("DockerSandboxProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContainer.start.mockResolvedValue(undefined);
    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockLogs(makeAgentOutput("implemented", { summary: "Done" }));
  });

  it("implements SandboxProvider interface", async () => {
    const { DockerSandboxProvider } = await import("./docker-provider.js");
    const provider: SandboxProvider = new DockerSandboxProvider({
      image: "blazebot-sandbox",
      memoryLimitMb: 4096,
    });
    expect(provider.runSandbox).toBeDefined();
    expect(provider.pushBranch).toBeDefined();
    expect(provider.teardown).toBeDefined();
    expect(provider.cleanupOrphans).toBeDefined();
  });

  it("runSandbox returns complete on implemented result", async () => {
    const { DockerSandboxProvider } = await import("./docker-provider.js");
    const provider = new DockerSandboxProvider({
      image: "blazebot-sandbox",
      memoryLimitMb: 4096,
    });

    mockLogs(makeAgentOutput("implemented", { summary: "Built it" }));

    const result = await provider.runSandbox({
      branchName: "blazebot/PROJ-42",
      requirementsMd: "# Requirements\nDo the thing",
      githubToken: "ghp_test",
      repoUrl: "owner/repo",
      oauthToken: "sk-ant-oat01-test",
      model: "claude-opus-4-6",
      timeoutMs: 30000,
      developerMode: false,
    });

    expect(result.status).toBe("complete");
    expect(result.summary).toBe("Built it");
    expect(result.containerId).toBe("container-abc123");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/app && pnpm test -- --run docker-provider`
Expected: FAIL — module `./docker-provider.js` not found.

**Step 3: Create DockerSandboxProvider**

Create `packages/app/src/sandbox/docker-provider.ts`. This wraps the existing functions from `manager.ts`:

```ts
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
import {
  runSandbox as dockerRunSandbox,
  pushBranchFromContainer,
  teardownContainer,
  cleanupOrphanContainers,
} from "./manager.js";

export interface DockerSandboxConfig {
  image: string;
  memoryLimitMb: number;
}

export class DockerSandboxProvider implements SandboxProvider {
  constructor(private config: DockerSandboxConfig) {}

  async runSandbox(options: SandboxOptions): Promise<SandboxResult> {
    return dockerRunSandbox({
      ...options,
      image: this.config.image,
      memoryLimitMb: this.config.memoryLimitMb,
    });
  }

  async pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }> {
    return pushBranchFromContainer(handle, branchName);
  }

  async teardown(handle: string): Promise<void> {
    return teardownContainer(handle);
  }

  async cleanupOrphans(): Promise<void> {
    return cleanupOrphanContainers();
  }
}
```

Note: `manager.ts` still needs to accept `image` and `memoryLimitMb` in its `runSandbox` function signature. Keep those fields on the internal Docker-specific options type. The simplest approach: `manager.ts`'s `runSandbox` keeps its current signature (accepting `image` and `memoryLimitMb`), and `DockerSandboxProvider` merges them in. So `manager.ts`'s `SandboxOptions` import becomes a local extended type:

In `manager.ts`, change the `runSandbox` function signature to accept the full options including Docker-specific fields:

```ts
import type { SandboxResult, AgentOutput } from "./types.js";
import type { SandboxOptions } from "./types.js";

interface DockerRunOptions extends SandboxOptions {
  image: string;
  memoryLimitMb: number;
}

export async function runSandbox(options: DockerRunOptions): Promise<SandboxResult> {
  // ... existing code unchanged
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/app && pnpm test -- --run docker-provider`
Expected: PASS

**Step 5: Run all tests**

Run: `cd packages/app && pnpm test -- --run`
Expected: All pass (existing `manager.test.ts` still works since `runSandbox` signature is backward-compatible).

**Step 6: Commit**

```
feat(sandbox): add DockerSandboxProvider wrapping existing Docker logic
```

---

### Task 3: Add Vercel env vars and provider factory

**Files:**
- Modify: `packages/app/src/env.ts:1-57`
- Create: `packages/app/src/sandbox/index.ts`

**Step 1: Write the failing test**

Create `packages/app/src/sandbox/index.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("./docker-provider.js", () => ({
  DockerSandboxProvider: class {
    constructor(public config: unknown) {}
    runSandbox = vi.fn();
    pushBranch = vi.fn();
    teardown = vi.fn();
    cleanupOrphans = vi.fn();
  },
}));

vi.mock("./vercel-provider.js", () => ({
  VercelSandboxProvider: class {
    constructor(public config: unknown) {}
    runSandbox = vi.fn();
    pushBranch = vi.fn();
    teardown = vi.fn();
    cleanupOrphans = vi.fn();
  },
}));

describe("getSandboxProvider", () => {
  it("returns DockerSandboxProvider by default", async () => {
    const { createSandboxProvider } = await import("./index.js");
    const provider = createSandboxProvider({ provider: "docker", docker: { image: "test", memoryLimitMb: 4096 } });
    expect(provider.constructor.name).toBe("DockerSandboxProvider");
  });

  it("returns VercelSandboxProvider when configured", async () => {
    const { createSandboxProvider } = await import("./index.js");
    const provider = createSandboxProvider({ provider: "vercel", vercel: { vcpus: 2 } });
    expect(provider.constructor.name).toBe("VercelSandboxProvider");
  });

  it("throws on unknown provider", async () => {
    const { createSandboxProvider } = await import("./index.js");
    expect(() => createSandboxProvider({ provider: "unknown" as any })).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/app && pnpm test -- --run sandbox/index`
Expected: FAIL — module not found.

**Step 3: Add env vars to env.ts**

In `packages/app/src/env.ts`, add the following to the `server` object (after the existing `DEVELOPER_MODE` entry around line 39):

```ts
    SANDBOX_PROVIDER: z.enum(["docker", "vercel"]).default("docker"),
    VERCEL_TOKEN: z.string().min(1).optional(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
    VERCEL_PROJECT_ID: z.string().min(1).optional(),
    VERCEL_SANDBOX_VCPUS: z
      .string()
      .default("2")
      .transform((v) => parseInt(v, 10))
      .pipe(z.number().int().min(1).max(8)),
```

**Step 4: Create provider factory**

Create `packages/app/src/sandbox/index.ts`:

```ts
import type { SandboxProvider } from "./types.js";
import { DockerSandboxProvider, type DockerSandboxConfig } from "./docker-provider.js";
import { VercelSandboxProvider, type VercelSandboxConfig } from "./vercel-provider.js";

export type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";

type ProviderConfig =
  | { provider: "docker"; docker: DockerSandboxConfig }
  | { provider: "vercel"; vercel: VercelSandboxConfig };

export function createSandboxProvider(config: ProviderConfig): SandboxProvider {
  switch (config.provider) {
    case "docker":
      return new DockerSandboxProvider(config.docker);
    case "vercel":
      return new VercelSandboxProvider(config.vercel);
    default:
      throw new Error(`Unknown sandbox provider: ${(config as { provider: string }).provider}`);
  }
}
```

Note: `VercelSandboxProvider` doesn't exist yet — the test mocks it. We'll create it in Task 5.

**Step 5: Run test to verify it passes**

Run: `cd packages/app && pnpm test -- --run sandbox/index`
Expected: PASS

**Step 6: Commit**

```
feat(sandbox): add provider factory and Vercel env vars
```

---

### Task 4: Extract parseAgentOutput to shared utility

**Files:**
- Create: `packages/app/src/sandbox/parse-output.ts`
- Modify: `packages/app/src/sandbox/manager.ts:306-341`

The `parseAgentOutput` function and `sanitizeForLog` helper are needed by both providers. Extract them.

**Step 1: Write the failing test**

Create `packages/app/src/sandbox/parse-output.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgentOutput, sanitizeForLog } from "./parse-output.js";

describe("parseAgentOutput", () => {
  const makeEnvelope = (result: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Full text response...",
      structured_output: { result, ...extra },
    });

  it("parses structured_output from envelope", () => {
    const output = parseAgentOutput(makeEnvelope("implemented", { summary: "Done" }));
    expect(output).toEqual({ result: "implemented", summary: "Done" });
  });

  it("falls back to bare result field", () => {
    const output = parseAgentOutput(JSON.stringify({ result: "implemented", summary: "Bare" }));
    expect(output).toEqual({ result: "implemented", summary: "Bare" });
  });

  it("returns null for non-JSON output", () => {
    expect(parseAgentOutput("random text")).toBeNull();
  });

  it("returns null when result field is not a valid enum value", () => {
    const output = parseAgentOutput(
      JSON.stringify({ type: "result", result: "I have successfully done the thing..." }),
    );
    expect(output).toBeNull();
  });

  it("scans from last line backwards", () => {
    const stdout = "some logs\nmore logs\n" + makeEnvelope("clarification_needed", { questions: ["What?"] });
    const output = parseAgentOutput(stdout);
    expect(output?.result).toBe("clarification_needed");
  });
});

describe("sanitizeForLog", () => {
  it("truncates to last 1000 chars", () => {
    const long = "x".repeat(2000);
    expect(sanitizeForLog(long)).toHaveLength(1000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/app && pnpm test -- --run parse-output`
Expected: FAIL — module not found.

**Step 3: Create parse-output.ts**

Create `packages/app/src/sandbox/parse-output.ts` by extracting from `manager.ts` lines 244-341:

```ts
import type { AgentOutput } from "./types.js";

export function sanitizeForLog(text: string): string {
  return text.slice(-1000);
}

/**
 * Claude Code with `--output-format json --json-schema <schema>` returns an envelope:
 *   { "type": "result", "subtype": "success", "result": "...", "structured_output": { ... } }
 * Our agent schema lives in `structured_output`. If `--json-schema` was not honoured
 * (older Claude Code, or schema error) we fall back to parsing the envelope `result` field.
 */
export function parseAgentOutput(stdout: string): AgentOutput | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const envelope = JSON.parse(line);

      if (
        envelope.structured_output &&
        typeof envelope.structured_output.result === "string"
      ) {
        return envelope.structured_output as AgentOutput;
      }

      if (
        envelope.result &&
        typeof envelope.result === "string" &&
        ["implemented", "clarification_needed", "failed"].includes(envelope.result)
      ) {
        return envelope as AgentOutput;
      }
    } catch {
      continue;
    }
  }
  return null;
}
```

**Step 4: Update manager.ts to import from parse-output.ts**

In `manager.ts`, remove the `sanitizeForLog` function (line 244-246) and the `parseAgentOutput` function (lines 306-341). Replace with:

```ts
import { parseAgentOutput, sanitizeForLog } from "./parse-output.js";
```

**Step 5: Run all tests to verify nothing broke**

Run: `cd packages/app && pnpm test -- --run`
Expected: All pass.

**Step 6: Commit**

```
refactor(sandbox): extract parseAgentOutput to shared module
```

---

### Task 5: Install `@vercel/sandbox` SDK

**Files:**
- Modify: `packages/app/package.json`

**Step 1: Install the dependency**

Run: `cd packages/app && pnpm add @vercel/sandbox`

**Step 2: Verify it installed**

Run: `cd packages/app && node -e "require.resolve('@vercel/sandbox')"`
Expected: Resolves without error.

**Step 3: Commit**

```
chore: add @vercel/sandbox dependency
```

---

### Task 6: Implement VercelSandboxProvider

**Files:**
- Create: `packages/app/src/sandbox/vercel-provider.ts`
- Create: `packages/app/src/sandbox/vercel-provider.test.ts`

**Step 1: Write the failing test**

Create `packages/app/src/sandbox/vercel-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProvider } from "./types.js";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockSandboxId = "sbx-abc123";

const mockSandbox = {
  sandboxId: mockSandboxId,
  runCommand: mockRunCommand,
  writeFiles: mockWriteFiles,
  stop: mockStop,
  status: "running" as const,
};

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn().mockResolvedValue(mockSandbox),
    get: vi.fn().mockResolvedValue(mockSandbox),
    list: vi.fn().mockResolvedValue({ json: { sandboxes: [], pagination: {} } }),
  },
}));

vi.mock("@blazebot/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

const makeAgentOutput = (result: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Full text...",
    structured_output: { result, ...extra },
  });

describe("VercelSandboxProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: Claude Code install succeeds, agent returns implemented
    mockRunCommand.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === "npm") {
        return { exitCode: 0, stdout: async () => "installed", stderr: async () => "" };
      }
      // Claude Code run
      return {
        exitCode: 0,
        stdout: async () => makeAgentOutput("implemented", { summary: "Built it" }),
        stderr: async () => "",
      };
    });
    mockWriteFiles.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  it("implements SandboxProvider interface", async () => {
    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider: SandboxProvider = new VercelSandboxProvider({ vcpus: 2 });
    expect(provider.runSandbox).toBeDefined();
    expect(provider.pushBranch).toBeDefined();
    expect(provider.teardown).toBeDefined();
    expect(provider.cleanupOrphans).toBeDefined();
  });

  it("runSandbox creates sandbox with git source and returns result", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    const result = await provider.runSandbox({
      branchName: "blazebot/PROJ-42",
      requirementsMd: "# Requirements\nDo it",
      githubToken: "ghp_test",
      repoUrl: "owner/repo",
      oauthToken: "sk-ant-oat01-test",
      model: "claude-opus-4-6",
      timeoutMs: 600000,
      developerMode: false,
    });

    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          type: "git",
          url: "https://github.com/owner/repo.git",
          password: "ghp_test",
          revision: "blazebot/PROJ-42",
          depth: 1,
        }),
        runtime: "node22",
      }),
    );
    expect(result.status).toBe("complete");
    expect(result.summary).toBe("Built it");
    expect(result.containerId).toBe("sbx-abc123");
  });

  it("runSandbox writes requirements.md into sandbox", async () => {
    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    await provider.runSandbox({
      branchName: "blazebot/PROJ-42",
      requirementsMd: "# The requirements",
      githubToken: "ghp_test",
      repoUrl: "owner/repo",
      oauthToken: "sk-ant-oat01-test",
      model: "claude-opus-4-6",
      timeoutMs: 600000,
      developerMode: false,
    });

    expect(mockWriteFiles).toHaveBeenCalledWith([
      { path: "requirements.md", content: Buffer.from("# The requirements") },
    ]);
  });

  it("runSandbox returns clarification_needed", async () => {
    mockRunCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "npm") return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      return {
        exitCode: 0,
        stdout: async () => makeAgentOutput("clarification_needed", { questions: ["What color?"] }),
        stderr: async () => "",
      };
    });

    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    const result = await provider.runSandbox({
      branchName: "blazebot/PROJ-42",
      requirementsMd: "# Req",
      githubToken: "ghp_test",
      repoUrl: "owner/repo",
      oauthToken: "sk-ant-oat01-test",
      model: "claude-opus-4-6",
      timeoutMs: 600000,
      developerMode: false,
    });

    expect(result.status).toBe("clarification_needed");
    expect(result.questions).toEqual(["What color?"]);
  });

  it("runSandbox returns failed when agent fails", async () => {
    mockRunCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "npm") return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      return {
        exitCode: 1,
        stdout: async () => makeAgentOutput("failed", { error: "Tests failed" }),
        stderr: async () => "",
      };
    });

    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    const result = await provider.runSandbox({
      branchName: "blazebot/PROJ-42",
      requirementsMd: "# Req",
      githubToken: "ghp_test",
      repoUrl: "owner/repo",
      oauthToken: "sk-ant-oat01-test",
      model: "claude-opus-4-6",
      timeoutMs: 600000,
      developerMode: false,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Tests failed");
  });

  it("runSandbox returns failed when no structured output", async () => {
    mockRunCommand.mockImplementation(async (cmd: string) => {
      if (cmd === "npm") return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      return {
        exitCode: 1,
        stdout: async () => "random text no json",
        stderr: async () => "some error",
      };
    });

    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    const result = await provider.runSandbox({
      branchName: "blazebot/PROJ-42",
      requirementsMd: "# Req",
      githubToken: "ghp_test",
      repoUrl: "owner/repo",
      oauthToken: "sk-ant-oat01-test",
      model: "claude-opus-4-6",
      timeoutMs: 600000,
      developerMode: false,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("structured JSON");
  });

  it("teardown stops the sandbox", async () => {
    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    await provider.teardown("sbx-abc123");

    expect(mockStop).toHaveBeenCalled();
  });

  it("pushBranch runs git push inside sandbox", async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 0,
      stdout: async () => "Everything up-to-date",
      stderr: async () => "",
    });

    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    const result = await provider.pushBranch("sbx-abc123", "blazebot/PROJ-42");

    expect(result.pushed).toBe(true);
    expect(mockRunCommand).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "HEAD:blazebot/PROJ-42"],
      expect.objectContaining({ cwd: "/vercel/sandbox" }),
    );
  });

  it("pushBranch returns pushed=false on non-zero exit", async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 1,
      stdout: async () => "",
      stderr: async () => "error: failed to push",
    });

    const { VercelSandboxProvider } = await import("./vercel-provider.js");
    const provider = new VercelSandboxProvider({ vcpus: 2 });

    const result = await provider.pushBranch("sbx-abc123", "blazebot/PROJ-42");

    expect(result.pushed).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/app && pnpm test -- --run vercel-provider`
Expected: FAIL — module not found.

**Step 3: Implement VercelSandboxProvider**

Create `packages/app/src/sandbox/vercel-provider.ts`:

```ts
import { Sandbox } from "@vercel/sandbox";
import { createLogger } from "@blazebot/shared";
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
import { parseAgentOutput, sanitizeForLog } from "./parse-output.js";

export interface VercelSandboxConfig {
  vcpus?: number;
}

const AGENT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["result"],
  properties: {
    result: { type: "string", enum: ["implemented", "clarification_needed", "failed"] },
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  additionalProperties: false,
});

const logger = createLogger();

export class VercelSandboxProvider implements SandboxProvider {
  private vcpus: number;

  constructor(config: VercelSandboxConfig) {
    this.vcpus = config.vcpus ?? 2;
  }

  async runSandbox(options: SandboxOptions): Promise<SandboxResult> {
    let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;

    try {
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${options.repoUrl}.git`,
          password: options.githubToken,
          revision: options.branchName,
          depth: 1,
        },
        runtime: "node22",
        resources: { vcpus: this.vcpus as 1 | 2 | 4 | 8 },
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
          CLAUDE_MODEL: options.model,
          GITHUB_TOKEN: options.githubToken,
        },
        timeout: options.timeoutMs,
      });

      const sandboxId = sandbox.sandboxId;
      const startTime = Date.now();
      logger.info({ sandboxId, branchName: options.branchName }, "vercel_sandbox_created");

      // Write requirements into the sandbox
      await sandbox.writeFiles([
        { path: "requirements.md", content: Buffer.from(options.requirementsMd) },
      ]);

      // Install Claude Code CLI
      const installResult = await sandbox.runCommand("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
      if (installResult.exitCode !== 0) {
        const installErr = await installResult.stderr();
        logger.error({ sandboxId, error: installErr }, "claude_code_install_failed");
        return {
          exitCode: -1,
          status: "failed",
          error: `Failed to install Claude Code: ${sanitizeForLog(installErr)}`,
          containerId: sandboxId,
        };
      }

      // Run Claude Code agent
      const agentResult = await sandbox.runCommand("bash", ["-c",
        `cat /vercel/sandbox/requirements.md | claude --print --output-format json --json-schema '${AGENT_SCHEMA}' --model "$CLAUDE_MODEL" --dangerously-skip-permissions`,
      ], { cwd: "/vercel/sandbox" });

      const exitCode = agentResult.exitCode;
      const durationMs = Date.now() - startTime;
      logger.info({ sandboxId, exitCode, durationMs }, "vercel_agent_exited");

      const stdout = await agentResult.stdout();
      const stderr = await agentResult.stderr();
      const output = parseAgentOutput(stdout);

      if (!output) {
        const diagnostic = sanitizeForLog(stderr || stdout) || "(no output captured)";
        logger.error({ sandboxId, exitCode, diagnostic }, "vercel_no_structured_output");
        return {
          exitCode,
          status: "failed",
          error: `Agent did not return valid structured JSON output. Output: ${diagnostic.slice(-500)}`,
          containerId: sandboxId,
        };
      }

      switch (output.result) {
        case "implemented":
          return {
            exitCode,
            status: "complete",
            summary: output.summary ?? "",
            containerId: sandboxId,
          };
        case "clarification_needed":
          return {
            exitCode,
            status: "clarification_needed",
            questions: output.questions ?? [],
            containerId: sandboxId,
          };
        default:
          return {
            exitCode,
            status: "failed",
            error: output.error ?? `Agent returned result: ${output.result}`,
            containerId: sandboxId,
          };
      }
    } catch (err) {
      return {
        exitCode: -1,
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
        containerId: sandbox?.sandboxId,
      };
    }
  }

  async pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }> {
    try {
      const sandbox = await Sandbox.get({ sandboxId: handle });
      const result = await sandbox.runCommand("git", ["push", "origin", `HEAD:${branchName}`], {
        cwd: "/vercel/sandbox",
      });
      const output = await result.stdout() + await result.stderr();
      if (result.exitCode !== 0) {
        logger.warn({ sandboxId: handle, branchName, exitCode: result.exitCode, output: sanitizeForLog(output) }, "vercel_push_failed");
        return { pushed: false, output: sanitizeForLog(output) };
      }
      logger.info({ sandboxId: handle, branchName }, "vercel_branch_pushed");
      return { pushed: true, output: sanitizeForLog(output) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.warn({ sandboxId: handle, branchName, error: msg }, "vercel_push_failed");
      return { pushed: false, output: msg };
    }
  }

  async teardown(handle: string): Promise<void> {
    logger.info({ sandboxId: handle }, "vercel_sandbox_teardown_requested");
    try {
      const sandbox = await Sandbox.get({ sandboxId: handle });
      await sandbox.stop();
    } catch {
      /* sandbox may already be stopped */
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      const { json: { sandboxes } } = await Sandbox.list();
      const running = sandboxes.filter((s: { status: string }) => s.status === "running");
      if (running.length === 0) {
        logger.info("vercel_orphan_cleanup_none_found");
        return;
      }
      logger.info({ count: running.length }, "vercel_orphan_cleanup_started");
      for (const s of running) {
        try {
          const sandbox = await Sandbox.get({ sandboxId: s.sandboxId });
          await sandbox.stop();
          logger.info({ sandboxId: s.sandboxId }, "vercel_orphan_sandbox_stopped");
        } catch {
          logger.warn({ sandboxId: s.sandboxId }, "vercel_orphan_sandbox_stop_failed");
        }
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : "Unknown error" }, "vercel_orphan_cleanup_failed");
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/app && pnpm test -- --run vercel-provider`
Expected: PASS

**Step 5: Commit**

```
feat(sandbox): implement VercelSandboxProvider using @vercel/sandbox SDK
```

---

### Task 7: Update workflow to use SandboxProvider

**Files:**
- Modify: `packages/app/src/workflows/implementation.ts:1-19, 115-146, 156-169`

**Step 1: Update imports and create provider**

In `packages/app/src/workflows/implementation.ts`, replace lines 12-16:

```ts
// Before
import {
  runSandbox,
  pushBranchFromContainer,
  teardownContainer,
} from "../sandbox/manager.js";

// After
import { createSandboxProvider } from "../sandbox/index.js";
import type { SandboxProvider } from "../sandbox/types.js";
```

Add provider creation after the logger (around line 21):

```ts
const logger = createLogger();

function createProvider(): SandboxProvider {
  if (appEnv.SANDBOX_PROVIDER === "vercel") {
    return createSandboxProvider({
      provider: "vercel",
      vercel: { vcpus: appEnv.VERCEL_SANDBOX_VCPUS },
    });
  }
  return createSandboxProvider({
    provider: "docker",
    docker: { image: appEnv.DOCKER_IMAGE, memoryLimitMb: appEnv.SANDBOX_MEMORY_MB },
  });
}
```

**Step 2: Update executeSandbox step**

In the `executeSandbox` function (line 115-146), replace the `runSandbox` call:

```ts
async function executeSandbox(
  ticketId: string,
  branchName: string,
  ticket: { title: string; description?: string; comments?: Array<{ body: string }> },
) {
  "use step";
  const provider = createProvider();
  const promptContent = await readPromptFile("implement.md");
  const requirementsMd = assembleImplementationContext(ticket, promptContent);

  const startTime = Date.now();

  const result = await provider.runSandbox({
    branchName,
    requirementsMd,
    githubToken: appEnv.GITHUB_TOKEN!,
    repoUrl: `${appEnv.GITHUB_REPO_OWNER}/${appEnv.GITHUB_REPO_NAME}`,
    oauthToken: appEnv.CLAUDE_CODE_OAUTH_TOKEN,
    model: appEnv.CLAUDE_MODEL,
    timeoutMs: appEnv.JOB_TIMEOUT_MS,
    developerMode: appEnv.DEVELOPER_MODE,
  });

  const durationMs = Date.now() - startTime;
  logger.info(
    { ticketId, exitCode: result.exitCode, containerId: result.containerId, durationMs },
    "agent_exited",
  );

  return result;
}
```

**Step 3: Update pushAndTeardown step**

Replace the `pushAndTeardown` function (line 156-164):

```ts
async function pushAndTeardown(containerId: string, branchName: string) {
  "use step";
  const provider = createProvider();
  try {
    const result = await provider.pushBranch(containerId, branchName);
    return result;
  } finally {
    await provider.teardown(containerId);
  }
}
```

**Step 4: Update teardownStep**

Replace the `teardownStep` function (line 166-169):

```ts
async function teardownStep(containerId: string) {
  "use step";
  const provider = createProvider();
  await provider.teardown(containerId);
}
```

**Step 5: Run all tests**

Run: `cd packages/app && pnpm test -- --run`
Expected: All pass.

**Step 6: Commit**

```
feat(sandbox): wire workflow to use pluggable SandboxProvider
```

---

### Task 8: Update orphan-cleanup plugin

**Files:**
- Modify: `packages/app/src/plugins/orphan-cleanup.ts`

**Step 1: Update the plugin**

Replace `packages/app/src/plugins/orphan-cleanup.ts`:

```ts
import { definePlugin } from "nitro";
import { createSandboxProvider } from "../sandbox/index.js";
import { appEnv } from "../env.js";

export default definePlugin(async () => {
  const provider =
    appEnv.SANDBOX_PROVIDER === "vercel"
      ? createSandboxProvider({ provider: "vercel", vercel: { vcpus: appEnv.VERCEL_SANDBOX_VCPUS } })
      : createSandboxProvider({ provider: "docker", docker: { image: appEnv.DOCKER_IMAGE, memoryLimitMb: appEnv.SANDBOX_MEMORY_MB } });

  await provider.cleanupOrphans();
});
```

**Step 2: Run all tests**

Run: `cd packages/app && pnpm test -- --run`
Expected: All pass.

**Step 3: Verify build**

Run: `cd packages/app && pnpm build`
Expected: Clean build, no type errors.

**Step 4: Commit**

```
feat(sandbox): update orphan-cleanup plugin to use provider
```

---

### Task 9: Clean up old manager.ts test file

**Files:**
- Modify: `packages/app/src/sandbox/manager.test.ts`

The existing `manager.test.ts` tests Docker-specific behavior directly (container creation, logs, etc.). These tests still work since `manager.ts` still exports its functions. Keep them as-is — they test the Docker internals. No changes needed.

However, verify all tests pass end-to-end:

**Step 1: Run full test suite**

Run: `cd packages/app && pnpm test -- --run`
Expected: All pass.

**Step 2: Verify types**

Run: `cd packages/app && npx tsc --noEmit`
Expected: No type errors.

**Step 3: Final commit**

Only if any cleanup was needed:

```
chore(sandbox): verify all tests pass after provider refactor
```
