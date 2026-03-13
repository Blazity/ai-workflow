# Start New Work — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the full "ticket moved to AI" flow: webhook → orchestrator (DB lookup + dispatch) → BullMQ → worker → GitHub branch → Docker sandbox → Claude Code → PR creation or clarification.

**Architecture:** The router becomes an orchestrator — looking up ticket state in Postgres and dispatching the correct job type. The BullMQ worker fetches ticket content fresh from Jira REST API, reads `.blazebot/implement.md` from the repo via GitHub API, assembles `requirements.md` (spec Section 12 format), runs a Docker sandbox, and handles the result (PR creation, clarification, or failure). All external integrations go through the adapter interfaces already defined in `src/adapters/`.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45, BullMQ 5, Zod 3, @octokit/rest, dockerode, Vitest 4, TypeScript 5.9 (strict, ESM)

**Spec:** `docs/BLAZEBOT_SPEC.md`

---

## Existing Codebase State

Before starting, understand what already exists and is working:

| Component | Status | Location |
|-----------|--------|----------|
| Fastify app + `/webhooks/jira` route | Done | `src/index.ts` |
| HMAC signature verification | Done | `src/webhooks/jira.ts` |
| Jira webhook parsing → `NormalizedEvent` | Done | `src/webhooks/jira.ts` |
| Router (stub — only logs) | Stub | `src/webhooks/router.ts` |
| BullMQ queue (`ticketQueue`) | Done | `src/queue.ts` |
| BullMQ worker (stub — only logs) | Stub | `src/worker.ts` |
| Drizzle schema (`tickets`, `run_attempts`) | Done | `src/schema.ts` |
| DB client | Done | `src/db.ts` |
| Redis connection | Done | `src/redis.ts` |
| Env validation | Done | `src/env.ts` |
| Adapter interfaces (TicketAdapter, VCSAdapter, MessagingAdapter) | Interfaces only | `src/adapters/` |
| Docker Compose (Postgres + Redis) | Done | `docker-compose.yml` |

Key types already defined:

- `NormalizedEvent` in `src/adapters/ticket.ts`: `{ type: "ticket_moved", ticketId, fromColumn, toColumn, triggeredBy }`
- `Ticket`: `{ externalId, identifier, title, description, acceptanceCriteria, comments, labels }`
- `TicketAdapter`: `{ fetchTicket, moveTicket, postComment, parseWebhook }`
- `VCSAdapter`: `{ createBranch, createPR, getPRComments, getPRConflictStatus }`
- `MessagingAdapter`: `{ notify, ping }`
- `TicketJobData`: `{ ticketId, type: "implementation" | "review_fix" | "conflict_resolution" }`

---

## Chunk 1: Environment Variables

### Task 1: Add Missing Environment Variables

The current `src/env.ts` has `DATABASE_URL`, `REDIS_URL`, `JIRA_WEBHOOK_SECRET`, `COLUMN_AI`, `MAX_CONCURRENT_AGENTS`, `JOB_TIMEOUT_MS`, and adapter kind fields. We need to add credentials for Jira REST API, GitHub, Anthropic, additional column names, and sandbox config.

**Files:**
- Modify: `src/env.ts`
- Modify: `src/env.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing tests for new env vars**

Add these tests at the end of the existing `describe("env", ...)` block in `src/env.test.ts`:

```typescript
it("allows optional JIRA_BASE_URL", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.JIRA_BASE_URL).toBeUndefined();
});

it("parses JIRA_BASE_URL when set", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("JIRA_BASE_URL", "https://team.atlassian.net");

  const { env } = await import("./env.js");
  expect(env.JIRA_BASE_URL).toBe("https://team.atlassian.net");
});

it("uses default GITHUB_BASE_BRANCH of 'main'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.GITHUB_BASE_BRANCH).toBe("main");
});

it("uses default COLUMN_AI_REVIEW of 'AI Review'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.COLUMN_AI_REVIEW).toBe("AI Review");
});

it("uses default COLUMN_BACKLOG of 'Backlog'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.COLUMN_BACKLOG).toBe("Backlog");
});

it("uses default SANDBOX_MEMORY_MB of 4096", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.SANDBOX_MEMORY_MB).toBe(4096);
});

