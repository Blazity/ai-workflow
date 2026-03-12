# Start New Work — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the full "ticket moved to AI" flow: webhook → BullMQ → worker → GitHub branch → Docker sandbox → Claude Code → PR or clarification.

**Architecture:** The Jira parser is expanded to extract full ticket context. The router enqueues BullMQ jobs instead of logging stubs. The worker orchestrates: DB upsert, GitHub branch creation, Docker sandbox lifecycle, and post-run actions (PR creation or Jira comment). Adapters are concrete implementations of existing interfaces.

**Tech Stack:** Fastify 5, Drizzle ORM, BullMQ 5, Zod 3, Octokit, dockerode, Vitest 4, TypeScript 5.9 (strict, ESM)

**Spec:** `docs/superpowers/specs/2026-03-12-start-new-work-design.md`

---

## Chunk 1: Environment Variables & Schema Migration

### Task 1: Add New Environment Variables

**Files:**
- Modify: `env.ts:4-27`
- Modify: `env.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing tests**

Add these tests to `env.test.ts` inside the existing `describe("env", ...)` block, after the last test:

```typescript
it("allows optional JIRA_BASE_URL", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("../env.js");
  expect(env.JIRA_BASE_URL).toBeUndefined();
});

it("parses JIRA_BASE_URL when set", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("JIRA_BASE_URL", "https://team.atlassian.net");

  const { env } = await import("../env.js");
  expect(env.JIRA_BASE_URL).toBe("https://team.atlassian.net");
});

it("uses default GITHUB_BASE_BRANCH of 'main'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("../env.js");
  expect(env.GITHUB_BASE_BRANCH).toBe("main");
});

it("uses default SANDBOX_TIMEOUT_MS of 1800000", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("../env.js");
  expect(env.SANDBOX_TIMEOUT_MS).toBe(1800000);
});

