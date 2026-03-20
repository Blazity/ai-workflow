# Blazebot MVP — Initial Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Blazebot MVP — a polling-driven, Vercel Workflow-orchestrated service that discovers Jira tickets, runs Claude Code in Vercel Sandboxes, and delivers merge-ready PRs.

**Architecture:** Nitro serverless app on Vercel. Vercel Cron polls Jira for tickets in the AI column. Each ticket dispatches a durable Vercel Workflow that provisions a Vercel Sandbox, runs Claude Code with a structured prompt, and handles the result (PR creation, clarification, or retry). No database — workflow state lives in Vercel Workflows. Messaging via Chat SDK.

**Tech Stack:** Nitro (Vercel preset), Workflow DevKit (`workflow` + `workflow/nitro`), `@vercel/sandbox`, `@octokit/rest`, Chat SDK (`chat` + `@chat-adapter/slack`), `pino`, `zod`, `vitest`

---

## File Structure

```
ai-workflow/
├── src/
│   ├── routes/
│   │   ├── cron/
│   │   │   └── poll.get.ts              # Vercel Cron → poll tracker, start workflows
│   │   └── health.get.ts               # Health check
│   ├── plugins/
│   │   └── workflow-world.ts            # Boot workflow runtime on server start
│   ├── workflows/
│   │   ├── implementation.ts            # "use workflow" — implementation flow
│   │   └── review-fix.ts               # "use workflow" — fixing feedback flow
│   ├── adapters/
│   │   ├── issue-tracker/
│   │   │   ├── types.ts                 # IssueTrackerAdapter interface
│   │   │   ├── jira.ts                  # Jira REST API implementation
│   │   │   └── jira.test.ts
│   │   ├── vcs/
│   │   │   ├── types.ts                 # VCSAdapter interface
│   │   │   ├── github.ts               # GitHub via @octokit/rest
│   │   │   └── github.test.ts
│   │   └── messaging/
│   │       ├── types.ts                 # MessagingAdapter interface
│   │       ├── chatsdk.ts              # Chat SDK wrapper
│   │       └── chatsdk.test.ts
│   ├── sandbox/
│   │   ├── manager.ts                   # Sandbox lifecycle (provision, end hook, teardown)
│   │   ├── manager.test.ts
│   │   ├── agent-runner.ts              # Launch Claude Code, parse structured output
│   │   ├── agent-runner.test.ts
│   │   ├── context.ts                   # Assemble requirements.md
│   │   └── context.test.ts
│   └── lib/
│       ├── env.ts                       # Zod-validated env config
│       ├── env.test.ts
│       ├── logger.ts                    # Pino structured JSON logger
│       └── adapters.ts                  # Adapter factory (instantiate from env config)
├── .blazebot/
│   └── prompts/
│       ├── implement.md                 # Implementation prompt
│       └── review-fix.md               # Review fix prompt
├── nitro.config.ts
├── vitest.config.ts
├── vercel.json
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

**Key design decisions:**
- Flat structure (no monorepo) — monorepo is deferred per spec.
- Tests co-located with source files.
- Prompts live in `.blazebot/prompts/` per spec Section 5.
- Adapters use raw `fetch` for Jira (no `jira.js` — keeps it simple and matches prior codebase).
- Workflows use `"use workflow"` for orchestration, `"use step"` for all real work (steps have full Node.js access, can do I/O).
- Deduplication via deterministic `id` in `start()` — e.g., `id: "ticket-${ticketId}"` prevents concurrent duplicate runs without a database.
- **No `git push` from inside sandbox** — per spec Section 15.2, the orchestrator pushes via VCS adapter from outside the sandbox. The sandbox manager extracts changes via `readFileToBuffer` + git diff.
- **Concurrency enforced in poller** — checks active sandbox count via `Sandbox.list()` before dispatching.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `nitro.config.ts`
- Create: `vitest.config.ts`
- Create: `vercel.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ai-workflow",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nitro dev",
    "build": "nitro build",
    "preview": "nitro preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "nitropack": "^2",
    "h3": "^1",
    "workflow": "latest",
    "@workflow/world-postgres": "latest",
    "@vercel/sandbox": "^1.8.1",
    "@octokit/rest": "^22.0.1",
    "chat": "^4.20.2",
    "@chat-adapter/slack": "^4.20.2",
    "pino": "^10.3.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "typescript": "^5.8",
    "vitest": "^3",
    "@workflow/vitest": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.ts", "nitro.config.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist", ".output", ".nitro"]
}
```

- [ ] **Step 3: Create `nitro.config.ts`**

```ts
import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  preset: "vercel",
  modules: ["workflow/nitro"],
  compatibilityDate: "2025-01-01",
  srcDir: "src",
});
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/cron/poll",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

- [ ] **Step 6: Create `.env.example`**

```bash
# Issue Tracker (Jira)
ISSUE_TRACKER_KIND=jira
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=PROJ
COLUMN_AI=AI
COLUMN_AI_REVIEW=AI Review
COLUMN_BACKLOG=Backlog

# VCS (GitHub)
VCS_KIND=github
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo
GITHUB_BASE_BRANCH=main

# Messaging (Chat SDK)
CHAT_SDK_SLACK_TOKEN=xoxb-xxxxxxxxxxxx
CHAT_SDK_CHANNEL_ID=C0123456789
CHAT_SDK_BOT_NAME=blazebot

# Agent
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
CLAUDE_MODEL=claude-sonnet-4-20250514
COMMIT_AUTHOR=ai-workflow-blazity
COMMIT_EMAIL=ai-workflow@blazity.com

# Sandbox
MAX_CONCURRENT_AGENTS=3
JOB_TIMEOUT_MS=1800000

# Polling
POLL_INTERVAL_MS=300000

# Vercel (for local dev — automatic on Vercel via OIDC)
VERCEL_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=

# Cron auth
CRON_SECRET=

# Workflow (local dev only)
WORKFLOW_POSTGRES_URL=postgresql://localhost:5432/ai_workflow
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules/
dist/
.output/
.nitro/
.env
*.local
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`

- [ ] **Step 9: Verify scaffold builds**

