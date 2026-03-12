# Adapter Interfaces & Jira Webhook Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define adapter interfaces for ticket, source control, and messaging integrations, and implement a Jira webhook endpoint that parses ticket transitions and routes them to stub handlers.

**Architecture:** Three adapter interfaces define contracts for external integrations (PRD requirement #5). A Jira webhook parser normalizes raw payloads into a `TicketTransitionEvent`, which a router matches against 4 workflow cases (+ ignore). All handlers are stubs that log "not implemented yet".

**Tech Stack:** Fastify 5, Zod 3, Vitest 4, TypeScript 5.9 (strict, ESM)

**Spec:** `docs/superpowers/specs/2026-03-12-adapter-interfaces-webhook-design.md`

---

## Chunk 1: Adapter Interfaces & Webhook Types

### Task 1: TicketAdapter Interface

**Files:**
- Create: `src/adapters/ticket.ts`

- [ ] **Step 1: Create the TicketAdapter interface file**

```typescript
export interface TicketAdapter {
  getTicket(externalId: string): Promise<Ticket>;
  addComment(externalId: string, body: string): Promise<void>;
  moveTicket(externalId: string, columnName: string): Promise<void>;
}

export interface Ticket {
  externalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  comments: TicketComment[];
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: Date;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 2: SourceControlAdapter Interface

**Files:**
- Create: `src/adapters/source-control.ts`

- [ ] **Step 1: Create the SourceControlAdapter interface file**

```typescript
export interface SourceControlAdapter {
  createBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void>;

  createPullRequest(
    repoOwner: string,
    repoName: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequest>;

  getPullRequestComments(
    repoOwner: string,
    repoName: string,
    prNumber: number,
  ): Promise<PullRequestComment[]>;

  /** Merges baseBranch into branchName (e.g., merge main into feature branch for conflict resolution) */
  mergeBranch(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
  ): Promise<void>;
}

export interface PullRequest {
  number: number;
  url: string;
}

export interface PullRequestComment {
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  fromApprovedReview: boolean;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 3: MessagingAdapter Interface

**Files:**
- Create: `src/adapters/messaging.ts`

- [ ] **Step 1: Create the MessagingAdapter interface file**

```typescript
export interface MessagingAdapter {
  sendNotification(channel: string, message: string): Promise<void>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 4: Webhook Types

**Files:**
- Create: `src/webhooks/types.ts`

- [ ] **Step 1: Create the TicketTransitionEvent type**

```typescript
export type TicketTransitionEvent = {
  source: "jira" | "linear";
  externalTicketId: string;
  fromColumn: string;
  toColumn: string;
  actor: string;
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/adapters/ticket.ts src/adapters/source-control.ts src/adapters/messaging.ts src/webhooks/types.ts
git commit -m "feat: add adapter interfaces and webhook event types"
```

---

## Chunk 2: Environment Variables

### Task 5: Add Column Name Environment Variables

**Files:**
- Modify: `src/env.ts`
- Modify: `src/env.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to `src/env.test.ts` inside the existing `describe("env", ...)` block:

```typescript
it("uses default COLUMN_AI of 'AI'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.COLUMN_AI).toBe("AI");
});

it("uses default COLUMN_AI_IN_PROGRESS of 'AI In Progress'", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.COLUMN_AI_IN_PROGRESS).toBe("AI In Progress");
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

it("allows overriding column names via env", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("COLUMN_AI", "Custom AI");

  const { env } = await import("./env.js");
  expect(env.COLUMN_AI).toBe("Custom AI");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/env.test.ts`
Expected: FAIL — `env.COLUMN_AI` is undefined

- [ ] **Step 3: Add column env vars to env.ts**

Add inside the `server` object in `src/env.ts`, after the `NODE_ENV` field:

```typescript
COLUMN_AI: z.string().default("AI"),
COLUMN_AI_IN_PROGRESS: z.string().default("AI In Progress"),
COLUMN_AI_REVIEW: z.string().default("AI Review"),
COLUMN_BACKLOG: z.string().default("Backlog"),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/env.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/env.ts src/env.test.ts
git commit -m "feat: add configurable workflow column env vars"
```

---

## Chunk 3: Jira Webhook Parser

### Task 6: Jira Parser

**Files:**
- Create: `src/webhooks/jira.ts`
- Create: `src/webhooks/jira.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/webhooks/jira.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseJiraWebhook } from "./jira.js";

const validPayload = {
  user: {
    accountId: "abc123",
    displayName: "Mia Krystof",
  },
  issue: {
    key: "PROJ-42",
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

describe("parseJiraWebhook", () => {
  it("parses a valid status transition payload", () => {
    const result = parseJiraWebhook(validPayload);

    expect(result).toEqual({
      source: "jira",
      externalTicketId: "PROJ-42",
      fromColumn: "To Do",
      toColumn: "AI",
      actor: "Mia Krystof",
    });
  });

  it("returns null when changelog has no status change", () => {
    const payload = {
      ...validPayload,
      changelog: {
        items: [
          {
            field: "summary",
            fieldtype: "jira",
            fromString: "Old title",
            toString: "New title",
          },
        ],
      },
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null when changelog is missing", () => {
    const payload = {
      user: validPayload.user,
      issue: validPayload.issue,
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null when changelog items is empty", () => {
    const payload = {
      ...validPayload,
      changelog: { items: [] },
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null for malformed payload (missing issue)", () => {
    const payload = {
      user: validPayload.user,
      changelog: validPayload.changelog,
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null for malformed payload (missing user)", () => {
    const payload = {
      issue: validPayload.issue,
      changelog: validPayload.changelog,
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("handles multiple changelog items and picks the status one", () => {
    const payload = {
      ...validPayload,
      changelog: {
        items: [
          {
            field: "assignee",
            fieldtype: "jira",
            fromString: "Alice",
            toString: "Bob",
          },
          {
            field: "status",
            fieldtype: "jira",
            fromString: "Backlog",
            toString: "AI In Progress",
          },
        ],
      },
    };

    const result = parseJiraWebhook(payload);
    expect(result).toEqual({
      source: "jira",
      externalTicketId: "PROJ-42",
      fromColumn: "Backlog",
      toColumn: "AI In Progress",
      actor: "Mia Krystof",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/webhooks/jira.test.ts`
Expected: FAIL — cannot resolve `./jira.js`

- [ ] **Step 3: Implement the Jira parser**

Create `src/webhooks/jira.ts`:

```typescript
import { z } from "zod";
import type { TicketTransitionEvent } from "./types.js";

const changelogItemSchema = z.object({
  field: z.string(),
  fieldtype: z.string(),
  fromString: z.string(),
  toString: z.string(),
});

const jiraWebhookSchema = z.object({
  user: z.object({
    accountId: z.string(),
    displayName: z.string(),
  }),
  issue: z.object({
    key: z.string(),
  }),
  changelog: z.object({
    items: z.array(changelogItemSchema),
  }),
});

export function parseJiraWebhook(
  body: unknown,
): TicketTransitionEvent | null {
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

  return {
    source: "jira",
    externalTicketId: issue.key,
    fromColumn: statusChange.fromString,
    toColumn: statusChange.toString,
    actor: user.displayName,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/jira.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/jira.ts src/webhooks/jira.test.ts
git commit -m "feat: add Jira webhook parser with Zod validation"
```

---

## Chunk 4: Webhook Router

### Task 7: Webhook Router

**Files:**
- Create: `src/webhooks/router.ts`
- Create: `src/webhooks/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/webhooks/router.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("routeTicketTransition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  const makeEvent = (from: string, to: string) => ({
    source: "jira" as const,
    externalTicketId: "PROJ-42",
    fromColumn: from,
    toColumn: to,
    actor: "Mia",
  });

  it("logs start new work when ticket moves to AI column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "AI"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("logs review fix when ticket moves from AI Review to AI In Progress", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("AI Review", "AI In Progress"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: pick up review comments"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("logs clarification resume when ticket moves from Backlog to AI In Progress", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("Backlog", "AI In Progress"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: resume after clarification"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("logs cancel when ticket leaves AI In Progress to an unrecognized column", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("AI In Progress", "Done"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: cancel active agent run"),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PROJ-42"),
    );
    spy.mockRestore();
  });

  it("does not log for irrelevant transitions", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "In Progress"));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("matches column names case-insensitively", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "ai"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    spy.mockRestore();
  });

  it("trims whitespace from column names", async () => {
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "  AI  "));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    spy.mockRestore();
  });

  it("uses custom column names from env", async () => {
    vi.stubEnv("COLUMN_AI", "Custom AI");
    const { routeTicketTransition } = await import("./router.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    routeTicketTransition(makeEvent("To Do", "Custom AI"));

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("TODO: start new work"),
    );
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: FAIL — cannot resolve `./router.js`

- [ ] **Step 3: Implement the router**

Create `src/webhooks/router.ts`:

```typescript
import { env } from "../env.js";
import type { TicketTransitionEvent } from "./types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function routeTicketTransition(event: TicketTransitionEvent): void {
  const from = normalize(event.fromColumn);
  const to = normalize(event.toColumn);

  const colAi = normalize(env.COLUMN_AI);
  const colInProgress = normalize(env.COLUMN_AI_IN_PROGRESS);
  const colReview = normalize(env.COLUMN_AI_REVIEW);
  const colBacklog = normalize(env.COLUMN_BACKLOG);

  if (to === colAi) {
    console.log(
      `TODO: start new work for ticket ${event.externalTicketId}`,
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
      `TODO: resume after clarification for ticket ${event.externalTicketId}`,
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/webhooks/router.ts src/webhooks/router.test.ts
git commit -m "feat: add webhook router with configurable column matching"
```

---

## Chunk 5: Fastify Route Integration

### Task 8: Register POST /webhooks/jira Route

**Files:**
- Modify: `src/index.ts:5-12`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/index.test.ts`. The file already has mocks for `ioredis` and `bullmq` and a `describe("GET /health", ...)` block. Add a new describe block after the existing one:

```typescript
describe("POST /webhooks/jira", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("PORT", "0");
  });

  it("returns 200 for a valid status transition", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      payload: {
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
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns 200 for a non-status-change webhook", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      payload: {
        user: { accountId: "abc", displayName: "Mia" },
        issue: { key: "PROJ-1" },
        changelog: {
          items: [
            {
              field: "summary",
              fieldtype: "jira",
              fromString: "Old",
              toString: "New",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns 200 for a malformed payload", async () => {
    const { buildApp } = await import("./index.js");
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/jira",
      payload: { garbage: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — 404 on `POST /webhooks/jira`

- [ ] **Step 3: Register the webhook route in index.ts**

In `src/index.ts`, add imports at the top:

```typescript
import { parseJiraWebhook } from "./webhooks/jira.js";
import { routeTicketTransition } from "./webhooks/router.js";
```

Inside the `buildApp()` function, after the `/health` route, add:

```typescript
app.post("/webhooks/jira", async (request) => {
  const event = parseJiraWebhook(request.body);
  if (event) {
    routeTicketTransition(event);
  }
  return { ok: true };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/index.test.ts`
Expected: All tests PASS (health + webhook)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS across all files

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: add POST /webhooks/jira route with parser and router"
```