it("uses default SANDBOX_MEMORY_MB of 4096", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("../env.js");
  expect(env.SANDBOX_MEMORY_MB).toBe(4096);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run env.test.ts`
Expected: FAIL — `env.JIRA_BASE_URL` etc. do not exist

- [ ] **Step 3: Add env vars to env.ts**

Add inside the `server` object in `env.ts`, after the `COLUMN_BACKLOG` field:

```typescript
JIRA_BASE_URL: z.string().url().optional(),
JIRA_USER_EMAIL: z.string().email().optional(),
JIRA_API_TOKEN: z.string().min(1).optional(),
GITHUB_TOKEN: z.string().min(1).optional(),
GITHUB_REPO_OWNER: z.string().min(1).optional(),
GITHUB_REPO_NAME: z.string().min(1).optional(),
GITHUB_BASE_BRANCH: z.string().default("main"),
ANTHROPIC_API_KEY: z.string().min(1).optional(),
SANDBOX_TIMEOUT_MS: z
  .string()
  .default("1800000")
  .transform((v) => parseInt(v, 10)),
SANDBOX_MEMORY_MB: z
  .string()
  .default("4096")
  .transform((v) => parseInt(v, 10)),
```

- [ ] **Step 4: Update .env.example**

Add to `.env.example` after the existing vars:

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

# Sandbox limits
SANDBOX_TIMEOUT_MS=1800000
SANDBOX_MEMORY_MB=4096
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run env.test.ts`
Expected: All PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add env.ts env.test.ts .env.example
git commit -m "feat: add optional env vars for Jira, GitHub, Anthropic, and sandbox config"
```

---

### Task 2: Schema Migration — Add PR Columns to agent_runs

**Files:**
- Modify: `src/schema.ts:60-77`

- [ ] **Step 1: Add columns to agent_runs table**

In `src/schema.ts`, add two columns to the `agentRuns` table, after `containerId`:

```typescript
prNumber: integer("pr_number"),
prUrl: text("pr_url"),
```

Also add `integer` to the imports from `drizzle-orm/pg-core`:

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Generate migration**

Run: `npx drizzle-kit generate`
Expected: New migration file created in `drizzle/`

- [ ] **Step 4: Run existing schema tests**

Run: `npx vitest run src/schema.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts drizzle/
git commit -m "feat: add pr_number and pr_url columns to agent_runs table"
```

---

## Chunk 2: Expanded Jira Parser

### Task 3: Expand Jira Webhook Parser

**Files:**
- Modify: `src/webhooks/jira.ts`
- Modify: `src/webhooks/jira.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/webhooks/jira.test.ts` after the existing `describe("parseJiraWebhook", ...)`:

```typescript
describe("parseJiraWebhook (with context)", () => {
  const payloadWithFields = {
    user: {
      accountId: "abc123",
      displayName: "Mia Krystof",
    },
    issue: {
      key: "PROJ-42",
      fields: {
        summary: "Add dark mode support",
        description: "Implement dark mode across all pages",
        comment: {
          comments: [
            {
              author: { displayName: "Alice" },
              body: "Please use CSS variables",
              created: "2026-03-10T10:00:00.000+0000",
            },
          ],
        },
        labels: ["frontend", "ui"],
      },
    },
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
  };

  it("extracts ticket context when fields are present", () => {
    const result = parseJiraWebhook(payloadWithFields);

    expect(result).not.toBeNull();
    expect(result!.context).toEqual({
      externalTicketId: "PROJ-42",
      title: "Add dark mode support",
      description: "Implement dark mode across all pages",
      comments: [
        {
          author: "Alice",
          body: "Please use CSS variables",
          createdAt: "2026-03-10T10:00:00.000+0000",
        },
      ],
      labels: ["frontend", "ui"],
    });
  });

  it("returns null context when fields are missing", () => {
    const result = parseJiraWebhook(validPayload);

    expect(result).not.toBeNull();
    expect(result!.context).toBeNull();
  });

  it("handles missing comment block in fields", () => {
    const payload = {
      ...payloadWithFields,
      issue: {
        ...payloadWithFields.issue,
        fields: {
          summary: "Title",
          description: null,
          // no comment block
        },
      },
    };

    const result = parseJiraWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.context!.comments).toEqual([]);
    expect(result!.context!.description).toBe("");
  });

  it("handles missing labels in fields", () => {
    const payload = {
      ...payloadWithFields,
      issue: {
        ...payloadWithFields.issue,
        fields: {
          summary: "Title",
          description: "Desc",
          comment: { comments: [] },
          // no labels
        },
      },
    };

    const result = parseJiraWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.context!.labels).toEqual([]);
  });

  it("still returns event alongside context", () => {
    const result = parseJiraWebhook(payloadWithFields);

    expect(result!.event).toEqual({
      source: "jira",
      externalTicketId: "PROJ-42",
      fromColumn: "To Do",
      toColumn: "AI",
      actor: "Mia Krystof",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/webhooks/jira.test.ts`
Expected: FAIL — `result.context` doesn't exist, `result.event` doesn't exist

- [ ] **Step 3: Add JiraTicketContext type**

Add to `src/webhooks/jira.ts`, after the imports:

```typescript
export type JiraTicketContext = {
  externalTicketId: string;
  title: string;
  description: string;
  comments: { author: string; body: string; createdAt: string }[];
  labels: string[];
};

export type JiraParseResult = {
  event: TicketTransitionEvent;
  context: JiraTicketContext | null;
};
```

- [ ] **Step 4: Expand the Zod schema**

Replace the existing `jiraWebhookSchema` in `src/webhooks/jira.ts`:

```typescript
const jiraIssueFieldsSchema = z.object({
  summary: z.string(),
  description: z.string().nullable().transform((v) => v ?? ""),
  comment: z
    .object({
      comments: z.array(
        z.object({
          author: z.object({ displayName: z.string() }),
          body: z.string(),
          created: z.string(),
        }),
      ),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
});

const jiraWebhookSchema = z.object({
  user: z.object({
    accountId: z.string(),
    displayName: z.string(),
  }),
  issue: z.object({
    key: z.string(),
    fields: jiraIssueFieldsSchema.optional(),
  }),
  changelog: z.object({
    items: z.array(changelogItemSchema),
  }),
});
```

- [ ] **Step 5: Update parseJiraWebhook return type and implementation**

Replace the `parseJiraWebhook` function:

```typescript
export function parseJiraWebhook(
  body: unknown,
): JiraParseResult | null {
  const parsed = jiraWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const { user, issue, changelog } = parsed.data;
  const statusChange = changelog.items.find(
    (item) => item.field === "status",
  );

  if (!statusChange) {
    return null;
  }

  const event: TicketTransitionEvent = {
    source: "jira",
    externalTicketId: issue.key,
    fromColumn: statusChange.fromString,
    toColumn: statusChange.toString,
    actor: user.displayName,
  };

  let context: JiraTicketContext | null = null;
  if (issue.fields) {
    context = {
      externalTicketId: issue.key,
      title: issue.fields.summary,
      description: issue.fields.description,
      comments: (issue.fields.comment?.comments ?? []).map((c) => ({
        author: c.author.displayName,
        body: c.body,
        createdAt: c.created,
      })),
      labels: issue.fields.labels ?? [],
    };
  }

  return { event, context };
}
```

- [ ] **Step 6: Update existing tests for new return shape**

The existing `parseJiraWebhook` tests reference the result directly as a `TicketTransitionEvent`. Update them to use `result.event` or `result!.event`. In `src/webhooks/jira.test.ts`:

In the `describe("parseJiraWebhook", ...)` block:

- Change `const result = parseJiraWebhook(validPayload)` assertions from `expect(result).toEqual({ source: "jira", ... })` to `expect(result!.event).toEqual({ source: "jira", ... })`
- Change `const result = parseJiraWebhook(payload)` → `expect(result!.event).toEqual(...)` for the "handles multiple changelog items" test
- Change the "handles null fromString" test similarly
- The `toBeNull()` tests stay as-is (those payloads still return null)

- [ ] **Step 7: Update index.ts to use new return shape**

In `src/index.ts`, update the webhook route handler:

```typescript
const result = parseJiraWebhook(request.body);
if (result) {
  routeTicketTransition(result.event);
}
```

(The `context` parameter gets wired in Chunk 3.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/jira.test.ts`
Expected: All PASS (existing + new)

- [ ] **Step 9: Run the full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 10: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 11: Commit**

```bash
git add src/webhooks/jira.ts src/webhooks/jira.test.ts src/index.ts
git commit -m "feat: expand Jira parser to extract full ticket context"
```

---

## Chunk 3: Queue & Router Update

### Task 4: Update TicketJobData Type

**Files:**
- Modify: `src/queue.ts:4-8`

- [ ] **Step 1: Replace TicketJobData type**

Replace the type and comment in `src/queue.ts`:

```typescript
export type TicketJobData = {
  type: "start_new_work";
  source: "jira" | "linear";
  externalTicketId: string;
  actor: string;
  context: {
    title: string;
    description: string;
    comments: { author: string; body: string; createdAt: string }[];
    labels: string[];
  };
};
// Discriminated union — future phases add "review_fix", "clarification_answer", etc.
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/queue.ts
git commit -m "feat: update TicketJobData to discriminated union with full context"
```

---

### Task 5: Update Router to Enqueue Jobs

**Files:**
- Modify: `src/webhooks/router.ts`
- Modify: `src/webhooks/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Rewrite `src/webhooks/router.test.ts` completely:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JiraTicketContext } from "./jira.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
  })),
}));

describe("routeTicketTransition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("JIRA_WEBHOOK_SECRET", "test-secret");
  });

  const makeEvent = (from: string, to: string) => ({
    source: "jira" as const,
    externalTicketId: "PROJ-42",
    fromColumn: from,
    toColumn: to,
    actor: "Mia",
  });

  const makeContext = (): JiraTicketContext => ({
    externalTicketId: "PROJ-42",
    title: "Add dark mode",
    description: "Implement dark mode",
    comments: [],
    labels: [],
  });

  it("enqueues a start_new_work job when ticket moves to AI column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    routeTicketTransition(makeEvent("To Do", "AI"), makeContext());

    expect(ticketQueue.add).toHaveBeenCalledWith(
      "start_new_work",
      expect.objectContaining({
        type: "start_new_work",
        source: "jira",
        externalTicketId: "PROJ-42",
        actor: "Mia",
        context: expect.objectContaining({
          title: "Add dark mode",
        }),
      }),
      expect.objectContaining({ jobId: "PROJ-42" }),
    );
  });

  it("logs warning and does not enqueue when context is null for start_new_work", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "AI"), null);

    expect(ticketQueue.add).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Missing ticket context"),
    );
    spy.mockRestore();
  });

  it("logs stub for review fix (AI Review → AI In Progress)", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("AI Review", "AI In Progress"), null);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: pick up review comments"),
    );
    spy.mockRestore();
  });

  it("logs stub for clarification resume (Backlog → AI In Progress)", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("Backlog", "AI In Progress"), null);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: getting ticket"),
    );
    spy.mockRestore();
  });

  it("logs stub for cancel (AI In Progress → Done)", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("AI In Progress", "Done"), null);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: cancel active agent run"),
    );
    spy.mockRestore();
  });

  it("does not log for irrelevant transitions", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "In Progress"), null);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("matches column names case-insensitively", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const { ticketQueue } = await import("../queue.js");

    routeTicketTransition(makeEvent("To Do", "ai"), makeContext());

    expect(ticketQueue.add).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: FAIL — `routeTicketTransition` doesn't accept a second argument

- [ ] **Step 3: Update the router implementation**

Replace `src/webhooks/router.ts`:

```typescript
import { env } from "../../env.js";
import { ticketQueue } from "../queue.js";
import type { JiraTicketContext } from "./jira.js";
import type { TicketTransitionEvent } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function routeTicketTransition(
  event: TicketTransitionEvent,
  context: JiraTicketContext | null,
): void {
  const from = normalize(event.fromColumn);
  const to = normalize(event.toColumn);

  const colAi = normalize(env.COLUMN_AI);
  const colInProgress = normalize(env.COLUMN_AI_IN_PROGRESS);
  const colReview = normalize(env.COLUMN_AI_REVIEW);
  const colBacklog = normalize(env.COLUMN_BACKLOG);

  if (to === colAi) {
    if (!context) {
      console.warn(
        `Missing ticket context for ${event.externalTicketId}, cannot enqueue start_new_work`,
      );
      return;
    }
    ticketQueue.add(
      "start_new_work",
      {
        type: "start_new_work",
        source: event.source,
        externalTicketId: event.externalTicketId,
        actor: event.actor,
        context: {
          title: context.title,
          description: context.description,
          comments: context.comments,
          labels: context.labels,
        },
      },
      { jobId: event.externalTicketId },
    );
    return;
  }

  if (to === colInProgress && from === colReview) {
    console.log(
      `TODO: pick up review comments for ticket ${event.externalTicketId}`,
    );
    return;
  }

  if (to === colInProgress && from === colBacklog) {
    console.log(
      `TODO: getting ticket ${event.externalTicketId} with recent specs`,
    );
    return;
  }

  if (from === colInProgress) {
    console.log(
      `TODO: cancel active agent run for ticket ${event.externalTicketId}`,
    );
    return;
  }

  // Transition not relevant to Blazebot — ignore
}
```

- [ ] **Step 4: Update index.ts to pass context to router**

In `src/index.ts`, update the webhook route handler:

```typescript
const result = parseJiraWebhook(request.body);
if (result) {
  routeTicketTransition(result.event, result.context);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: All PASS

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: All PASS (update index.test.ts if needed — the existing webhook tests still return 200 since the route handler just calls router and returns `{ ok: true }`)

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/webhooks/router.ts src/webhooks/router.test.ts src/index.ts
git commit -m "feat: wire router to enqueue BullMQ jobs for start_new_work"
```

---

## Chunk 4: Jira REST Client

### Task 6: Implement Jira Client

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

  describe("addComment", () => {
    it("posts a comment to the correct URL with auth", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id: "123" }), { status: 201 }),
      );

      await client.addComment("PROJ-42", "Need clarification on X");

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
                  content: [{ type: "text", text: "Need clarification on X" }],
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
        client.addComment("PROJ-999", "text"),
      ).rejects.toThrow("Jira API error: 404");
    });
  });

  describe("moveTicket", () => {
    it("fetches transitions then posts the matching one", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
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
        .mockResolvedValueOnce(
          new Response(null, { status: 204 }),
        );

      await client.moveTicket("PROJ-42", "AI Review");

      // First call: get transitions
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/transitions",
        expect.objectContaining({ method: "GET" }),
      );

      // Second call: post transition
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
          JSON.stringify({ transitions: [{ id: "11", name: "Done" }] }),
          { status: 200 },
        ),
      );

      await expect(
        client.moveTicket("PROJ-42", "AI Review"),
      ).rejects.toThrow("No transition found matching 'AI Review'");
    });
  });

  describe("getTicket", () => {
    it("fetches ticket details from Jira", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            key: "PROJ-42",
            fields: {
              summary: "Dark mode",
              description: { content: [{ content: [{ text: "Add dark mode" }] }] },
              comment: { comments: [] },
            },
          }),
          { status: 200 },
        ),
      );

      const ticket = await client.getTicket("PROJ-42");

      expect(ticket.externalId).toBe("PROJ-42");
      expect(ticket.title).toBe("Dark mode");
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
import type { Ticket, TicketAdapter, TicketComment } from "./ticket.js";

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

  async getTicket(externalId: string): Promise<Ticket> {
    const res = await this.request(
      `/rest/api/3/issue/${externalId}?fields=summary,description,comment`,
    );
    const data = await res.json();
    return {
      externalId: data.key,
      title: data.fields.summary,
      description: this.extractText(data.fields.description),
      acceptanceCriteria: null,
      comments: (data.fields.comment?.comments ?? []).map(
        (c: { author: { displayName: string }; body: string; created: string }): TicketComment => ({
          author: c.author.displayName,
          body: typeof c.body === "string" ? c.body : this.extractText(c.body),
          createdAt: new Date(c.created),
        }),
      ),
    };
  }

  async addComment(externalId: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${externalId}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: body }],
            },
          ],
        },
      }),
    });
  }

  async moveTicket(externalId: string, columnName: string): Promise<void> {
    const res = await this.request(
      `/rest/api/3/issue/${externalId}/transitions`,
      { method: "GET" },
    );
    const data = await res.json();
    const transition = data.transitions.find(
      (t: { name: string }) =>
        t.name.toLowerCase() === columnName.toLowerCase(),
    );
    if (!transition) {
      throw new Error(`No transition found matching '${columnName}'`);
    }
    await this.request(`/rest/api/3/issue/${externalId}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
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
git commit -m "feat: add Jira REST client implementing TicketAdapter"
```

---

## Chunk 5: GitHub REST Client

### Task 7: Install @octokit/rest

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

### Task 8: Implement GitHub Client

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
    },
    repos: {
      merge: vi.fn(),
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

    // Should not throw
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

    const pr = await client.createPullRequest(
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

  it("getPullRequestComments returns empty array (stub)", async () => {
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    const comments = await client.getPullRequestComments("o", "r", 1);
    expect(comments).toEqual([]);
  });

  it("mergeBranch resolves (stub)", async () => {
    const { GitHubClient } = await import("./github-client.js");
    const client = new GitHubClient("test-token");

    await expect(
      client.mergeBranch("o", "r", "feat", "main"),
    ).resolves.toBeUndefined();
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
  SourceControlAdapter,
} from "./source-control.js";

export class GitHubClient implements SourceControlAdapter {
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
      if (error.status === 422) {
        // Branch already exists — reuse it
        return;
      }
      throw err;
    }
  }

  async createPullRequest(
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

    return {
      number: data.number,
      url: data.html_url,
    };
  }

  async getPullRequestComments(
    _repoOwner: string,
    _repoName: string,
    _prNumber: number,
  ): Promise<PullRequestComment[]> {
    // Stub — implemented in review-fix phase
    return [];
  }

  async mergeBranch(
    _repoOwner: string,
    _repoName: string,
    _branchName: string,
    _baseBranch: string,
  ): Promise<void> {
    // Stub — implemented in review-fix phase
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
git commit -m "feat: add GitHub client implementing SourceControlAdapter"
```

---

## Chunk 6: Docker Sandbox

### Task 9: Create Sandbox Docker Image Files

**Files:**
- Create: `docker/sandbox/Dockerfile`
- Create: `docker/sandbox/entrypoint.sh`
- Create: `docker/sandbox/git-guard.sh`
- Create: `docker/sandbox/prompt.md`

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

# 1. Clone repo on the assigned branch
/usr/bin/git clone --branch "$BLAZEBOT_BRANCH" --single-branch \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo

cd /workspace/repo

# 2. Copy injected files
cp /inject/requirements.md ./requirements.md

# 3. Substitute branch name in prompt and copy
sed "s/{branchName}/$BLAZEBOT_BRANCH/g" /inject/prompt.md > ./prompt.md

# 4. Create output directory
mkdir -p output

# 5. Run Claude Code
CLAUDE_EXIT=0
claude -p "$(cat prompt.md)" --dangerously-skip-permissions || CLAUDE_EXIT=$?

# 6. Ensure result.json exists
if [ ! -f output/result.json ]; then
  echo '{"status":"failed","error":"Claude Code exited without writing result.json"}' > output/result.json
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

- [ ] **Step 4: Write git-guard.sh tests**

Create `docker/sandbox/git-guard.test.sh`:

```bash
#!/bin/bash
# Unit tests for git-guard.sh — run with: bash docker/sandbox/git-guard.test.sh
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Override REAL_GIT to a no-op so we never call real git
export BLAZEBOT_BRANCH="blazebot/PROJ-42"

run_guard() {
  # Source the guard in a subshell with REAL_GIT pointed at /usr/bin/true
  REAL_GIT=/usr/bin/true bash "$SCRIPT_DIR/git-guard.sh" "$@" 2>/dev/null
}

assert_blocked() {
  local desc="$1"
  shift
  if run_guard "$@"; then
    echo "FAIL: $desc (expected block, got success)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  fi
}

assert_allowed() {
  local desc="$1"
  shift
  if run_guard "$@"; then
    echo "PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected success, got block)"
    FAIL=$((FAIL + 1))
  fi
}

# --- Branch switching tests ---
assert_blocked "checkout is blocked" checkout main
assert_blocked "checkout -b is blocked" checkout -b other-branch
assert_blocked "switch is blocked" switch main
assert_blocked "switch -c is blocked" switch -c other-branch

# --- Push tests ---
assert_allowed "push to assigned branch is allowed" push origin blazebot/PROJ-42
assert_blocked "push to different branch via refspec is blocked" push origin HEAD:main
assert_allowed "bare push is allowed" push

# --- Passthrough tests ---
assert_allowed "status is allowed" status
assert_allowed "add is allowed" add .
assert_allowed "commit is allowed" commit -m "test"
assert_allowed "merge is allowed" merge origin/main
assert_allowed "log is allowed" log --oneline
assert_allowed "diff is allowed" diff
assert_allowed "pull is allowed" pull origin blazebot/PROJ-42

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 5: Run git-guard tests**

Run: `bash docker/sandbox/git-guard.test.sh`
Expected: All PASS

- [ ] **Step 6: Create prompt.md**

Create `docker/sandbox/prompt.md`:

> Note: Steps were renumbered after adding git-guard tests.

```markdown
You are an automated AI developer working on a feature. Follow these instructions exactly.

## Your Task

1. Read `requirements.md` in the repo root — it contains the ticket requirements.
2. Use `/using-superpowers` to brainstorm the approach and create an implementation plan.
3. Evaluate whether the requirements are clear enough to implement:
   - If ANYTHING is ambiguous or missing and would block correct implementation, go to STEP 4.
   - If requirements are clear, go to STEP 5.

4. **Clarification needed:**
   - Write your questions to `output/result.json`:
     ```json
     { "status": "needs_clarification", "questions": ["question 1", "question 2"] }
     ```
   - Exit immediately. Do NOT attempt partial implementation.

5. **Implement:**
   - Execute the plan using superpowers skills.
   - Follow TDD — write tests before implementation.
   - Commit your work frequently with clear messages.
   - Push all commits to the current branch.

6. **After implementation is complete:**
   - Run `/requesting-code-review` to self-review your work.
   - Fix any issues found during review.
   - Write completion status to `output/result.json`:
     ```json
     { "status": "complete", "summary": "Brief description of what was implemented" }
     ```

## Constraints

- You are on branch `{branchName}`. NEVER switch branches.
- Push ONLY to this branch.
- Do NOT modify `requirements.md` or `prompt.md`.
- Do NOT create or modify `.env` files.
- Always write `output/result.json` before exiting.
```

- [ ] **Step 7: Commit**

```bash
git add docker/sandbox/
git commit -m "feat: add Docker sandbox image files (Dockerfile, entrypoint, git-guard, prompt)"
```

---

### Task 10: Install dockerode

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

### Task 11: Implement Docker Manager

**Files:**
- Create: `src/docker/manager.ts`
- Create: `src/docker/manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/docker/manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Docker from "dockerode";

vi.mock("dockerode", () => {
  const mockContainer = {
    start: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    getArchive: vi.fn(),
    remove: vi.fn(),
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

describe("runSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultOptions = {
    image: "blazebot-sandbox",
    branchName: "blazebot/PROJ-42",
    requirementsMd: "# Requirements\n\nDo the thing",
    promptMd: "You are an agent on branch {branchName}",
    githubToken: "ghp_test",
    repoUrl: "owner/repo",
    anthropicApiKey: "sk-ant-test",
    timeoutMs: 30000,
    memoryLimitMb: 4096,
  };

  it("creates a container with correct env vars and memory limit", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    // Mock getArchive to return a valid result.json
    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    const resultJson = JSON.stringify({ status: "complete", summary: "Done" });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(resultJson),
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

  it("returns complete result when result.json has status complete", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    const resultJson = JSON.stringify({
      status: "complete",
      summary: "Implemented dark mode",
    });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(resultJson),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      status: "complete",
      summary: "Implemented dark mode",
    });
  });

  it("returns needs_clarification result", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    const resultJson = JSON.stringify({
      status: "needs_clarification",
      questions: ["What color for dark mode?"],
    });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(resultJson),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      status: "needs_clarification",
      questions: ["What color for dark mode?"],
    });
  });

  it("returns failed when result.json is missing", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.getArchive.mockRejectedValue(new Error("file not found"));

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      status: "failed",
      error: expect.stringContaining("result.json"),
    });
  });

  it("removes the container after execution", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    const resultJson = JSON.stringify({ status: "complete", summary: "Done" });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(resultJson),
    );

    await runSandbox(defaultOptions);

    expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
  });

  it("returns failed when timeout is exceeded", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    // Simulate container that never finishes
    mockContainer.wait.mockReturnValue(new Promise(() => {}));
    mockContainer.kill.mockResolvedValue(undefined);

    const result = await runSandbox({ ...defaultOptions, timeoutMs: 50 });

    expect(result).toEqual({
      status: "failed",
      error: expect.stringContaining("timeout"),
    });
    expect(mockContainer.kill).toHaveBeenCalled();
  });

  it("still reads result.json when container exits with non-zero code", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    // Container exits non-zero but wrote result.json
    mockContainer.wait.mockResolvedValue({ StatusCode: 1 });
    const resultJson = JSON.stringify({
      status: "needs_clarification",
      questions: ["What API version?"],
    });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(resultJson),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      status: "needs_clarification",
      questions: ["What API version?"],
    });
  });

  it("returns failed for unrecognized result.json status", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    const resultJson = JSON.stringify({ status: "unknown_value" });
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream(resultJson),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      status: "failed",
      error: expect.stringContaining("Unexpected result.json status"),
    });
  });

  it("returns failed for malformed result.json", async () => {
    const Docker = (await import("dockerode")).default;
    const { runSandbox } = await import("./manager.js");

    const mockInstance = vi.mocked(Docker).mock.results[0]!.value;
    const mockContainer = await mockInstance.createContainer({});
    mockContainer.getArchive.mockResolvedValue(
      createMockTarStream("not valid json{{{"),
    );

    const result = await runSandbox(defaultOptions);

    expect(result).toEqual({
      status: "failed",
      error: expect.stringContaining("result.json"),
    });
  });

  it("cleans up container and temp dir even when sandbox fails", async () => {
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

// Helper to create a mock tar stream for getArchive
function createMockTarStream(content: string) {
  // Return a readable stream that yields the content
  const { Readable } = require("node:stream");
  const stream = new Readable({
    read() {
      this.push(content);
      this.push(null);
    },
  });
  // Mark it as a tar-like stream for our extraction
  stream._content = content;
  return stream;
}
```

Note: The Docker manager tests cover the full lifecycle: happy paths (complete, needs_clarification), error paths (missing result.json, malformed JSON, unrecognized status), edge cases (timeout with kill, non-zero exit code with valid result.json), and cleanup verification. The exact mock setup may need adjustment during implementation — the key assertions above capture the expected behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/docker/manager.test.ts`
Expected: FAIL — cannot resolve `./manager.js`

- [ ] **Step 3: Implement Docker Manager**

Create `src/docker/manager.ts`:

```typescript
import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type SandboxResult =
  | { status: "complete"; summary: string }
  | { status: "needs_clarification"; questions: string[] }
  | { status: "failed"; error: string };

export interface SandboxOptions {
  image: string;
  branchName: string;
  requirementsMd: string;
  promptMd: string;
  githubToken: string;
  repoUrl: string;
  anthropicApiKey: string;
  timeoutMs: number;
  memoryLimitMb: number;
}

const docker = new Docker();

export async function runSandbox(
  options: SandboxOptions,
): Promise<SandboxResult> {
  // 1. Write inject files to temp dir
  const tmpDir = await mkdtemp(join(tmpdir(), "blazebot-"));
  await writeFile(join(tmpDir, "requirements.md"), options.requirementsMd);
  await writeFile(join(tmpDir, "prompt.md"), options.promptMd);

  let container: Docker.Container | null = null;

  try {
    // 2. Create container
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

    // 3. Start and wait
    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Sandbox timeout exceeded")),
        options.timeoutMs,
      ),
    );

    try {
      await Promise.race([waitPromise, timeoutPromise]);
    } catch (err) {
      if (container) {
        try {
          await container.kill();
        } catch {
          // Container may already be stopped
        }
      }
      return {
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown timeout error",
      };
    }

    // 4. Read result.json
    return await readResult(container);
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    // 5. Cleanup
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        // Best effort cleanup
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function readResult(
  container: Docker.Container,
): Promise<SandboxResult> {
  try {
    const archive = await container.getArchive({
      path: "/workspace/repo/output/result.json",
    });

    const content = await streamToString(archive);
    const parsed = JSON.parse(content);

    if (
      parsed.status === "complete" &&
      typeof parsed.summary === "string"
    ) {
      return { status: "complete", summary: parsed.summary };
    }

    if (
      parsed.status === "needs_clarification" &&
      Array.isArray(parsed.questions)
    ) {
      return {
        status: "needs_clarification",
        questions: parsed.questions,
      };
    }

    return {
      status: "failed",
      error: `Unexpected result.json status: ${parsed.status}`,
    };
  } catch {
    return {
      status: "failed",
      error: "Failed to read result.json from container",
    };
  }
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  // Docker getArchive returns a tar stream — the file content starts after the 512-byte tar header
  const content = buffer.subarray(512);
  // Find the end of file content (tar pads with null bytes)
  const nullIndex = content.indexOf(0);
  return content.subarray(0, nullIndex > 0 ? nullIndex : content.length).toString("utf-8");
}
```

- [ ] **Step 4: Run tests and iterate on mock setup**

Run: `npx vitest run src/docker/manager.test.ts`
Expected: Adjust mocks as needed until all PASS. The `getArchive` mock and tar parsing may need refinement.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/docker/manager.ts src/docker/manager.test.ts
git commit -m "feat: add Docker sandbox manager with container lifecycle"
```

---

## Chunk 7: Worker Handler

### Task 12: Implement Worker Orchestration

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Rewrite `src/worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { TicketJobData } from "./queue.js";

vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation((_name, handler) => {
    return { handler, close: vi.fn() };
  }),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "ticket-uuid" }]),
        }),
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
vi.mock("./docker/manager.js", () => ({
  runSandbox: (...args: unknown[]) => mockRunSandbox(...args),
}));