it("uses default DOCKER_IMAGE of 'blazebot-sandbox'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.DOCKER_IMAGE).toBe("blazebot-sandbox");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/env.test.ts`
Expected: FAIL — properties don't exist on env

- [ ] **Step 3: Add new env vars to `src/env.ts`**

Add inside the `server` object, after `JOB_TIMEOUT_MS`:

```typescript
JIRA_BASE_URL: z.string().url().optional(),
JIRA_USER_EMAIL: z.string().email().optional(),
JIRA_API_TOKEN: z.string().min(1).optional(),
GITHUB_TOKEN: z.string().min(1).optional(),
GITHUB_REPO_OWNER: z.string().min(1).optional(),
GITHUB_REPO_NAME: z.string().min(1).optional(),
GITHUB_BASE_BRANCH: z.string().default("main"),
ANTHROPIC_API_KEY: z.string().min(1).optional(),
COLUMN_AI_REVIEW: z.string().default("AI Review"),
COLUMN_BACKLOG: z.string().default("Backlog"),
DOCKER_IMAGE: z.string().default("blazebot-sandbox"),
SANDBOX_MEMORY_MB: z
  .string()
  .default("4096")
  .transform((v) => parseInt(v, 10))
  .pipe(z.number().int().positive()),
```

- [ ] **Step 4: Update `.env.example`**

Add after the existing vars:

```
# Jira REST API (required for worker)
# JIRA_BASE_URL=https://yourteam.atlassian.net
# JIRA_USER_EMAIL=
# JIRA_API_TOKEN=

# GitHub (required for worker)
# GITHUB_TOKEN=
# GITHUB_REPO_OWNER=
# GITHUB_REPO_NAME=
GITHUB_BASE_BRANCH=main

# Anthropic (required for worker)
# ANTHROPIC_API_KEY=

# Column names
COLUMN_AI_REVIEW=AI Review
COLUMN_BACKLOG=Backlog

# Sandbox config
DOCKER_IMAGE=blazebot-sandbox
SANDBOX_MEMORY_MB=4096
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/env.test.ts`
Expected: All PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/env.ts src/env.test.ts .env.example
git commit -m "feat: add env vars for Jira REST, GitHub, Anthropic, columns, and sandbox config"
```

---

## Chunk 2: Orchestrator (Router → DB-Aware Dispatch)

### Task 2: Update TicketJobData to Discriminated Union

The current `TicketJobData` uses `ticketId` and a type union. We need to expand it for proper dispatch context. The job payload carries only routing data — ticket content is fetched fresh by the worker at execution time (spec Section 4.1).

**Files:**
- Modify: `src/queue.ts`

- [ ] **Step 1: Update TicketJobData type**

Replace the type in `src/queue.ts`:

```typescript
export type TicketJobData =
  | {
      type: "implementation";
      ticketId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    }
  | {
      type: "review_fix";
      ticketId: string;
      source: "jira" | "linear";
      triggeredBy: string;
    };
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (worker.ts just logs `job.data`, so the type change is safe)

- [ ] **Step 3: Commit**

```bash
git add src/queue.ts
git commit -m "feat: expand TicketJobData to discriminated union with source and triggeredBy"
```

---

### Task 3: Rewrite Router as Orchestrator with DB Lookup

The current router is a stub that only logs. Per spec Section 8.1, it needs to:
- Look up ticket in the database to determine `workflow_state`
- Dispatch the correct job type based on state
- Handle terminal transitions (cancel active job)

**Files:**
- Modify: `src/webhooks/router.ts`
- Modify: `src/webhooks/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `src/webhooks/router.test.ts` entirely:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NormalizedEvent } from "./types.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
  })),
}));

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};
vi.mock("../db.js", () => ({
  db: new Proxy(mockDb, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return { ...actual, eq: vi.fn(), and: vi.fn() };
});

describe("routeTicketTransition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
  });

  const makeEvent = (from: string, to: string): NormalizedEvent => ({
    type: "ticket_moved",
    ticketId: "PROJ-42",
    fromColumn: from,
    toColumn: to,
    triggeredBy: "Mia",
  });

  it("creates ticket record and enqueues implementation job for new ticket moved to AI", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "uuid-1" }]),
      }),
    });

    await routeTicketTransition(makeEvent("To Do", "AI"));

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "implementation",
      expect.objectContaining({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
      expect.objectContaining({ jobId: expect.stringContaining("PROJ-42") }),
    );
  });

  it("enqueues implementation job when ticket in clarification_pending moves to AI", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: "uuid-1", workflowState: "clarification_pending" },
        ]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition(makeEvent("Backlog", "AI"));

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "implementation",
      expect.objectContaining({ type: "implementation" }),
      expect.any(Object),
    );
  });

  it("enqueues review_fix job when ticket in awaiting_review moves to AI", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: "uuid-1", workflowState: "awaiting_review" },
        ]),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await routeTicketTransition(makeEvent("AI Review", "AI"));

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "review_fix",
      expect.objectContaining({ type: "review_fix" }),
      expect.any(Object),
    );
  });

  it("does not enqueue for transitions not targeting AI column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    await routeTicketTransition(makeEvent("To Do", "In Progress"));

    expect(ticketQueue.add).not.toHaveBeenCalled();
  });

  it("matches column names case-insensitively", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "uuid-1" }]),
      }),
    });

    await routeTicketTransition(makeEvent("To Do", "ai"));

    expect(ticketQueue.add).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: FAIL — current router returns void (not Promise), doesn't use DB

- [ ] **Step 3: Rewrite router implementation**

Replace `src/webhooks/router.ts`:

```typescript
import { eq, and } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../db.js";
import { tickets } from "../schema.js";
import { ticketQueue } from "../queue.js";
import type { NormalizedEvent } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function routeTicketTransition(
  event: NormalizedEvent,
): Promise<void> {
  const to = normalize(event.toColumn);
  const colAi = normalize(env.COLUMN_AI);

  if (to !== colAi) {
    return;
  }

  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.externalId, event.ticketId),
        eq(tickets.source, "jira"),
      ),
    );

  const ticket = existing[0];

  if (!ticket) {
    const [created] = await db
      .insert(tickets)
      .values({
        externalId: event.ticketId,
        identifier: event.ticketId,
        source: "jira",
        state: event.toColumn,
        workflowState: "queued",
        assignee: event.triggeredBy,
      })
      .returning();

    await ticketQueue.add(
      "implementation",
      {
        type: "implementation",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `impl-${event.ticketId}-${created!.id}` },
    );
    return;
  }

  if (ticket.workflowState === "clarification_pending") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await ticketQueue.add(
      "implementation",
      {
        type: "implementation",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `impl-${event.ticketId}-${ticket.id}` },
    );
    return;
  }

  if (ticket.workflowState === "awaiting_review") {
    await db
      .update(tickets)
      .set({ workflowState: "queued", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await ticketQueue.add(
      "review_fix",
      {
        type: "review_fix",
        ticketId: event.ticketId,
        source: "jira",
        triggeredBy: event.triggeredBy,
      },
      { jobId: `fix-${event.ticketId}-${ticket.id}` },
    );
    return;
  }
}
```

- [ ] **Step 4: Update `src/index.ts` for async router**

The router is now async. Update the webhook handler in `src/index.ts` — change the call from:

```typescript
const event = parseJiraWebhook(request.body);
if (event) {
  routeTicketTransition(event);
}
```

to:

```typescript
const event = parseJiraWebhook(request.body);
if (event) {
  await routeTicketTransition(event);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: All PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All PASS. The `src/index.test.ts` may need mock updates for drizzle-orm — add mocks if tests fail:

```typescript
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));
vi.mock("postgres", () => ({ default: vi.fn() }));
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/webhooks/router.ts src/webhooks/router.test.ts src/index.ts
git commit -m "feat: rewrite router as orchestrator with DB lookup and BullMQ dispatch"
```

---

## Chunk 3: Jira REST Client (TicketAdapter Implementation)

### Task 4: Install No New Dependencies

The Jira client uses `fetch` (built into Node 20+) and the existing `Ticket`/`TicketAdapter` types. No new packages needed.

### Task 5: Implement Jira Client

**Files:**
- Create: `src/adapters/jira-client.ts`
- Create: `src/adapters/jira-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/jira-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraClient } from "./jira-client.js";

describe("JiraClient", () => {
  const baseUrl = "https://team.atlassian.net";
  const email = "bot@team.com";
  const apiToken = "test-token";
  let client: JiraClient;

  beforeEach(() => {
    client = new JiraClient(baseUrl, email, apiToken);
    vi.restoreAllMocks();
  });

  describe("fetchTicket", () => {
    it("fetches ticket and maps to Ticket interface", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            key: "PROJ-42",
            fields: {
              summary: "Add dark mode",
              description: "Implement dark mode across all pages",
              comment: {
                comments: [
                  {
                    author: { displayName: "Alice" },
                    body: "Use CSS variables",
                    created: "2026-03-10T10:00:00.000+0000",
                  },
                ],
              },
              labels: ["frontend", "ui"],
            },
          }),
          { status: 200 },
        ),
      );

      const ticket = await client.fetchTicket("PROJ-42");

      expect(ticket.externalId).toBe("PROJ-42");
      expect(ticket.identifier).toBe("PROJ-42");
      expect(ticket.title).toBe("Add dark mode");
      expect(ticket.description).toBe("Implement dark mode across all pages");
      expect(ticket.labels).toEqual(["frontend", "ui"]);
      expect(ticket.comments).toHaveLength(1);
      expect(ticket.comments[0]!.author).toBe("Alice");
    });

    it("handles Atlassian Document Format description", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            key: "PROJ-42",
            fields: {
              summary: "Title",
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "ADF description" }],
                  },
                ],
              },
              comment: { comments: [] },
              labels: [],
            },
          }),
          { status: 200 },
        ),
      );

      const ticket = await client.fetchTicket("PROJ-42");
      expect(ticket.description).toBe("ADF description");
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      );

      await expect(client.fetchTicket("PROJ-999")).rejects.toThrow(
        "Jira API error: 404",
      );
    });
  });

  describe("postComment", () => {
    it("posts an ADF-formatted comment", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id: "123" }), { status: 201 }),
      );

      await client.postComment("PROJ-42", "Need clarification on X");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/comment",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: expect.stringContaining("Basic "),
          }),
          body: JSON.stringify({
            body: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Need clarification on X" },
                  ],
                },
              ],
            },
          }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      );

      await expect(
        client.postComment("PROJ-999", "text"),
      ).rejects.toThrow("Jira API error: 404");
    });
  });

  describe("moveTicket", () => {
    it("fetches transitions then posts the matching one", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              transitions: [
                { id: "11", name: "Backlog" },
                { id: "21", name: "AI Review" },
              ],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.moveTicket("PROJ-42", "AI Review");

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/transitions",
        expect.objectContaining({ method: "GET" }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/transitions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ transition: { id: "21" } }),
        }),
      );
    });

    it("throws when no matching transition found", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [{ id: "11", name: "Done" }],
          }),
          { status: 200 },
        ),
      );

      await expect(
        client.moveTicket("PROJ-42", "AI Review"),
      ).rejects.toThrow("No transition found matching 'AI Review'");
    });
  });

  describe("parseWebhook", () => {
    it("delegates to parseJiraWebhook (tested separately)", () => {
      const result = client.parseWebhook({
        user: { accountId: "abc", displayName: "Mia" },
        issue: { key: "PROJ-1" },
        changelog: {
          items: [
            {
              field: "status",
              fieldtype: "jira",
              fromString: "To Do",
              toString: "AI",
            },
          ],
        },
      });

      expect(result).toEqual({
        type: "ticket_moved",
        ticketId: "PROJ-1",
        fromColumn: "To Do",
        toColumn: "AI",
        triggeredBy: "Mia",
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/jira-client.test.ts`
Expected: FAIL — cannot resolve `./jira-client.js`

- [ ] **Step 3: Implement JiraClient**

Create `src/adapters/jira-client.ts`:

```typescript
import { parseJiraWebhook } from "../webhooks/jira.js";
import type { NormalizedEvent, Ticket, TicketAdapter, TicketComment } from "./ticket.js";

export class JiraClient implements TicketAdapter {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  private async request(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
        ...options.headers,
      },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Jira API error: ${res.status}`);
    }
    return res;
  }

  async fetchTicket(id: string): Promise<Ticket> {
    const res = await this.request(
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels`,
    );
    const data = await res.json();
    return {
      externalId: data.key,
      identifier: data.key,
      title: data.fields.summary,
      description: this.extractText(data.fields.description),
      acceptanceCriteria: null,
      comments: (data.fields.comment?.comments ?? []).map(
        (c: {
          author: { displayName: string };
          body: unknown;
          created: string;
        }): TicketComment => ({
          author: c.author.displayName,
          body: typeof c.body === "string" ? c.body : this.extractText(c.body),
          createdAt: new Date(c.created),
        }),
      ),
      labels: data.fields.labels ?? [],
    };
  }

  async moveTicket(id: string, column: string): Promise<void> {
    const res = await this.request(
      `/rest/api/3/issue/${id}/transitions`,
      { method: "GET" },
    );
    const data = await res.json();
    const transition = data.transitions.find(
      (t: { name: string }) =>
        t.name.toLowerCase() === column.toLowerCase(),
    );
    if (!transition) {
      throw new Error(`No transition found matching '${column}'`);
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

  parseWebhook(req: unknown): NormalizedEvent | null {
    return parseJiraWebhook(req);
  }

  private extractText(adf: unknown): string {
    if (typeof adf === "string") return adf;
    if (!adf || typeof adf !== "object") return "";
    const node = adf as { content?: unknown[] };
    if (!node.content) return "";
    return node.content
      .map((child: unknown) => {
        const c = child as { text?: string; content?: unknown[] };
        if (c.text) return c.text;
        if (c.content) return this.extractText(child);
        return "";
      })
      .join("");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/jira-client.test.ts`
Expected: All PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/adapters/jira-client.ts src/adapters/jira-client.test.ts
git commit -m "feat: add JiraClient implementing TicketAdapter interface"
```

---

## Chunk 4: GitHub Client (VCSAdapter Implementation)

### Task 6: Install @octokit/rest

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependency**

Run: `pnpm add @octokit/rest`

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @octokit/rest dependency"
```

---

### Task 7: Implement GitHub Client

The `VCSAdapter` interface defines `createBranch`, `createPR`, `getPRComments`, `getPRConflictStatus`. We also need `getFileContent` to read `.blazebot/implement.md` from the repo (spec Section 5). This is an additional method beyond the interface, specific to the GitHub implementation.

**Files:**
- Create: `src/adapters/github-client.ts`
- Create: `src/adapters/github-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/github-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    git: {
      getRef: vi.fn(),
      createRef: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
      listReviewComments: vi.fn(),
      get: vi.fn(),
    },
    repos: {
      getContent: vi.fn(),
    },
  })),
}));

describe("GitHubClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a branch from base branch SHA", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.git.getRef.mockResolvedValue({
      data: { object: { sha: "abc123" } },
    });
    mockInstance.git.createRef.mockResolvedValue({ data: {} });

    await client.createBranch("owner", "repo", "blazebot/PROJ-42", "main");

    expect(mockInstance.git.getRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "heads/main",
    });
    expect(mockInstance.git.createRef).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      ref: "refs/heads/blazebot/PROJ-42",
      sha: "abc123",
    });
  });

  it("silently succeeds when branch already exists (422)", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.git.getRef.mockResolvedValue({
      data: { object: { sha: "abc123" } },
    });
    mockInstance.git.createRef.mockRejectedValue(
      Object.assign(new Error("Reference already exists"), { status: 422 }),
    );

    await client.createBranch("owner", "repo", "blazebot/PROJ-42", "main");
  });

  it("creates a pull request", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.create.mockResolvedValue({
      data: { number: 42, html_url: "https://github.com/owner/repo/pull/42" },
    });

    const pr = await client.createPR(
      "owner",
      "repo",
      "feat: add dark mode",
      "Implements dark mode",
      "blazebot/PROJ-42",
      "main",
    );

    expect(pr).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
  });

  it("getFileContent returns decoded file content", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.repos.getContent.mockResolvedValue({
      data: {
        type: "file",
        content: Buffer.from("You are an agent.").toString("base64"),
        encoding: "base64",
      },
    });

    const content = await client.getFileContent(
      "owner",
      "repo",
      ".blazebot/implement.md",
      "main",
    );
    expect(content).toBe("You are an agent.");
  });

  it("getFileContent returns null when file not found", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.repos.getContent.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    const content = await client.getFileContent(
      "owner",
      "repo",
      ".blazebot/missing.md",
      "main",
    );
    expect(content).toBeNull();
  });

  it("getPRComments returns formatted comments", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.listReviewComments.mockResolvedValue({
      data: [
        {
          user: { login: "reviewer" },
          body: "Fix this",
          path: "src/app.ts",
          line: 42,
        },
      ],
    });

    const comments = await client.getPRComments("owner", "repo", 1);

    expect(comments).toEqual([
      {
        author: "reviewer",
        body: "Fix this",
        path: "src/app.ts",
        line: 42,
        fromApprovedReview: false,
      },
    ]);
  });

  it("getPRConflictStatus returns true when mergeable is false", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.get.mockResolvedValue({
      data: { mergeable: false },
    });

    const hasConflicts = await client.getPRConflictStatus("owner", "repo", 1);
    expect(hasConflicts).toBe(true);
  });

  it("getPRConflictStatus returns false when mergeable is true", async () => {
    const { Octokit } = await import("@octokit/rest");
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
    mockInstance.pulls.get.mockResolvedValue({
      data: { mergeable: true },
    });

    const hasConflicts = await client.getPRConflictStatus("owner", "repo", 1);
    expect(hasConflicts).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/github-client.test.ts`
Expected: FAIL — cannot resolve `./github-client.js`

- [ ] **Step 3: Implement GitHubClient**

Create `src/adapters/github-client.ts`:

```typescript
import { Octokit } from "@octokit/rest";
import type {
  PullRequest,
  PullRequestComment,
  VCSAdapter,
} from "./source-control.js";

export class GitHubClient implements VCSAdapter {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async createBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void> {
    const { data: ref } = await this.octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${baseBranch}`,
    });

    try {
      await this.octokit.git.createRef({
        owner: repoOwner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 422) return;
      throw err;
    }
  }

  async createPR(
    repoOwner: string,
    repoName: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.create({
      owner: repoOwner,
      repo: repoName,
      title,
      body,
      head,
      base,
    });

    return { number: data.number, url: data.html_url };
  }

  async getPRComments(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<PullRequestComment[]> {
    const { data } = await this.octokit.pulls.listReviewComments({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
    });

    return data.map(
      (c): PullRequestComment => ({
        author: c.user?.login ?? "unknown",
        body: c.body,
        path: c.path ?? null,
        line: c.line ?? null,
        fromApprovedReview: false,
      }),
    );
  }

  async getPRConflictStatus(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<boolean> {
    const { data } = await this.octokit.pulls.get({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
    });

    return data.mergeable === false;
  }

  async getFileContent(
    repoOwner: string,
    repoName: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path,
        ref,
      });
      if ("content" in data && data.type === "file") {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return null;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 404) return null;
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/github-client.test.ts`
Expected: All PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github-client.ts src/adapters/github-client.test.ts
git commit -m "feat: add GitHubClient implementing VCSAdapter with getFileContent"
```

---

## Chunk 5: Docker Sandbox Manager

### Task 8: Create Sandbox Docker Image Files

**Files:**
- Create: `docker/sandbox/Dockerfile`
- Create: `docker/sandbox/entrypoint.sh`
- Create: `docker/sandbox/git-guard.sh`

> **Spec alignment (Sections 5, 9, 10, 12):** The agent prompt lives in the target repo at `.blazebot/implement.md`. The marker file is `.blazebot/output.json`. Exit codes: 0=success, 1=failure, 2=clarification. The entrypoint copies `requirements.md` (injected by orchestrator) into the workspace.

- [ ] **Step 1: Create the Dockerfile**

Create `docker/sandbox/Dockerfile`:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
RUN chmod +x /entrypoint.sh /usr/local/bin/git

ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 2: Create entrypoint.sh**

Create `docker/sandbox/entrypoint.sh`:

```bash
#!/bin/bash
set -e

/usr/bin/git clone --branch "$BLAZEBOT_BRANCH" --single-branch \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo

cd /workspace/repo

cp /inject/requirements.md ./requirements.md

if [ ! -f .blazebot/implement.md ]; then
  mkdir -p .blazebot
  echo '{"summary":"","questions":[],"error":".blazebot/implement.md not found in repo"}' > .blazebot/output.json
  exit 1
fi

mkdir -p .blazebot

CLAUDE_EXIT=0
claude -p "$(cat requirements.md)" --dangerously-skip-permissions || CLAUDE_EXIT=$?

if [ ! -f .blazebot/output.json ]; then
  echo '{"summary":"","questions":[],"error":"Agent exited without writing .blazebot/output.json"}' > .blazebot/output.json
fi

exit $CLAUDE_EXIT
```

- [ ] **Step 3: Create git-guard.sh**

Create `docker/sandbox/git-guard.sh`:

```bash
#!/bin/bash
REAL_GIT=/usr/bin/git

case "$1" in
  checkout|switch)
    echo "ERROR: Branch switching is not allowed. You are on $BLAZEBOT_BRANCH." >&2
    exit 1
    ;;
  push)
    for arg in "$@"; do
      if [ "$arg" = "$BLAZEBOT_BRANCH" ] || [ "$arg" = "origin" ] || [ "$arg" = "push" ]; then
        continue
      fi
      if echo "$arg" | grep -q ":" && ! echo "$arg" | grep -q "$BLAZEBOT_BRANCH"; then
        echo "ERROR: You can only push to $BLAZEBOT_BRANCH." >&2
        exit 1
      fi
    done
    $REAL_GIT "$@"
    ;;
  *)
    $REAL_GIT "$@"
    ;;
esac
```

- [ ] **Step 4: Commit**

```bash
git add docker/sandbox/
git commit -m "feat: add Docker sandbox image (Dockerfile, entrypoint, git-guard)"
```

---

### Task 9: Install dockerode

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

Run: `pnpm add dockerode && pnpm add -D @types/dockerode`

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add dockerode dependency"
```

---

### Task 10: Implement Sandbox Manager

**Files:**
- Create: `src/sandbox/manager.ts`
- Create: `src/sandbox/manager.test.ts`

> **Spec alignment (Sections 9, 10):** Exit codes are the primary signal. Marker file is `.blazebot/output.json`. Container is destroyed after every run. `requirementsMd` is already fully assembled by the caller (worker).

- [ ] **Step 1: Write the failing tests**

Create `src/sandbox/manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("dockerode", () => {
  const mockContainer = {
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    getArchive: vi.fn(),
    remove: vi.fn(),
    kill: vi.fn(),
  };
  return {
    default: vi.fn().mockImplementation(() => ({
      createContainer: vi.fn().mockResolvedValue(mockContainer),
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/blazebot-abc"),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

function createMockTarStream(content: string) {
  const { Readable } = require("node:stream");
  const header = Buffer.alloc(512, 0);
  const contentBuf = Buffer.from(content, "utf-8");
  const stream = new Readable({
    read() {
      this.push(Buffer.concat([header, contentBuf]));
      this.push(null);
    },
  });
  return stream;
}

describe("runSandbox", () => {
  const defaultOptions = {
    image: "blazebot-sandbox",
    branchName: "blazebot/PROJ-42",
    requirementsMd: "# Requirements\n\n## Ticket\nDo the thing\n\n---\nYou are an agent...",
    githubToken: "ghp_test",
    repoUrl: "owner/repo",
    anthropicApiKey: "sk-ant-test",
    timeoutMs: 30000,
    memoryLimitMb: 4096,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates container with correct env and memory limit", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "Done", questions: [], error: "" }),
      ),
    );

    await runSandbox(defaultOptions);

    expect(mockInstance.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: "blazebot-sandbox",
        Env: expect.arrayContaining([
          "BLAZEBOT_BRANCH=blazebot/PROJ-42",
          "GITHUB_TOKEN=ghp_test",
          "REPO_URL=owner/repo",
          "ANTHROPIC_API_KEY=sk-ant-test",
        ]),
        HostConfig: expect.objectContaining({
          Memory: 4096 * 1024 * 1024,
        }),
      }),
    );
  });

  it("returns complete on exit code 0", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({
          summary: "Implemented dark mode",
          questions: [],
          error: "",
        }),
      ),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 0,
      status: "complete",
      summary: "Implemented dark mode",
    });
  });

  it("returns clarification_needed on exit code 2", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.wait.mockResolvedValue({ StatusCode: 2 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({
          summary: "",
          questions: ["What color scheme?"],
          error: "",
        }),
      ),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 2,
      status: "clarification_needed",
      questions: ["What color scheme?"],
    });
  });

  it("returns failed on exit code 1", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "", questions: [], error: "Tests failed" }),
      ),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 1,
      status: "failed",
      error: "Tests failed",
    });
  });

  it("returns failed when marker file is missing", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    mockContainer.getArchive.mockRejectedValue(new Error("file not found"));

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      exitCode: 1,
      status: "failed",
      error: expect.stringContaining(".blazebot/output.json"),
    });
  });

  it("returns failed on timeout and kills container", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.wait.mockReturnValue(new Promise(() => {}));

    const result = await runSandbox({ ...defaultOptions, timeoutMs: 50 });

    expect(result).toEqual({
      exitCode: -1,
      status: "failed",
      error: expect.stringContaining("timeout"),
    });
    expect(mockContainer.kill).toHaveBeenCalled();
  });

  it("removes container after execution", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.wait.mockResolvedValue({ StatusCode: 0 });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(
        JSON.stringify({ summary: "Done", questions: [], error: "" }),
      ),
    );

    await runSandbox(defaultOptions);

    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
  });

  it("cleans up container even when start fails", async () => {
    const Docker = (await import("dockerode")).default;
    const fs = await import("node:fs/promises");
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.start.mockRejectedValue(new Error("Docker daemon error"));

    const result = await runSandbox(defaultOptions);

    expect(result.status).toBe("failed");
    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    expect(fs.rm).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: FAIL — cannot resolve `./manager.js`

- [ ] **Step 3: Implement Sandbox Manager**

Create `src/sandbox/manager.ts`:

```typescript
import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SandboxOptions {
  image: string;
  branchName: string;
  requirementsMd: string;
  githubToken: string;
  repoUrl: string;
  anthropicApiKey: string;
  timeoutMs: number;
  memoryLimitMb: number;
}

export type SandboxResult = {
  exitCode: number;
  status: "complete" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
};

const docker = new Docker();

export async function runSandbox(
  options: SandboxOptions,
): Promise<SandboxResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "blazebot-"));
  await writeFile(join(tmpDir, "requirements.md"), options.requirementsMd);

  let container: Docker.Container | null = null;

  try {
    container = await docker.createContainer({
      Image: options.image,
      Env: [
        `BLAZEBOT_BRANCH=${options.branchName}`,
        `GITHUB_TOKEN=${options.githubToken}`,
        `REPO_URL=${options.repoUrl}`,
        `ANTHROPIC_API_KEY=${options.anthropicApiKey}`,
      ],
      HostConfig: {
        Memory: options.memoryLimitMb * 1024 * 1024,
        Binds: [`${tmpDir}:/inject:ro`],
      },
    });

    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Sandbox timeout exceeded")),
        options.timeoutMs,
      ),
    );

    let exitCode: number;
    try {
      const result = await Promise.race([waitPromise, timeoutPromise]);
      exitCode = result.StatusCode;
    } catch {
      if (container) {
        try {
          await container.kill();
        } catch {
          /* may already be stopped */
        }
      }
      return {
        exitCode: -1,
        status: "failed",
        error: "Sandbox timeout exceeded",
      };
    }

    return await readResult(container, exitCode);
  } catch (err) {
    return {
      exitCode: -1,
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        /* best effort */
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function readResult(
  container: Docker.Container,
  exitCode: number,
): Promise<SandboxResult> {
  let output: { summary?: string; questions?: string[]; error?: string } = {};

  try {
    const archive = await container.getArchive({
      path: "/workspace/repo/.blazebot/output.json",
    });
    const content = await streamToString(archive);
    output = JSON.parse(content);
  } catch {
    return {
      exitCode,
      status: "failed",
      error: "Failed to read .blazebot/output.json from container",
    };
  }

  switch (exitCode) {
    case 0:
      return { exitCode, status: "complete", summary: output.summary ?? "" };
    case 2:
      return {
        exitCode,
        status: "clarification_needed",
        questions: output.questions ?? [],
      };
    default:
      return {
        exitCode,
        status: "failed",
        error: output.error ?? `Agent exited with code ${exitCode}`,
      };
  }
}

async function streamToString(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const content = buffer.subarray(512);
  const nullIndex = content.indexOf(0);
  return content
    .subarray(0, nullIndex > 0 ? nullIndex : content.length)
    .toString("utf-8");
}
```

- [ ] **Step 4: Run tests — iterate on mock/tar setup**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: Adjust mocks as needed until all PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "feat: add sandbox manager with exit-code-driven container lifecycle"
```

---

## Chunk 6: Context Assembly

### Task 11: Implement Context Assembly Module

Context assembly builds `requirements.md` per spec Section 12 format. This is a pure function — easy to test independently.

**Files:**
- Create: `src/context.ts`
- Create: `src/context.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/context.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { assembleImplementationContext } from "./context.js";

describe("assembleImplementationContext", () => {
  it("assembles full context in spec Section 12 format", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "Add dark mode",
        description: "Implement dark mode across all pages",
        acceptanceCriteria: "All pages support dark theme",
        comments: [
          {
            author: "Alice",
            body: "Use CSS variables",
            createdAt: new Date("2026-03-10T10:00:00Z"),
          },
        ],
        labels: ["frontend"],
      },
      "You are an agent. Implement the feature using TDD.",
    );

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket\nAdd dark mode");
    expect(result).toContain("## Description\nImplement dark mode across all pages");
    expect(result).toContain("## Acceptance Criteria\nAll pages support dark theme");
    expect(result).toContain("## Comments");
    expect(result).toContain("**Alice**");
    expect(result).toContain("Use CSS variables");
    expect(result).toContain("---");
    expect(result).toContain("You are an agent. Implement the feature using TDD.");
  });

  it("omits acceptance criteria when null", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "Title",
        description: "Desc",
        acceptanceCriteria: null,
        comments: [],
        labels: [],
      },
      "prompt",
    );

    expect(result).not.toContain("## Acceptance Criteria");
  });

  it("omits comments section when empty", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "Title",
        description: "Desc",
        acceptanceCriteria: null,
        comments: [],
        labels: [],
      },
      "prompt",
    );

    expect(result).not.toContain("## Comments");
  });

  it("always ends with prompt content after separator", () => {
    const result = assembleImplementationContext(
      {
        externalId: "PROJ-42",
        identifier: "PROJ-42",
        title: "T",
        description: "D",
        acceptanceCriteria: null,
        comments: [],
        labels: [],
      },
      "Do TDD",
    );

    const lines = result.split("\n");
    const separatorIdx = lines.indexOf("---");
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(lines.slice(separatorIdx + 1).join("\n")).toContain("Do TDD");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/context.test.ts`
Expected: FAIL — cannot resolve `./context.js`

- [ ] **Step 3: Implement context assembly**

Create `src/context.ts`:

```typescript
import type { Ticket } from "./adapters/ticket.js";

export function assembleImplementationContext(
  ticket: Ticket,
  promptFileContent: string,
): string {
  const lines = [
    "# Requirements",
    "",
    "## Ticket",
    ticket.title,
    "",
    "## Description",
    ticket.description,
  ];

  if (ticket.acceptanceCriteria) {
    lines.push("", "## Acceptance Criteria", ticket.acceptanceCriteria);
  }

  if (ticket.comments.length > 0) {
    lines.push("", "## Comments");
    for (const comment of ticket.comments) {
      lines.push(
        "",
        `**${comment.author}** (${comment.createdAt.toISOString()}):`,
        comment.body,
      );
    }
  }

  lines.push("", "---", promptFileContent);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/context.test.ts`
Expected: All PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/context.ts src/context.test.ts
git commit -m "feat: add context assembly module (spec Section 12 format)"
```

---

## Chunk 7: Worker Implementation

### Task 12: Implement Worker Orchestration

The worker is the core orchestration handler. Per spec Sections 4.1, 7.1, 8.3, 9.2, 10.3, 12, it:
1. Guards old-format jobs
2. Fetches ticket content fresh from Jira REST API (spec Section 4.1)
3. Reads `.blazebot/implement.md` from the repo via GitHub API (spec Section 5)
4. Assembles `requirements.md` via context module (spec Section 12)
5. Creates branch, upserts ticket in DB, creates run attempt record
6. Runs sandbox and handles exit codes (spec Section 10.3)

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `src/worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { TicketJobData } from "./queue.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation((_name: string, handler: Function) => {
    return { handler, close: vi.fn() };
  }),
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "ticket-uuid" }]),
        }),
        returning: vi.fn().mockResolvedValue([{ id: "run-uuid" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }),
}));
vi.mock("postgres", () => ({ default: vi.fn() }));

const mockRunSandbox = vi.fn();
vi.mock("./sandbox/manager.js", () => ({
  runSandbox: (...args: unknown[]) => mockRunSandbox(...args),
}));

const mockGitHub = {
  createBranch: vi.fn(),
  createPR: vi.fn().mockResolvedValue({
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
  }),
  getPRComments: vi.fn(),
  getPRConflictStatus: vi.fn(),
  getFileContent: vi.fn().mockResolvedValue("You are an agent. Use TDD."),
};
vi.mock("./adapters/github-client.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => mockGitHub),
}));

const mockJira = {
  fetchTicket: vi.fn(),
  postComment: vi.fn(),
  moveTicket: vi.fn(),
  parseWebhook: vi.fn(),
};
vi.mock("./adapters/jira-client.js", () => ({
  JiraClient: vi.fn().mockImplementation(() => mockJira),
}));

describe("worker handler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("JIRA_BASE_URL", "https://team.atlassian.net");
    vi.stubEnv("JIRA_USER_EMAIL", "bot@team.com");
    vi.stubEnv("JIRA_API_TOKEN", "jira-token");
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("GITHUB_REPO_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO_NAME", "repo");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.clearAllMocks();
  });

  const makeJob = (data: TicketJobData): Job<TicketJobData> =>
    ({ data, name: data.type }) as Job<TicketJobData>;

  it("fetches ticket, creates branch, runs sandbox, creates PR on exit 0", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "Add dark mode",
      description: "Implement dark mode across all pages",
      acceptanceCriteria: null,
      comments: [
        { author: "Alice", body: "Use CSS variables", createdAt: new Date("2026-03-10") },
      ],
      labels: ["frontend"],
    });
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Implemented dark mode",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockJira.fetchTicket).toHaveBeenCalledWith("PROJ-42");
    expect(mockGitHub.getFileContent).toHaveBeenCalledWith(
      "owner", "repo", ".blazebot/implement.md", "main",
    );
    expect(mockGitHub.createBranch).toHaveBeenCalledWith(
      "owner", "repo", "blazebot/PROJ-42", "main",
    );
    expect(mockRunSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "blazebot/PROJ-42",
        requirementsMd: expect.stringContaining("## Ticket"),
      }),
    );
    expect(mockGitHub.createPR).toHaveBeenCalled();
    expect(mockJira.moveTicket).toHaveBeenCalledWith("PROJ-42", "AI Review");
  });

  it("posts questions and moves to backlog on exit 2", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "Add dark mode",
      description: "Implement dark mode",
      acceptanceCriteria: null,
      comments: [],
      labels: [],
    });
    mockRunSandbox.mockResolvedValue({
      exitCode: 2,
      status: "clarification_needed",
      questions: ["What color scheme?"],
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "implementation",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockJira.postComment).toHaveBeenCalledWith(
      "PROJ-42",
      expect.stringContaining("What color scheme?"),
    );
    expect(mockJira.moveTicket).toHaveBeenCalledWith("PROJ-42", "Backlog");
  });

  it("throws on exit 1 so BullMQ retries", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "Add dark mode",
      description: "Implement dark mode",
      acceptanceCriteria: null,
      comments: [],
      labels: [],
    });
    mockRunSandbox.mockResolvedValue({
      exitCode: 1,
      status: "failed",
      error: "Tests failed to compile",
    });

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
    ).rejects.toThrow();

    expect(mockGitHub.createPR).not.toHaveBeenCalled();
  });

  it("fails immediately when .blazebot/implement.md is missing", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      externalId: "PROJ-42",
      identifier: "PROJ-42",
      title: "T",
      description: "D",
      acceptanceCriteria: null,
      comments: [],
      labels: [],
    });
    mockGitHub.getFileContent.mockResolvedValue(null);

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
    ).rejects.toThrow(".blazebot/implement.md");

    expect(mockRunSandbox).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker.test.ts`
Expected: FAIL — current worker just logs

- [ ] **Step 3: Implement the worker**

Replace `src/worker.ts`:

```typescript
import { Worker, Job } from "bullmq";
import { eq } from "drizzle-orm";
import { createRedisConnection } from "./redis.js";
import { env } from "./env.js";
import { db } from "./db.js";
import { tickets, runAttempts } from "./schema.js";
import { JiraClient } from "./adapters/jira-client.js";
import { GitHubClient } from "./adapters/github-client.js";
import { runSandbox } from "./sandbox/manager.js";
import { assembleImplementationContext } from "./context.js";
import type { TicketJobData } from "./queue.js";

function createAdapters() {
  const jira = new JiraClient(
    env.JIRA_BASE_URL!,
    env.JIRA_USER_EMAIL!,
    env.JIRA_API_TOKEN!,
  );
  const github = new GitHubClient(env.GITHUB_TOKEN!);
  return { jira, github };
}

export function createWorker(): Worker<TicketJobData> {
  return new Worker<TicketJobData>(
    "ticket",
    async (job: Job<TicketJobData>) => {
      if (!("type" in job.data) || !("source" in job.data)) {
        console.warn("Skipping job with unrecognized format:", job.data);
        return;
      }

      if (job.data.type === "implementation") {
        await handleImplementation(job.data);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: env.MAX_CONCURRENT_AGENTS,
    },
  );
}

async function handleImplementation(data: Extract<TicketJobData, { type: "implementation" }>) {
  const { jira, github } = createAdapters();
  const owner = env.GITHUB_REPO_OWNER!;
  const repo = env.GITHUB_REPO_NAME!;
  const baseBranch = env.GITHUB_BASE_BRANCH;
  const branchName = `blazebot/${data.ticketId}`;

  const ticket = await jira.fetchTicket(data.ticketId);

  const promptContent = await github.getFileContent(
    owner, repo, ".blazebot/implement.md", baseBranch,
  );
  if (!promptContent) {
    throw new Error(
      `.blazebot/implement.md not found in ${owner}/${repo} on branch ${baseBranch}`,
    );
  }

  await github.createBranch(owner, repo, branchName, baseBranch);

  await db.update(tickets)
    .set({ workflowState: "implementing", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const [run] = await db.insert(runAttempts)
    .values({
      ticketId: (
        await db.select().from(tickets).where(eq(tickets.externalId, data.ticketId))
      )[0]!.id,
      type: "implementation",
      status: "running",
      branchName,
    })
    .returning();

  const requirementsMd = assembleImplementationContext(ticket, promptContent);

  const result = await runSandbox({
    image: env.DOCKER_IMAGE,
    branchName,
    requirementsMd,
    githubToken: env.GITHUB_TOKEN!,
    repoUrl: `${owner}/${repo}`,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    timeoutMs: env.JOB_TIMEOUT_MS,
    memoryLimitMb: env.SANDBOX_MEMORY_MB,
  });

  if (result.status === "complete") {
    const pr = await github.createPR(
      owner, repo,
      `[${data.ticketId}] ${ticket.title}`,
      result.summary ?? "",
      branchName, baseBranch,
    );

    await db.update(tickets)
      .set({
        workflowState: "awaiting_review",
        prId: String(pr.number),
        branchName,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    await jira.moveTicket(data.ticketId, env.COLUMN_AI_REVIEW);
    return;
  }

  if (result.status === "clarification_needed") {
    const questions = (result.questions ?? []).join("\n\n");
    await jira.postComment(data.ticketId, questions);

    await db.update(tickets)
      .set({
        workflowState: "clarification_pending",
        branchName,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "clarification_needed", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    await jira.moveTicket(data.ticketId, env.COLUMN_BACKLOG);
    return;
  }

  await db.update(runAttempts)
    .set({ status: "failed", error: result.error, finishedAt: new Date() })
    .where(eq(runAttempts.id, run!.id));

  await db.update(tickets)
    .set({ workflowState: "failed", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  throw new Error(
    `Agent failed for ${data.ticketId}: ${result.error}`,
  );
}
```

- [ ] **Step 4: Run tests and iterate**

Run: `npx vitest run src/worker.test.ts`
Expected: Adjust mocks/implementation until all PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: implement worker with fresh fetch, context assembly, and sandbox orchestration"
```

---

## Chunk 8: Integration Wiring

### Task 13: Update Index and Run Full Suite

**Files:**
- Modify: `src/index.ts` (if not already updated in Task 3)
- Modify: `src/index.test.ts` (mock updates)

- [ ] **Step 1: Verify index.ts wiring**

`src/index.ts` should have:
- `await routeTicketTransition(event)` (async, from Task 3)
- `createWorker()` unchanged (started in `main()`)

- [ ] **Step 2: Update index.test.ts mocks if needed**

Ensure these mocks are present in `src/index.test.ts`:

```typescript
vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(() => ({ close: vi.fn() })),
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "uuid" }]),
      }),
    }),
  }),
}));
vi.mock("postgres", () => ({ default: vi.fn() }));
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: wire webhook → orchestrator → worker pipeline"
```

---

### Task 14: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify Docker sandbox image builds**

Run: `docker build -t blazebot-sandbox docker/sandbox/`
Expected: Image builds successfully

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
```