Run: `npx nitro build`
Expected: Build completes with no errors.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json nitro.config.ts vitest.config.ts vercel.json .env.example .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold project with Nitro + Workflow DevKit"
```

---

### Task 2: Environment Validation

**Files:**
- Create: `src/lib/env.ts`
- Create: `src/lib/env.test.ts`

- [ ] **Step 1: Write failing test for env validation**

```ts
// src/lib/env.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("env", () => {
  const VALID_ENV = {
    ISSUE_TRACKER_KIND: "jira",
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "token",
    JIRA_PROJECT_KEY: "PROJ",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    VCS_KIND: "github",
    GITHUB_TOKEN: "ghp_test",
    GITHUB_OWNER: "test-org",
    GITHUB_REPO: "test-repo",
    GITHUB_BASE_BRANCH: "main",
    CHAT_SDK_SLACK_TOKEN: "xoxb-test",
    CHAT_SDK_CHANNEL_ID: "C123",
    CHAT_SDK_BOT_NAME: "blazebot",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLAUDE_MODEL: "claude-sonnet-4-20250514",
    COMMIT_AUTHOR: "ai-workflow-blazity",
    COMMIT_EMAIL: "bot@blazity.com",
    MAX_CONCURRENT_AGENTS: "3",
    JOB_TIMEOUT_MS: "1800000",
    POLL_INTERVAL_MS: "300000",
  };

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses valid env", async () => {
    Object.assign(process.env, VALID_ENV);
    const { parseEnv } = await import("./env.js");
    const env = parseEnv();
    expect(env.JIRA_BASE_URL).toBe("https://test.atlassian.net");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(3);
    expect(env.JOB_TIMEOUT_MS).toBe(1800000);
  });

  it("uses defaults for optional fields", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).COMMIT_AUTHOR;
    delete (partial as any).MAX_CONCURRENT_AGENTS;
    Object.assign(process.env, partial);
    const { parseEnv } = await import("./env.js");
    const env = parseEnv();
    expect(env.COMMIT_AUTHOR).toBe("ai-workflow-blazity");
    expect(env.MAX_CONCURRENT_AGENTS).toBe(3);
  });

  it("throws on missing required field", async () => {
    const partial = { ...VALID_ENV };
    delete (partial as any).ANTHROPIC_API_KEY;
    Object.assign(process.env, partial);
    const { parseEnv } = await import("./env.js");
    expect(() => parseEnv()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/env.test.ts`
Expected: FAIL — `parseEnv` not found.

- [ ] **Step 3: Implement `env.ts`**

```ts
// src/lib/env.ts
import { z } from "zod";

const envSchema = z.object({
  // Issue Tracker
  ISSUE_TRACKER_KIND: z.enum(["jira"]),
  JIRA_BASE_URL: z.string().url(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PROJECT_KEY: z.string().min(1),
  COLUMN_AI: z.string().min(1),
  COLUMN_AI_REVIEW: z.string().min(1),
  COLUMN_BACKLOG: z.string().min(1),

  // VCS
  VCS_KIND: z.enum(["github"]),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_BASE_BRANCH: z.string().default("main"),

  // Messaging
  CHAT_SDK_SLACK_TOKEN: z.string().min(1),
  CHAT_SDK_CHANNEL_ID: z.string().min(1),
  CHAT_SDK_BOT_NAME: z.string().default("blazebot"),

  // Agent
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  COMMIT_AUTHOR: z.string().default("ai-workflow-blazity"),
  COMMIT_EMAIL: z.string().default("ai-workflow@blazity.com"),

  // Sandbox
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().positive().default(3),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),

  // Polling
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

  // Vercel (optional — auto via OIDC on Vercel)
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),

  // Cron
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function parseEnv(): Env {
  if (cached) return cached;
  cached = envSchema.parse(process.env);
  return cached;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/env.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/env.ts src/lib/env.test.ts
git commit -m "feat: add zod-validated environment config"
```

---

### Task 3: Structured Logger

**Files:**
- Create: `src/lib/logger.ts`

- [ ] **Step 1: Create logger**

```ts
// src/lib/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function ticketLogger(ticketId: string, identifier: string) {
  return logger.child({ ticket_id: ticketId, ticket_identifier: identifier });
}

export function workflowLogger(
  ticketId: string,
  identifier: string,
  workflowRunId: string,
) {
  return logger.child({
    ticket_id: ticketId,
    ticket_identifier: identifier,
    workflow_run_id: workflowRunId,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/logger.ts
git commit -m "feat: add pino structured logger with ticket context"
```

---

### Task 4: Adapter Interfaces

**Files:**
- Create: `src/adapters/issue-tracker/types.ts`
- Create: `src/adapters/vcs/types.ts`
- Create: `src/adapters/messaging/types.ts`

- [ ] **Step 1: Create issue tracker interface**

```ts
// src/adapters/issue-tracker/types.ts
export interface TicketContent {
  id: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueTrackerAdapter {
  fetchTicket(id: string): Promise<TicketContent>;
  moveTicket(id: string, column: string): Promise<void>;
  postComment(id: string, comment: string): Promise<void>;
  searchTickets(query: string): Promise<string[]>;
}
```

- [ ] **Step 2: Create VCS interface**

```ts
// src/adapters/vcs/types.ts
export interface PullRequest {
  id: number;
  url: string;
  branch: string;
}

export interface PRComment {
  author: string;
  body: string;
  liked: boolean;
}

export interface VCSAdapter {
  createBranch(name: string, base: string): Promise<void>;
  createPR(branch: string, title: string, body: string): Promise<PullRequest>;
  push(branch: string, files: Array<{ path: string; content: string }>): Promise<void>;
  getPRComments(prId: number): Promise<PRComment[]>;
  getPRConflictStatus(prId: number): Promise<boolean>;
  findPR(branch: string): Promise<PullRequest | null>;
}
```

- [ ] **Step 3: Create messaging interface**

```ts
// src/adapters/messaging/types.ts
export interface MessagingAdapter {
  notify(message: string): Promise<void>;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/adapters/
git commit -m "feat: define adapter interfaces for issue tracker, VCS, and messaging"
```

---

### Task 5: Jira Adapter

**Files:**
- Create: `src/adapters/issue-tracker/jira.ts`
- Create: `src/adapters/issue-tracker/jira.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/adapters/issue-tracker/jira.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraAdapter } from "./jira.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function jiraAdapter() {
  return new JiraAdapter({
    baseUrl: "https://test.atlassian.net",
    email: "test@example.com",
    apiToken: "token",
    projectKey: "PROJ",
  });
}

describe("JiraAdapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("fetchTicket", () => {
    it("returns normalized ticket content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Add login page",
            description: { content: [{ content: [{ text: "Build a login page" }] }] },
            comment: {
              comments: [
                { author: { displayName: "Alice" }, body: { content: [{ content: [{ text: "Use OAuth" }] }] }, created: "2026-03-20T10:00:00Z" },
              ],
            },
            labels: ["frontend"],
            status: { name: "AI" },
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      expect(ticket.id).toBe("10001");
      expect(ticket.identifier).toBe("PROJ-1");
      expect(ticket.title).toBe("Add login page");
      expect(ticket.comments).toHaveLength(1);
      expect(ticket.trackerStatus).toBe("AI");
    });
  });

  describe("searchTickets", () => {
    it("returns ticket keys matching JQL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [{ key: "PROJ-1" }, { key: "PROJ-2" }],
        }),
      });

      const adapter = jiraAdapter();
      const keys = await adapter.searchTickets('project = PROJ AND status = "AI"');
      expect(keys).toEqual(["PROJ-1", "PROJ-2"]);
    });
  });

  describe("moveTicket", () => {
    it("fetches transitions then posts the matching one", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transitions: [
              { id: "31", name: "AI Review" },
              { id: "41", name: "Backlog" },
            ],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const adapter = jiraAdapter();
      await adapter.moveTicket("10001", "AI Review");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const transitionCall = mockFetch.mock.calls[1];
      expect(JSON.parse(transitionCall[1].body)).toEqual({
        transition: { id: "31" },
      });
    });
  });

  describe("postComment", () => {
    it("posts ADF-formatted comment", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const adapter = jiraAdapter();
      await adapter.postComment("10001", "Need more details");

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.body.type).toBe("doc");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/adapters/issue-tracker/jira.test.ts`
Expected: FAIL — `JiraAdapter` not found.

- [ ] **Step 3: Implement Jira adapter**

```ts
// src/adapters/issue-tracker/jira.ts
import type { IssueTrackerAdapter, TicketContent, TicketComment } from "./types.js";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export class JiraAdapter implements IssueTrackerAdapter {
  private baseUrl: string;
  private authHeader: string;

  constructor(private config: JiraConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  }

  private async request(path: string, options?: RequestInit) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`Jira API error: ${res.status} ${res.statusText} on ${path}`);
    }
    return res.json();
  }

  async fetchTicket(id: string): Promise<TicketContent> {
    const data = await this.request(
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status`,
    );
    return {
      id: data.id,
      identifier: data.key,
      title: data.fields.summary ?? "",
      description: extractAdfText(data.fields.description),
      acceptanceCriteria: extractAcceptanceCriteria(data.fields.description),
      comments: (data.fields.comment?.comments ?? []).map(
        (c: any): TicketComment => ({
          author: c.author?.displayName ?? "unknown",
          body: extractAdfText(c.body),
          createdAt: c.created,
        }),
      ),
      labels: data.fields.labels ?? [],
      trackerStatus: data.fields.status?.name ?? "",
    };
  }

  async moveTicket(id: string, column: string): Promise<void> {
    const data = await this.request(`/rest/api/3/issue/${id}/transitions`);
    const transition = data.transitions.find(
      (t: any) => t.name.toLowerCase() === column.toLowerCase(),
    );
    if (!transition) {
      throw new Error(
        `No transition to "${column}" found for issue ${id}. Available: ${data.transitions.map((t: any) => t.name).join(", ")}`,
      );
    }
    await this.request(`/rest/api/3/issue/${id}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  async postComment(id: string, comment: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${id}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: comment }],
            },
          ],
        },
      }),
    });
  }

  async searchTickets(jql: string): Promise<string[]> {
    const data = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=50`,
    );
    return (data.issues ?? []).map((issue: any) => issue.key);
  }
}

function extractAdfText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.text) return adf.text;
  if (adf.content) {
    return adf.content.map(extractAdfText).join("\n");
  }
  return "";
}

function extractAcceptanceCriteria(description: any): string {
  const text = extractAdfText(description);
  const match = text.match(/acceptance criteria[:\s]*([\s\S]*?)(?:\n\n|\n#|$)/i);
  return match?.[1]?.trim() ?? "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/adapters/issue-tracker/jira.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/issue-tracker/jira.ts src/adapters/issue-tracker/jira.test.ts
git commit -m "feat: implement Jira adapter with fetch, move, comment, search"
```

---

### Task 6: GitHub Adapter

**Files:**
- Create: `src/adapters/vcs/github.ts`
- Create: `src/adapters/vcs/github.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/adapters/vcs/github.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "./github.js";

const mockOctokit = {
  git: {
    getRef: vi.fn(),
    createRef: vi.fn(),
  },
  repos: {
    createOrUpdateFileContents: vi.fn(),
  },
  pulls: {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
  },
  issues: {
    listComments: vi.fn(),
  },
};

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(() => mockOctokit),
}));

function ghAdapter() {
  return new GitHubAdapter({
    token: "ghp_test",
    owner: "test-org",
    repo: "test-repo",
    baseBranch: "main",
  });
}

describe("GitHubAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createBranch", () => {
    it("creates branch from base ref", async () => {
      mockOctokit.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "abc123" } },
      });
      mockOctokit.git.createRef.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockOctokit.git.createRef).toHaveBeenCalledWith({
        owner: "test-org",
        repo: "test-repo",
        ref: "refs/heads/feat/test",
        sha: "abc123",
      });
    });

    it("seeds empty repo on 409 then creates branch", async () => {
      const error = new Error("Git Repository is empty") as any;
      error.status = 409;
      mockOctokit.git.getRef.mockRejectedValueOnce(error);
      mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({
        data: { commit: { sha: "seed123" } },
      });
      mockOctokit.git.createRef.mockResolvedValueOnce({ data: {} });

      const adapter = ghAdapter();
      await adapter.createBranch("feat/test", "main");

      expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalled();
      expect(mockOctokit.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({ sha: "seed123" }),
      );
    });
  });

  describe("createPR", () => {
    it("creates pull request", async () => {
      mockOctokit.pulls.create.mockResolvedValueOnce({
        data: { number: 42, html_url: "https://github.com/test-org/test-repo/pull/42" },
      });

      const adapter = ghAdapter();
      const pr = await adapter.createPR("feat/test", "Add feature", "Description");

      expect(pr.id).toBe(42);
      expect(pr.url).toContain("/pull/42");
    });
  });

  describe("findPR", () => {
    it("returns null when no PR exists", async () => {
      mockOctokit.pulls.list.mockResolvedValueOnce({ data: [] });

      const adapter = ghAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).toBeNull();
    });

    it("returns PR when one exists", async () => {
      mockOctokit.pulls.list.mockResolvedValueOnce({
        data: [{ number: 42, html_url: "https://github.com/test-org/test-repo/pull/42", head: { ref: "feat/test" } }],
      });

      const adapter = ghAdapter();
      const pr = await adapter.findPR("feat/test");
      expect(pr).not.toBeNull();
      expect(pr!.id).toBe(42);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/adapters/vcs/github.test.ts`
Expected: FAIL — `GitHubAdapter` not found.

- [ ] **Step 3: Implement GitHub adapter**

```ts
// src/adapters/vcs/github.ts
import { Octokit } from "@octokit/rest";
import type { VCSAdapter, PullRequest, PRComment } from "./types.js";

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

export class GitHubAdapter implements VCSAdapter {
  private octokit: Octokit;

  constructor(private config: GitHubConfig) {
    this.octokit = new Octokit({ auth: config.token });
  }

  private get ownerRepo() {
    return { owner: this.config.owner, repo: this.config.repo };
  }

  async createBranch(name: string, base: string): Promise<void> {
    let baseSha: string;
    try {
      const ref = await this.octokit.git.getRef({
        ...this.ownerRepo,
        ref: `heads/${base}`,
      });
      baseSha = ref.data.object.sha;
    } catch (err: any) {
      if (err.status === 409) {
        baseSha = await this.seedEmptyRepo();
      } else {
        throw err;
      }
    }
    await this.octokit.git.createRef({
      ...this.ownerRepo,
      ref: `refs/heads/${name}`,
      sha: baseSha,
    });
  }

  private async seedEmptyRepo(): Promise<string> {
    try {
      const result = await this.octokit.repos.createOrUpdateFileContents({
        ...this.ownerRepo,
        path: "README.md",
        message: "Initial commit",
        content: Buffer.from("# Repository\n").toString("base64"),
      });
      return result.data.commit.sha!;
    } catch (err: any) {
      throw new Error(
        `Failed to seed empty repository ${this.config.owner}/${this.config.repo}: ${err.message}`,
      );
    }
  }

  async createPR(
    branch: string,
    title: string,
    body: string,
  ): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.create({
      ...this.ownerRepo,
      head: branch,
      base: this.config.baseBranch,
      title,
      body,
    });
    return { id: data.number, url: data.html_url, branch };
  }

  async push(branch: string, files: Array<{ path: string; content: string }>): Promise<void> {
    // Get the latest commit SHA on the branch
    const { data: refData } = await this.octokit.git.getRef({
      ...this.ownerRepo,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

    // Get the tree of the latest commit
    const { data: commitData } = await this.octokit.git.getCommit({
      ...this.ownerRepo,
      commit_sha: latestCommitSha,
    });

    // Create blobs for each file
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await this.octokit.git.createBlob({
          ...this.ownerRepo,
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        });
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha,
        };
      }),
    );

    // Create new tree
    const { data: tree } = await this.octokit.git.createTree({
      ...this.ownerRepo,
      base_tree: commitData.tree.sha,
      tree: treeItems,
    });

    // Create commit
    const { data: newCommit } = await this.octokit.git.createCommit({
      ...this.ownerRepo,
      message: "feat: agent implementation",
      tree: tree.sha,
      parents: [latestCommitSha],
    });

    // Update branch ref
    await this.octokit.git.updateRef({
      ...this.ownerRepo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });
  }

  async getPRComments(prId: number): Promise<PRComment[]> {
    const { data: reviewComments } =
      await this.octokit.pulls.listReviewComments({
        ...this.ownerRepo,
        pull_number: prId,
      });
    const { data: issueComments } = await this.octokit.issues.listComments({
      ...this.ownerRepo,
      issue_number: prId,
    });
    const comments: PRComment[] = [
      ...reviewComments.map((c) => ({
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        liked: (c.reactions?.total_count ?? 0) > 0,
      })),
      ...issueComments.map((c) => ({
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        liked: (c.reactions?.total_count ?? 0) > 0,
      })),
    ];
    return comments;
  }

  async getPRConflictStatus(prId: number): Promise<boolean> {
    const { data } = await this.octokit.pulls.get({
      ...this.ownerRepo,
      pull_number: prId,
    });
    return data.mergeable === false;
  }

  async findPR(branch: string): Promise<PullRequest | null> {
    const { data } = await this.octokit.pulls.list({
      ...this.ownerRepo,
      head: `${this.config.owner}:${branch}`,
      state: "open",
    });
    if (data.length === 0) return null;
    const pr = data[0];
    return { id: pr.number, url: pr.html_url, branch: pr.head.ref };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/adapters/vcs/github.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/vcs/github.ts src/adapters/vcs/github.test.ts
git commit -m "feat: implement GitHub VCS adapter with branch, PR, and empty repo handling"
```

---

### Task 7: Chat SDK Messaging Adapter

**Files:**
- Create: `src/adapters/messaging/chatsdk.ts`
- Create: `src/adapters/messaging/chatsdk.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/adapters/messaging/chatsdk.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatSDKAdapter } from "./chatsdk.js";

const mockPost = vi.fn();
const mockChannel = vi.fn(() => ({ post: mockPost }));

vi.mock("chat", () => ({
  Chat: vi.fn(() => ({ channel: mockChannel })),
}));

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn(() => ({})),
}));

describe("ChatSDKAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ id: "msg-1" });
  });

  it("sends notification to configured channel", async () => {
    const adapter = new ChatSDKAdapter({
      slackToken: "xoxb-test",
      channelId: "C123",
      botName: "blazebot",
    });

    await adapter.notify("PR ready for review");

    expect(mockChannel).toHaveBeenCalledWith("slack:C123");
    expect(mockPost).toHaveBeenCalledWith("PR ready for review");
  });

  it("does not throw on notification failure", async () => {
    mockPost.mockRejectedValueOnce(new Error("Slack API down"));

    const adapter = new ChatSDKAdapter({
      slackToken: "xoxb-test",
      channelId: "C123",
      botName: "blazebot",
    });

    await expect(adapter.notify("test")).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/adapters/messaging/chatsdk.test.ts`
Expected: FAIL — `ChatSDKAdapter` not found.

- [ ] **Step 3: Implement Chat SDK adapter**

```ts
// src/adapters/messaging/chatsdk.ts
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { logger } from "../../lib/logger.js";
import type { MessagingAdapter } from "./types.js";

export interface ChatSDKConfig {
  slackToken: string;
  channelId: string;
  botName: string;
}

export class ChatSDKAdapter implements MessagingAdapter {
  private chat: InstanceType<typeof Chat>;
  private channelId: string;

  constructor(config: ChatSDKConfig) {
    this.channelId = config.channelId;
    this.chat = new Chat({
      userName: config.botName,
      adapters: {
        slack: createSlackAdapter({ token: config.slackToken }),
      },
    });
  }

  async notify(message: string): Promise<void> {
    try {
      const channel = this.chat.channel(`slack:${this.channelId}`);
      await channel.post(message);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        "notification_failed",
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/adapters/messaging/chatsdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/messaging/chatsdk.ts src/adapters/messaging/chatsdk.test.ts
git commit -m "feat: implement Chat SDK messaging adapter for Slack/Teams"
```

---

### Task 8: Adapter Factory

**Files:**
- Create: `src/lib/adapters.ts`

- [ ] **Step 1: Create adapter factory**

```ts
// src/lib/adapters.ts
import { parseEnv } from "./env.js";
import { JiraAdapter } from "../adapters/issue-tracker/jira.js";
import { GitHubAdapter } from "../adapters/vcs/github.js";
import { ChatSDKAdapter } from "../adapters/messaging/chatsdk.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";
import type { MessagingAdapter } from "../adapters/messaging/types.js";

export interface Adapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
}

export function createAdapters(): Adapters {
  const env = parseEnv();

  return {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
    vcs: new GitHubAdapter({
      token: env.GITHUB_TOKEN,
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      baseBranch: env.GITHUB_BASE_BRANCH,
    }),
    messaging: new ChatSDKAdapter({
      slackToken: env.CHAT_SDK_SLACK_TOKEN,
      channelId: env.CHAT_SDK_CHANNEL_ID,
      botName: env.CHAT_SDK_BOT_NAME,
    }),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/adapters.ts
git commit -m "feat: add adapter factory to instantiate adapters from env config"
```

---

### Task 9: Context Assembly

**Files:**
- Create: `src/sandbox/context.ts`
- Create: `src/sandbox/context.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/sandbox/context.test.ts
import { describe, it, expect } from "vitest";
import { assembleImplementationContext, assembleFixingFeedbackContext } from "./context.js";

describe("assembleImplementationContext", () => {
  it("assembles requirements.md for implementation", () => {
    const result = assembleImplementationContext({
      ticket: {
        title: "Add login page",
        description: "Build a login page with OAuth",
        acceptanceCriteria: "- User can log in\n- User can log out",
        comments: [
          { author: "Alice", body: "Use OAuth2", createdAt: "2026-03-20T10:00:00Z" },
        ],
      },
      prompt: "You are an implementation agent...",
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("Add login page");
    expect(result).toContain("Build a login page with OAuth");
    expect(result).toContain("User can log in");
    expect(result).toContain("Alice: Use OAuth2");
    expect(result).toContain("You are an implementation agent...");
  });
});

describe("assembleFixingFeedbackContext", () => {
  it("assembles requirements.md for fixing feedback", () => {
    const result = assembleFixingFeedbackContext({
      ticket: {
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "You are a review-fix agent...",
      prComments: [
        { author: "Bob", body: "Fix the typo on line 5", liked: true },
      ],
      hasConflicts: true,
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Fix the typo on line 5");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("You are a review-fix agent...");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/sandbox/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement context assembly**

```ts
// src/sandbox/context.ts
import type { PRComment } from "../adapters/vcs/types.js";

interface TicketData {
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
}

export interface FixingFeedbackContextInput {
  ticket: TicketData;
  prompt: string;
  prComments: PRComment[];
  hasConflicts: boolean;
}

export function assembleImplementationContext(
  input: ImplementationContextInput,
): string {
  const { ticket, prompt } = input;

  return `# Requirements

## Ticket

${ticket.title}

## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

---

${prompt}
`;
}

export function assembleFixingFeedbackContext(
  input: FixingFeedbackContextInput,
): string {
  const { ticket, prompt, prComments, hasConflicts } = input;

  return `# Requirements

## Ticket

${ticket.title}

## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

## PR Review Feedback

${formatPRComments(prComments)}

## Merge Conflicts

${hasConflicts ? "This PR has merge conflicts that must be resolved." : "No merge conflicts."}

---

${prompt}
`;
}

function formatComments(
  comments: Array<{ author: string; body: string; createdAt: string }>,
): string {
  if (comments.length === 0) return "No comments.";
  return comments
    .map((c) => `${c.author}: ${c.body}`)
    .join("\n\n");
}

function formatPRComments(comments: PRComment[]): string {
  if (comments.length === 0) return "No review feedback.";
  return comments
    .map((c) => `${c.author}${c.liked ? " (liked)" : ""}: ${c.body}`)
    .join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/sandbox/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/context.ts src/sandbox/context.test.ts
git commit -m "feat: implement context assembly for requirements.md generation"
```

---

### Task 10: Agent Runner

**Files:**
- Create: `src/sandbox/agent-runner.ts`
- Create: `src/sandbox/agent-runner.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/sandbox/agent-runner.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  parseAgentOutput,
  AGENT_SCHEMA,
  type AgentOutput,
} from "./agent-runner.js";

describe("parseAgentOutput", () => {
  it("parses implemented result", () => {
    const raw = JSON.stringify({
      result: "implemented",
      summary: "Added login page with OAuth",
    });
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("implemented");
    expect(output.summary).toBe("Added login page with OAuth");
  });

  it("parses clarification_needed result", () => {
    const raw = JSON.stringify({
      result: "clarification_needed",
      questions: ["What OAuth provider?", "Should we support SSO?"],
    });
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("clarification_needed");
    expect(output.questions).toHaveLength(2);
  });

  it("parses failed result", () => {
    const raw = JSON.stringify({
      result: "failed",
      error: "Tests do not pass",
    });
    const output = parseAgentOutput(raw);
    expect(output.result).toBe("failed");
    expect(output.error).toBe("Tests do not pass");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAgentOutput("not json")).toThrow();
  });

  it("throws on missing result field", () => {
    expect(() => parseAgentOutput(JSON.stringify({ summary: "oops" }))).toThrow();
  });
});