const mockGitHub = {
  createBranch: vi.fn(),
  createPullRequest: vi.fn().mockResolvedValue({
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
  }),
  getPullRequestComments: vi.fn(),
  mergeBranch: vi.fn(),
};
vi.mock("./adapters/github-client.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => mockGitHub),
}));

const mockJira = {
  getTicket: vi.fn(),
  addComment: vi.fn(),
  moveTicket: vi.fn(),
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
    ({ data, name: "start_new_work" }) as Job<TicketJobData>;

  it("creates branch, runs sandbox, and creates PR on complete", async () => {
    mockRunSandbox.mockResolvedValue({
      status: "complete",
      summary: "Implemented feature",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "start_new_work",
        source: "jira",
        externalTicketId: "PROJ-42",
        actor: "Mia",
        context: {
          title: "Add dark mode",
          description: "Implement dark mode",
          comments: [],
          labels: [],
        },
      }),
    );

    expect(mockGitHub.createBranch).toHaveBeenCalledWith(
      "owner",
      "repo",
      "blazebot/PROJ-42",
      "main",
    );
    expect(mockRunSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "blazebot/PROJ-42",
      }),
    );
    expect(mockGitHub.createPullRequest).toHaveBeenCalled();
    expect(mockJira.moveTicket).toHaveBeenCalledWith(
      "PROJ-42",
      expect.stringContaining("Review"),
    );
  });

  it("posts questions and moves to backlog on needs_clarification", async () => {
    mockRunSandbox.mockResolvedValue({
      status: "needs_clarification",
      questions: ["What color scheme?"],
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "start_new_work",
        source: "jira",
        externalTicketId: "PROJ-42",
        actor: "Mia",
        context: {
          title: "Add dark mode",
          description: "Implement dark mode",
          comments: [],
          labels: [],
        },
      }),
    );

    expect(mockJira.addComment).toHaveBeenCalledWith(
      "PROJ-42",
      expect.stringContaining("What color scheme?"),
    );
    expect(mockJira.moveTicket).toHaveBeenCalledWith(
      "PROJ-42",
      expect.stringContaining("Backlog"),
    );
  });

  it("logs error and updates DB when sandbox returns failed", async () => {
    mockRunSandbox.mockResolvedValue({
      status: "failed",
      error: "Sandbox timeout exceeded",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handler(
      makeJob({
        type: "start_new_work",
        source: "jira",
        externalTicketId: "PROJ-42",
        actor: "Mia",
        context: {
          title: "Add dark mode",
          description: "Implement dark mode",
          comments: [],
          labels: [],
        },
      }),
    );

    expect(mockGitHub.createPullRequest).not.toHaveBeenCalled();
    expect(mockJira.addComment).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
      expect.stringContaining("timeout"),
    );
    spy.mockRestore();
  });

  it("discards jobs with old format (missing type field)", async () => {
    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Old format job
    await handler({ data: { ticketId: "old" }, name: "ticket" } as unknown as Job<TicketJobData>);

    expect(mockRunSandbox).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker.test.ts`
Expected: FAIL — current worker just logs

- [ ] **Step 3: Implement the worker handler**

Replace `src/worker.ts` with the full orchestration logic. The worker should:
1. Guard old-format jobs
2. Upsert ticket in DB
3. Create agent_run record
4. Create branch via GitHub
5. Generate requirements.md
6. Run sandbox
7. Handle result (complete → PR, clarification → comment, failed → log)

This is a larger file. Implement it following the spec's Section 6 flow. Import `db` from `./db.js`, adapters from `./adapters/*.js`, `runSandbox` from `./docker/manager.js`, and schema tables from `./schema.js`.

Use `env` from the root `env.js` for config values (GITHUB_*, JIRA_*, ANTHROPIC_*, SANDBOX_*, COLUMN_*).

Key function for requirements.md generation:

```typescript
function generateRequirementsMd(data: TicketJobData): string {
  const lines = [
    "# Requirements",
    "",
    `## Ticket: ${data.externalTicketId}`,
    "",
    "### Title",
    data.context.title,
    "",
    "### Description",
    data.context.description,
  ];

  if (data.context.comments.length > 0) {
    lines.push("", "### Comments");
    for (const comment of data.context.comments) {
      lines.push(
        "",
        `**${comment.author}** (${comment.createdAt}):`,
        comment.body,
      );
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and iterate**

Run: `npx vitest run src/worker.test.ts`
Expected: Adjust mocks/implementation until all PASS

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: implement worker orchestration for start_new_work flow"
```

---

## Chunk 8: Integration

### Task 13: Update Fastify Route & Integration Tests

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Verify index.ts is wired correctly**

The route handler in `src/index.ts` should already pass context from the parser update in Task 3 Step 7. Verify:

```typescript
const result = parseJiraWebhook(request.body);
if (result) {
  routeTicketTransition(result.event, result.context);
}
```

- [ ] **Step 2: Update index.test.ts mocks**

The existing `index.test.ts` mocks `ioredis` and `bullmq`. Since the router now imports `ticketQueue`, and `ticketQueue` uses Redis, the mocks should already cover this. Add the `bullmq` Queue mock if not present:

Update the mock at the top of `src/index.test.ts`:

```typescript
vi.mock("ioredis", () => ({ Redis: vi.fn() }));
vi.mock("bullmq", () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
  })),
}));
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: wire Jira webhook to BullMQ queue via router"
```

---

### Task 14: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify Docker sandbox image builds**

Run: `docker build -t blazebot-sandbox docker/sandbox/`
Expected: Image builds successfully

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If any uncommitted changes, commit them
```