---

## Summary of Changes from Previous Plan

This plan differs from `docs/superpowers/plans/2026-03-12-start-new-work.md` in these key ways:

1. **Aligned with actual adapter interfaces** — uses `fetchTicket`/`postComment`/`parseWebhook` (not `getTicket`/`addComment`), and `createPR` (not `createPullRequest`), matching `src/adapters/ticket.ts` and `src/adapters/source-control.ts`.
2. **Uses actual `NormalizedEvent` shape** — `ticketId`/`triggeredBy` (not `externalTicketId`/`actor`), matching `src/adapters/ticket.ts:24-30`.
3. **Router becomes a proper orchestrator** — DB lookup to determine `workflow_state` before dispatching, per spec Section 8.1.
4. **No schema migration needed** — `tickets` table already has `prId`, `branchName`, and all required columns. `run_attempts` already has all needed fields.
5. **Separate context assembly module** — `src/context.ts` is independently testable, instead of inline in the worker.
6. **`TicketJobData` preserves `ticketId` field name** — matches the existing field name in the codebase.
7. **Sandbox in `src/sandbox/`** not `src/docker/` — cleaner separation from Docker image files in `docker/`.
8. **Removed redundant column env vars from old plan** — only `COLUMN_AI` existed; this plan adds `COLUMN_AI_REVIEW` and `COLUMN_BACKLOG` that are actually needed.
9. **Worker throws on failure** — so BullMQ's built-in retry handles retries (spec Section 7.4), instead of silently logging.
10. **`Ticket` interface includes `identifier` field** — populated correctly from Jira `key`.