describe("AGENT_SCHEMA", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(AGENT_SCHEMA)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/sandbox/agent-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement agent runner**

```ts
// src/sandbox/agent-runner.ts
import { z } from "zod";

const agentOutputSchema = z.object({
  result: z.enum(["implemented", "clarification_needed", "failed"]),
  summary: z.string().optional(),
  questions: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

export const AGENT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: {
      type: "string",
      enum: ["implemented", "clarification_needed", "failed"],
    },
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["result"],
});

export function parseAgentOutput(raw: string): AgentOutput {
  const parsed = JSON.parse(raw);
  return agentOutputSchema.parse(parsed);
}

export function buildAgentCommand(model: string): {
  cmd: string;
  args: string[];
} {
  return {
    cmd: "bash",
    args: [
      "-c",
      `cat /vercel/sandbox/requirements.md | claude --print --output-format json --json-schema '${AGENT_SCHEMA}' --model "${model}" --dangerously-skip-permissions`,
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/sandbox/agent-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/agent-runner.ts src/sandbox/agent-runner.test.ts
git commit -m "feat: implement agent runner with structured output parsing and schema"
```

---

### Task 11: Sandbox Manager

**Files:**
- Create: `src/sandbox/manager.ts`
- Create: `src/sandbox/manager.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/sandbox/manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockStop = vi.fn();
const mockStdout = vi.fn();
const mockReadFileToBuffer = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      runCommand: mockRunCommand,
      writeFiles: mockWriteFiles,
      readFileToBuffer: mockReadFileToBuffer,
      stop: mockStop,
    })),
  },
}));

import { SandboxManager } from "./manager.js";

describe("SandboxManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunCommand.mockResolvedValue({
      exitCode: 0,
      stdout: mockStdout,
    });
    mockStdout.mockResolvedValue("");
    mockWriteFiles.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  it("provisions sandbox with git source and env vars", async () => {
    const { Sandbox } = await import("@vercel/sandbox");

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-sonnet-4-20250514",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test-branch", "# Requirements\n...");

    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          type: "git",
          revision: "feat/test-branch",
        }),
        env: expect.objectContaining({
          ANTHROPIC_API_KEY: "sk-ant-test",
        }),
      }),
    );
    expect(mockWriteFiles).toHaveBeenCalled();
    expect(sandbox.sandboxId).toBe("sbx-test-123");
  });

  it("runs end hook and detects clean state", async () => {
    mockStdout.mockResolvedValueOnce(""); // git status --porcelain returns empty

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-sonnet-4-20250514",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test", "# Req");
    const result = await manager.runEndHook(sandbox);

    expect(result).toBe("clean");
  });

  it("commits uncommitted changes in end hook", async () => {
    mockStdout
      .mockResolvedValueOnce(" M src/index.ts") // git status --porcelain
      .mockResolvedValueOnce(""); // git add
    mockRunCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: mockStdout }) // git status
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }) // git add
      .mockResolvedValueOnce({ exitCode: 0, stdout: vi.fn().mockResolvedValue("") }); // git commit

    const manager = new SandboxManager({
      githubToken: "ghp_test",
      owner: "test-org",
      repo: "test-repo",
      anthropicApiKey: "sk-ant-test",
      claudeModel: "claude-sonnet-4-20250514",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "bot@blazity.com",
      jobTimeoutMs: 1_800_000,
    });

    const sandbox = await manager.provision("feat/test", "# Req");
    const result = await manager.runEndHook(sandbox);

    expect(result).toBe("committed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/sandbox/manager.test.ts`
Expected: FAIL — `SandboxManager` not found.

- [ ] **Step 3: Implement sandbox manager**

```ts
// src/sandbox/manager.ts
import { Sandbox } from "@vercel/sandbox";
import { logger } from "../lib/logger.js";

export interface SandboxConfig {
  githubToken: string;
  owner: string;
  repo: string;
  anthropicApiKey: string;
  claudeModel: string;
  commitAuthor: string;
  commitEmail: string;
  jobTimeoutMs: number;
  vercelToken?: string;
  vercelTeamId?: string;
  vercelProjectId?: string;
}

type SandboxInstance = Awaited<ReturnType<typeof Sandbox.create>>;

export type EndHookResult = "clean" | "committed" | "error";

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provision(
    branch: string,
    requirementsMd: string,
  ): Promise<SandboxInstance> {
    const credentials: Record<string, string> = {};
    if (this.config.vercelToken) credentials.token = this.config.vercelToken;
    if (this.config.vercelTeamId) credentials.teamId = this.config.vercelTeamId;
    if (this.config.vercelProjectId) credentials.projectId = this.config.vercelProjectId;

    const sandbox = await Sandbox.create({
      ...credentials,
      source: {
        type: "git",
        url: `https://github.com/${this.config.owner}/${this.config.repo}.git`,
        username: "x-access-token",
        password: this.config.githubToken,
        revision: branch,
        depth: 1,
      },
      runtime: "node24",
      timeout: this.config.jobTimeoutMs,
      env: {
        ANTHROPIC_API_KEY: this.config.anthropicApiKey,
        CLAUDE_MODEL: this.config.claudeModel,
      },
    });

    // Configure git identity
    await sandbox.runCommand("bash", [
      "-c",
      `git config user.name "${this.config.commitAuthor}" && git config user.email "${this.config.commitEmail}"`,
    ]);

    // Install Claude Code
    await sandbox.runCommand("npm", ["install", "-g", "@anthropic-ai/claude-code"]);

    // Write requirements.md
    await sandbox.writeFiles([
      { path: "requirements.md", content: Buffer.from(requirementsMd) },
    ]);

    logger.info(
      { sandboxId: sandbox.sandboxId, branch },
      "sandbox_provisioned",
    );

    return sandbox;
  }

  async runEndHook(sandbox: SandboxInstance): Promise<EndHookResult> {
    try {
      const statusResult = await sandbox.runCommand("git", [
        "status",
        "--porcelain",
      ]);
      const status = (await statusResult.stdout()).trim();

      if (!status) return "clean";

      // Uncommitted changes exist — force commit
      await sandbox.runCommand("git", ["add", "-A"]);
      await sandbox.runCommand("git", [
        "commit",
        "-m",
        "wip: auto-commit uncommitted changes before sandbox teardown",
      ]);

      logger.info(
        { sandboxId: sandbox.sandboxId },
        "sandbox_end_hook_committed",
      );
      return "committed";
    } catch (err) {
      logger.warn(
        { sandboxId: sandbox.sandboxId, error: (err as Error).message },
        "sandbox_end_hook_error",
      );
      return "error";
    }
  }

  async extractChanges(
    sandbox: SandboxInstance,
  ): Promise<Array<{ path: string; content: string }>> {
    // Get list of changed files
    const diffResult = await sandbox.runCommand("git", [
      "diff",
      "--name-only",
      "HEAD~1",
      "HEAD",
    ]);
    const diffOutput = (await diffResult.stdout()).trim();
    if (!diffOutput) return [];

    const filePaths = diffOutput.split("\n").filter(Boolean);
    const files: Array<{ path: string; content: string }> = [];

    for (const filePath of filePaths) {
      const buf = await sandbox.readFileToBuffer({
        path: filePath,
        cwd: "/vercel/sandbox",
      });
      if (buf) {
        files.push({ path: filePath, content: buf.toString("utf-8") });
      }
    }
    return files;
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try {
      await sandbox.stop();
      logger.info(
        { sandboxId: sandbox.sandboxId },
        "sandbox_torn_down",
      );
    } catch (err) {
      logger.warn(
        { sandboxId: sandbox.sandboxId, error: (err as Error).message },
        "sandbox_teardown_failed",
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/sandbox/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "feat: implement sandbox manager with provision, end hook, and teardown"
```

---

### Task 12: Implementation Workflow

**Files:**
- Create: `src/workflows/implementation.ts`

- [ ] **Step 1: Implement the workflow**

```ts
// src/workflows/implementation.ts
import { logger } from "../lib/logger.js";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";

// --- Step Functions (full Node.js access, auto-retry) ---

async function fetchAndValidateTicket(ticketId: string, columnAi: string) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker } = createAdapters();
  const ticket = await issueTracker.fetchTicket(ticketId);

  if (ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null; // stale — ticket no longer in AI column
  }
  return ticket;
}

async function createFeatureBranch(branchName: string, baseBranch: string) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { vcs } = createAdapters();
  await vcs.createBranch(branchName, baseBranch);
}

async function assembleImplementationRequirements(ticket: TicketContent) {
  "use step";
  const { assembleImplementationContext } = await import("../sandbox/context.js");
  const { readFile } = await import("fs/promises");
  const prompt = await readFile(".blazebot/prompts/implement.md", "utf-8");
  return assembleImplementationContext({
    ticket: {
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
    },
    prompt,
  });
}

async function runAgentInSandbox(
  branchName: string,
  requirementsMd: string,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  "use step";
  const { parseEnv } = await import("../lib/env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { buildAgentCommand, parseAgentOutput } = await import(
    "../sandbox/agent-runner.js"
  );

  const env = parseEnv();
  const manager = new SandboxManager({
    githubToken: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  });

  const sandbox = await manager.provision(branchName, requirementsMd);

  try {
    const { cmd, args } = buildAgentCommand(env.CLAUDE_MODEL);
    const result = await sandbox.runCommand({ cmd, args, cwd: "/vercel/sandbox" });
    const stdout = await result.stdout();

    // Run end hook — force commit/discard uncommitted changes
    await manager.runEndHook(sandbox);

    // Extract changed files from sandbox (push happens outside, via VCS adapter)
    const files = await manager.extractChanges(sandbox);

    const output = parseAgentOutput(stdout);
    return { output, files };
  } catch (err) {
    await manager.runEndHook(sandbox).catch(() => {});
    const files = await manager.extractChanges(sandbox).catch(() => []);
    throw Object.assign(err as Error, { files });
  } finally {
    await manager.teardown(sandbox);
  }
}

async function pushChanges(
  branchName: string,
  files: Array<{ path: string; content: string }>,
) {
  "use step";
  if (files.length === 0) return;
  const { createAdapters } = await import("../lib/adapters.js");
  const { vcs } = createAdapters();
  await vcs.push(branchName, files);
}

async function createPullRequest(
  branchName: string,
  title: string,
  summary: string,
) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { vcs } = createAdapters();
  return vcs.createPR(branchName, title, summary);
}

async function moveTicketAndNotify(
  ticketId: string,
  column: string,
  message: string,
) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker, messaging } = createAdapters();
  await issueTracker.moveTicket(ticketId, column);
  await messaging.notify(message);
}

async function postClarificationAndNotify(
  ticketId: string,
  questions: string[],
  identifier: string,
  backlogColumn: string,
) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker, messaging } = createAdapters();
  const comment = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  await issueTracker.postComment(ticketId, comment);
  await issueTracker.moveTicket(ticketId, backlogColumn);
  await messaging.notify(`Task ${identifier} needs clarification`);
}

// --- Workflow (durable orchestration — no I/O directly here) ---

export async function implementationWorkflow(ticketId: string) {
  "use workflow";

  const { parseEnv } = await import("../lib/env.js");
  const env = parseEnv();

  // Step 1: Validate ticket is still in AI column
  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  // Step 2: Create feature branch
  const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
  await createFeatureBranch(branchName, env.GITHUB_BASE_BRANCH);

  // Step 3: Assemble context (in step — reads filesystem)
  const requirementsMd = await assembleImplementationRequirements(ticket);

  // Step 4: Run agent in sandbox
  const { output, files } = await runAgentInSandbox(branchName, requirementsMd);

  // Step 5: Push changes from outside the sandbox (spec Section 15.2)
  await pushChanges(branchName, files);

  // Step 6: Handle result
  if (output.result === "implemented") {
    await createPullRequest(branchName, ticket.title, output.summary ?? "");
    await moveTicketAndNotify(
      ticketId,
      env.COLUMN_AI_REVIEW,
      `Task ${ticket.identifier} PR ready for review`,
    );
    return;
  }

  if (output.result === "clarification_needed") {
    await postClarificationAndNotify(
      ticketId,
      output.questions ?? [],
      ticket.identifier,
      env.COLUMN_BACKLOG,
    );
    return;
  }

  // Failed — let workflow retry
  throw new Error(`Agent failed for ${ticketId}: ${output.error}`);
}
```

- [ ] **Step 2: Verify build**

Run: `npx nitro build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/implementation.ts
git commit -m "feat: implement durable implementation workflow with all steps"
```

---

### Task 13: Review-Fix Workflow

**Files:**
- Create: `src/workflows/review-fix.ts`

- [ ] **Step 1: Implement the workflow**

```ts
// src/workflows/review-fix.ts
import { FatalError } from "workflow";
import { logger } from "../lib/logger.js";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { PRComment } from "../adapters/vcs/types.js";

// --- Step Functions ---

async function fetchAndValidateTicket(ticketId: string, columnAi: string) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker } = createAdapters();
  const ticket = await issueTracker.fetchTicket(ticketId);

  if (ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) {
    return null;
  }
  return ticket;
}

async function fetchPRContext(branchName: string) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { vcs } = createAdapters();
  const pr = await vcs.findPR(branchName);
  if (!pr) throw new FatalError(`No open PR found for branch ${branchName}`);

  const comments = await vcs.getPRComments(pr.id);
  const hasConflicts = await vcs.getPRConflictStatus(pr.id);
  return { pr, comments, hasConflicts };
}

async function assembleReviewFixRequirements(
  ticket: TicketContent,
  prComments: PRComment[],
  hasConflicts: boolean,
) {
  "use step";
  const { assembleFixingFeedbackContext } = await import("../sandbox/context.js");
  const { readFile } = await import("fs/promises");
  const prompt = await readFile(".blazebot/prompts/review-fix.md", "utf-8");
  return assembleFixingFeedbackContext({
    ticket: {
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
    },
    prompt,
    prComments,
    hasConflicts,
  });
}

async function runFixingAgentInSandbox(
  branchName: string,
  requirementsMd: string,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  "use step";
  const { parseEnv } = await import("../lib/env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { buildAgentCommand, parseAgentOutput } = await import(
    "../sandbox/agent-runner.js"
  );

  const env = parseEnv();
  const manager = new SandboxManager({
    githubToken: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    vercelProjectId: env.VERCEL_PROJECT_ID,
  });

  const sandbox = await manager.provision(branchName, requirementsMd);

  try {
    const { cmd, args } = buildAgentCommand(env.CLAUDE_MODEL);
    const result = await sandbox.runCommand({ cmd, args, cwd: "/vercel/sandbox" });
    const stdout = await result.stdout();

    await manager.runEndHook(sandbox);
    const files = await manager.extractChanges(sandbox);
    const output = parseAgentOutput(stdout);
    return { output, files };
  } catch (err) {
    await manager.runEndHook(sandbox).catch(() => {});
    const files = await manager.extractChanges(sandbox).catch(() => []);
    throw Object.assign(err as Error, { files });
  } finally {
    await manager.teardown(sandbox);
  }
}

async function pushChanges(
  branchName: string,
  files: Array<{ path: string; content: string }>,
) {
  "use step";
  if (files.length === 0) return;
  const { createAdapters } = await import("../lib/adapters.js");
  const { vcs } = createAdapters();
  await vcs.push(branchName, files);
}

async function moveTicketAndNotify(
  ticketId: string,
  column: string,
  message: string,
) {
  "use step";
  const { createAdapters } = await import("../lib/adapters.js");
  const { issueTracker, messaging } = createAdapters();
  await issueTracker.moveTicket(ticketId, column);
  await messaging.notify(message);
}

// --- Workflow ---

export async function reviewFixWorkflow(
  ticketId: string,
  branchName: string,
) {
  "use workflow";

  const { parseEnv } = await import("../lib/env.js");
  const env = parseEnv();

  // Step 1: Validate ticket
  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  // Step 2: Fetch PR context
  const { pr, comments, hasConflicts } = await fetchPRContext(branchName);

  // Step 3: Assemble context (in step — reads filesystem)
  const requirementsMd = await assembleReviewFixRequirements(
    ticket,
    comments,
    hasConflicts,
  );

  // Step 4: Run agent in sandbox
  const { output, files } = await runFixingAgentInSandbox(branchName, requirementsMd);

  // Step 5: Push changes from outside sandbox
  await pushChanges(branchName, files);

  // Step 6: Handle result
  if (output.result === "implemented") {
    await moveTicketAndNotify(
      ticketId,
      env.COLUMN_AI_REVIEW,
      `Task ${ticket.identifier} fixes applied, ready for re-review`,
    );
    return;
  }

  // Failed — let workflow retry
  throw new Error(`Agent failed for ${ticketId}: ${output.error}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/review-fix.ts
git commit -m "feat: implement durable review-fix workflow"
```

---

### Task 14: Poller (Cron Route)

**Files:**
- Create: `src/routes/cron/poll.get.ts`

- [ ] **Step 1: Implement the poller**

```ts
// src/routes/cron/poll.get.ts
import { defineEventHandler, getHeader } from "h3";
import { start } from "workflow/api";
import { Sandbox } from "@vercel/sandbox";
import { parseEnv } from "../../lib/env.js";
import { createAdapters } from "../../lib/adapters.js";
import { implementationWorkflow } from "../../workflows/implementation.js";
import { reviewFixWorkflow } from "../../workflows/review-fix.js";
import { logger } from "../../lib/logger.js";

async function getActiveSandboxCount(): Promise<number> {
  try {
    const { json } = await Sandbox.list({ limit: 100 });
    return json.sandboxes.filter((s: any) => s.status === "running").length;
  } catch {
    return 0;
  }
}

export default defineEventHandler(async (event) => {
  const env = parseEnv();

  // Verify Vercel Cron auth
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      return { status: 401, error: "Unauthorized" };
    }
  }

  const { issueTracker, vcs } = createAdapters();

  // Search for tickets in AI column
  const jql = `project = ${env.JIRA_PROJECT_KEY} AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await issueTracker.searchTickets(jql);

  logger.info({ ticketCount: ticketKeys.length }, "poll_discovered_tickets");

  // Concurrency control (spec Section 8.2)
  const activeSandboxes = await getActiveSandboxCount();
  const availableSlots = Math.max(0, env.MAX_CONCURRENT_AGENTS - activeSandboxes);
  if (availableSlots === 0) {
    logger.info({ active: activeSandboxes, max: env.MAX_CONCURRENT_AGENTS }, "poll_at_capacity");
    return { status: "ok", discovered: ticketKeys.length, started: 0, reason: "at_capacity" };
  }

  const started: string[] = [];

  for (const key of ticketKeys) {
    if (started.length >= availableSlots) break; // respect concurrency limit

    try {
      const ticket = await issueTracker.fetchTicket(key);
      const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
      const existingPR = await vcs.findPR(branchName);

      // Deterministic dedup ID — start() is idempotent if a run with this ID is active
      if (existingPR) {
        const handle = await start(reviewFixWorkflow, [ticket.id, branchName], {
          id: `review-fix-${ticket.id}`,
        });
        logger.info(
          { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
          "workflow_started_review_fix",
        );
      } else {
        const handle = await start(implementationWorkflow, [ticket.id], {
          id: `implementation-${ticket.id}`,
        });
        logger.info(
          { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
          "workflow_started_implementation",
        );
      }

      started.push(ticket.identifier);
    } catch (err) {
      logger.warn(
        { ticketKey: key, error: (err as Error).message },
        "poll_ticket_dispatch_error",
      );
    }
  }

  return { status: "ok", discovered: ticketKeys.length, started: started.length };
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/cron/poll.get.ts
git commit -m "feat: implement Vercel Cron poller that discovers tickets and dispatches workflows"
```

---

### Task 15: Health Route + Workflow World Plugin

**Files:**
- Create: `src/routes/health.get.ts`
- Create: `src/plugins/workflow-world.ts`

- [ ] **Step 1: Create health route**

```ts
// src/routes/health.get.ts
import { defineEventHandler } from "h3";

export default defineEventHandler(() => {
  return { status: "ok", timestamp: new Date().toISOString() };
});
```

- [ ] **Step 2: Create workflow world plugin**

```ts
// src/plugins/workflow-world.ts
import { defineNitroPlugin } from "nitropack/runtime";

export default defineNitroPlugin(async () => {
  // Skip in serverless — Vercel handles the workflow runtime automatically
  if (process.env.VERCEL || process.env.SERVERLESS) return;

  // For local dev: boot the workflow world (requires WORKFLOW_POSTGRES_URL)
  try {
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  } catch (err) {
    console.warn("Workflow world not started:", (err as Error).message);
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/health.get.ts src/plugins/workflow-world.ts
git commit -m "feat: add health route and workflow world plugin"
```

---

### Task 16: Prompt Files

**Files:**
- Create: `.blazebot/prompts/implement.md`
- Create: `.blazebot/prompts/review-fix.md`

- [ ] **Step 1: Create implementation prompt**

```markdown
<!-- .blazebot/prompts/implement.md -->
# Instructions

You are an AI coding agent implementing a feature based on the requirements above.

## Constraints

- Only modify files relevant to the ticket requirements.
- Do not refactor code outside the scope of the acceptance criteria.
- Do not make architectural changes unless explicitly requested.
- Follow existing code conventions in the repository (check CLAUDE.md, AGENTS.md if present).

## Process

1. Read and understand the requirements, description, and acceptance criteria.
2. Review existing code to understand the codebase structure.
3. Write tests first (TDD) — integration and e2e tests are required.
4. Implement the feature to make tests pass.
5. Run all tests to ensure nothing is broken.
6. Self-review your changes for quality, correctness, and completeness.
7. Commit your work with descriptive commit messages.

## Comment Overrides

If a ticket comment is prefixed with `[OVERRIDE]`, treat it as authoritative over any
prior conflicting instructions. The latest `[OVERRIDE]` comment takes precedence.

## Output

Return a JSON object with:
- `result`: "implemented" if done, "clarification_needed" if you have questions, "failed" if stuck.
- `summary`: Description of work done (when implemented).
- `questions`: List of questions (when clarification_needed).
- `error`: Failure details (when failed).
```

- [ ] **Step 2: Create review-fix prompt**

```markdown
<!-- .blazebot/prompts/review-fix.md -->
# Instructions

You are an AI coding agent fixing review feedback and resolving merge conflicts.

## Constraints

- Only address the specific review comments listed in PR Review Feedback.
- Do not refactor code outside the scope of the feedback.
- Do not make changes beyond what reviewers requested.
- Follow existing code conventions in the repository (check CLAUDE.md, AGENTS.md if present).

## Process

1. Read the review feedback carefully.
2. If merge conflicts exist, merge the target branch and resolve conflicts first.
3. Address each review comment — implement the requested changes.
4. Run all tests to ensure nothing is broken.
5. Self-review your changes.
6. Commit your work with descriptive commit messages.

## Comment Overrides

If a ticket comment is prefixed with `[OVERRIDE]`, treat it as authoritative over any
prior conflicting instructions. The latest `[OVERRIDE]` comment takes precedence.

## Output

Return a JSON object with:
- `result`: "implemented" if all feedback addressed, "failed" if stuck.
- `summary`: Description of fixes applied (when implemented).
- `error`: Failure details (when failed).
```

- [ ] **Step 3: Commit**

```bash
git add .blazebot/prompts/implement.md .blazebot/prompts/review-fix.md
git commit -m "feat: add agent prompt files for implementation and review-fix"
```

---

### Task 17: Final Verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 2: Run type check**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: Build completes with no errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final verification — all tests pass, types check, build succeeds"
```
