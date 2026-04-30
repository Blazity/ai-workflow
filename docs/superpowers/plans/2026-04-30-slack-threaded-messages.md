# Slack Threaded Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group all per-ticket Slack notifications under one lifetime thread per ticket, and replace inline message strings with structured `TicketEvent`s rendered to Slack-mrkdwn with clickable Jira/PR links.

**Architecture:** Replace `MessagingAdapter.notify(message)` with `notifyForTicket(ticketKey, event)`. The adapter becomes "smart" — it formats events to wire text, looks up the ticket's parent message id from a new `ThreadStore`, posts as a thread reply when one exists (top-level otherwise), and records the parent on the first `started` event. `UpstashRunRegistry` implements `ThreadStore` via a new redis hash `blazebot:thread-parents:{ENV}`. Threading is by-message via `ThreadImpl` from the `chat` package: top-level posts use the existing `chat.channel(...).post(...)` path; thread replies construct a `ThreadImpl({ id: "slack:CHANNEL:PARENT_TS", ... })` and call `.post(...)` on it.

**Tech Stack:** TypeScript / Node 24 / Vercel Workflow / Upstash Redis (`@upstash/redis`) / `chat` + `@chat-adapter/slack` / Vitest

**Source spec:** `docs/superpowers/specs/2026-04-30-slack-threaded-messages-design.md`.

---

## File Structure

```text
src/
├── adapters/
│   ├── messaging/
│   │   ├── types.ts            # MODIFIED — replace notify() with notifyForTicket(); add TicketEvent + ThreadStore
│   │   ├── format.ts           # NEW — formatTicketEvent(event, ticketKey, jiraBaseUrl): string
│   │   ├── format.test.ts      # NEW — pure-function tests for each event variant
│   │   ├── chatsdk.ts          # MODIFIED — drop notify(), add notifyForTicket() with threading
│   │   └── chatsdk.test.ts     # REWRITTEN — covers threading, fallback, formatter integration
│   └── run-registry/
│       ├── types.ts            # MODIFIED — add ThreadStore interface (separate from RunRegistryAdapter)
│       ├── upstash.ts          # MODIFIED — implement ThreadStore methods + new THREAD_HASH_KEY
│       └── upstash.test.ts     # MODIFIED — add ThreadStore round-trip tests
├── lib/
│   ├── adapters.ts             # MODIFIED — pass jiraBaseUrl + threadStore (= runRegistry) into ChatSDKAdapter
│   └── step-adapters.ts        # MODIFIED — same change as adapters.ts
├── routes/
│   ├── cron/poll.get.ts        # MODIFIED — replace notify() call at L23 with notifyForTicket(...)
│   └── webhooks/jira.post.ts   # MODIFIED — replace notify() call at L110 with notifyForTicket(...)
└── workflows/
    └── agent.ts                # MODIFIED — replace notifySlack(string) step with notifyTicket(key, event)
```

**File-responsibility split:**

- `format.ts` owns event-to-string conversion. It's pure (no side-effects, no config beyond inputs) so it tests in isolation and the adapter's tests don't need to assert on full text.
- `chatsdk.ts` owns Slack I/O: thread store reads, post, missing-parent recovery, parent-set on first `started`.
- `ThreadStore` is split from `RunRegistryAdapter` even though the same class implements both — the messaging adapter shouldn't see (or be able to call) `markFailed` etc. when all it needs is parent-message lookup.

---

## Phase 1 — ThreadStore on the run registry

Goal: ship the redis-backed parent-message store, fully tested, before touching messaging. This task block is mergeable on its own — nothing reads from the new hash yet.

### Task 1: Add `ThreadStore` interface

**Files:**
- Modify: `src/adapters/run-registry/types.ts`

- [ ] **Step 1: Append the ThreadStore interface to the existing types file**

Append this to the bottom of `src/adapters/run-registry/types.ts` (do not modify the existing `RunRegistryAdapter`):

```ts
/**
 * Per-ticket Slack thread parent store. Implemented alongside RunRegistryAdapter
 * by UpstashRunRegistry, but exposed as a separate interface so the messaging
 * adapter only depends on the slice it needs.
 *
 * Lifetime: an entry survives across multiple workflow runs for the same
 * ticket. unregister(ticketKey) does NOT clear it — see clearParent().
 */
export interface ThreadStore {
  /** Returns the Slack message id (timestamp) anchoring this ticket's thread, or null. */
  getParent(ticketKey: string): Promise<string | null>;
  /** Records the message id as the parent for this ticket. Overwrites any prior value. */
  setParent(ticketKey: string, messageId: string): Promise<void>;
  /** Removes the entry. Used after Slack reports the parent message no longer exists. */
  clearParent(ticketKey: string): Promise<void>;
}
```

- [ ] **Step 2: Verify type-checks pass**

Run: `pnpm tsc --noEmit`
Expected: no new type errors. (No callers exist yet, so this is just a syntax/types sanity check.)

- [ ] **Step 3: Commit**

```bash
git add src/adapters/run-registry/types.ts
git commit -m "feat(run-registry): add ThreadStore interface"
```

---

### Task 2: Implement `ThreadStore` on `UpstashRunRegistry`

**Files:**
- Modify: `src/adapters/run-registry/upstash.ts`

- [ ] **Step 1: Add the new hash key constant**

In `src/adapters/run-registry/upstash.ts`, add a new constant alongside the existing `*_HASH_KEY` lines (immediately after `ENTRY_TS_HASH_KEY`):

```ts
const THREAD_HASH_KEY = `blazebot:thread-parents:${ENV_PREFIX}`;
```

- [ ] **Step 2: Add `ThreadStore` to the class's implements clause and import**

Update the class declaration:

```ts
import type { RunRegistryAdapter, FailedTicketMeta, ThreadStore } from "./types.js";
```

```ts
export class UpstashRunRegistry implements RunRegistryAdapter, ThreadStore {
```

- [ ] **Step 3: Implement the three ThreadStore methods**

Append these methods to `UpstashRunRegistry` (after `clearFailedMark`, before the closing `}`):

```ts
  async getParent(ticketKey: string): Promise<string | null> {
    return this.redis.hget<string>(THREAD_HASH_KEY, ticketKey);
  }

  async setParent(ticketKey: string, messageId: string): Promise<void> {
    await this.redis.hset(THREAD_HASH_KEY, { [ticketKey]: messageId });
    // Defend against any external TTL — the thread mapping must outlive runs.
    await this.redis.persist(THREAD_HASH_KEY);
  }

  async clearParent(ticketKey: string): Promise<void> {
    await this.redis.hdel(THREAD_HASH_KEY, ticketKey);
  }
```

- [ ] **Step 4: Verify `unregister` does NOT touch the thread hash**

Read `unregister` in the same file. It should still only delete from `HASH_KEY`, `SANDBOX_HASH_KEY`, and `ENTRY_TS_HASH_KEY`. Do not modify it.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/run-registry/upstash.ts
git commit -m "feat(run-registry): implement ThreadStore on UpstashRunRegistry"
```

---

### Task 3: Tests for `ThreadStore` on `UpstashRunRegistry`

**Files:**
- Modify: `src/adapters/run-registry/upstash.test.ts`

- [ ] **Step 1: Add the THREAD_HASH_KEY constant near the existing FAILED_HASH_KEY one**

In `src/adapters/run-registry/upstash.test.ts`, near the bottom describe blocks (before `describe("markFailed", ...)` is fine), or near the top alongside `HASH_KEY`:

```ts
const THREAD_HASH_KEY = `blazebot:thread-parents:${process.env.VERCEL_ENV ?? "development"}`;
```

- [ ] **Step 2: Add a `describe("ThreadStore methods", ...)` block at the bottom of the file (inside the outer describe, before its closing `})`)**

```ts
  describe("ThreadStore methods", () => {
    it("setParent then getParent round-trips the message id", async () => {
      // Phase 1: setParent writes
      const registry = createRegistry();
      await registry.setParent("AWT-42", "1700000000.000123");
      expect(mockRedis.hset).toHaveBeenCalledWith(THREAD_HASH_KEY, {
        "AWT-42": "1700000000.000123",
      });
      expect(mockRedis.persist).toHaveBeenCalledWith(THREAD_HASH_KEY);

      // Phase 2: getParent reads
      mockRedis.hget.mockResolvedValueOnce("1700000000.000123");
      const result = await registry.getParent("AWT-42");
      expect(result).toBe("1700000000.000123");
      expect(mockRedis.hget).toHaveBeenCalledWith(THREAD_HASH_KEY, "AWT-42");
    });

    it("getParent returns null when no entry exists", async () => {
      mockRedis.hget.mockResolvedValueOnce(null);
      const registry = createRegistry();
      const result = await registry.getParent("AWT-99");
      expect(result).toBeNull();
    });

    it("clearParent deletes the entry from the thread hash", async () => {
      const registry = createRegistry();
      await registry.clearParent("AWT-42");
      expect(mockRedis.hdel).toHaveBeenCalledWith(THREAD_HASH_KEY, "AWT-42");
    });

    it("unregister does not touch the thread hash", async () => {
      const registry = createRegistry();
      await registry.unregister("AWT-42");
      // unregister deletes from HASH_KEY, SANDBOX_HASH_KEY, ENTRY_TS_HASH_KEY only.
      const hdelCalls = mockRedis.hdel.mock.calls.map((c) => c[0]);
      expect(hdelCalls).not.toContain(THREAD_HASH_KEY);
    });
  });
```

- [ ] **Step 3: Run the new tests in isolation to verify they pass**

Run: `pnpm vitest run src/adapters/run-registry/upstash.test.ts`
Expected: PASS — all existing tests + the four new ones.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/run-registry/upstash.test.ts
git commit -m "test(run-registry): cover ThreadStore methods on UpstashRunRegistry"
```

---

## Phase 2 — Event types and formatter

Goal: a pure formatter that converts a `TicketEvent` to a Slack-mrkdwn string with the Jira link (and PR link for `pr_ready`). No I/O, no adapter — testable in isolation.

### Task 4: Add `TicketEvent` type and update `MessagingAdapter` interface

**Files:**
- Modify: `src/adapters/messaging/types.ts`

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/adapters/messaging/types.ts` with:

```ts
export type TicketEvent =
  | { kind: "started" }
  | { kind: "needs_clarification"; usageReport?: string }
  | {
      kind: "pr_ready";
      pr: { url: string; number: number };
      usageReport: string;
    }
  | {
      kind: "failed";
      phase?: "research" | "impl" | "push";
      reason?: string;
      usageReport?: string;
    }
  | { kind: "canceled"; reason: string };

export interface MessagingAdapter {
  /**
   * Send a ticket-scoped notification to the configured channel.
   *
   * The first `started` event for a ticket posts top-level and records its
   * Slack message id as the lifetime parent. Subsequent events post as
   * thread replies under that parent. If the parent has been deleted, the
   * adapter clears the mapping and retries top-level (without re-anchoring
   * unless the new event is `started`).
   *
   * Never throws — failures are logged and swallowed so workflow runs are
   * never broken by a notification error.
   */
  notifyForTicket(ticketKey: string, event: TicketEvent): Promise<void>;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: errors at every `notify(...)` and `messaging.notify(...)` call site (cron poll, jira webhook, agent workflow). These are addressed in later tasks. Confirm the messaging types file itself is clean (no errors *inside* the file).

- [ ] **Step 3: Do NOT commit yet**

The interface change makes the build red. Commit happens at the end of Phase 4 once all call sites are converted, so we don't ship a half-broken main.

---

### Task 5: Implement and test the event formatter

**Files:**
- Create: `src/adapters/messaging/format.ts`
- Create: `src/adapters/messaging/format.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `src/adapters/messaging/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatTicketEvent } from "./format.js";

const JIRA = "https://example.atlassian.net";
const KEY = "AWT-42";
const LINK = `<${JIRA}/browse/${KEY}|${KEY}>`;

describe("formatTicketEvent", () => {
  it("started — links the ticket key", () => {
    expect(formatTicketEvent({ kind: "started" }, KEY, JIRA)).toBe(
      `Task ${LINK} started`,
    );
  });

  it("needs_clarification — without usage report", () => {
    expect(
      formatTicketEvent({ kind: "needs_clarification" }, KEY, JIRA),
    ).toBe(`Task ${LINK} needs clarification`);
  });

  it("needs_clarification — appends usage report on a new line", () => {
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", usageReport: "Phase A: $0.10" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} needs clarification\nPhase A: $0.10`);
  });

  it("needs_clarification — empty usage report is treated as absent", () => {
    expect(
      formatTicketEvent(
        { kind: "needs_clarification", usageReport: "" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} needs clarification`);
  });

  it("pr_ready — includes PR link inline and usage report", () => {
    const text = formatTicketEvent(
      {
        kind: "pr_ready",
        pr: { url: "https://github.com/o/r/pull/123", number: 123 },
        usageReport: "Total: $0.42",
      },
      KEY,
      JIRA,
    );
    expect(text).toBe(
      `Task ${LINK} PR ready for review — <https://github.com/o/r/pull/123|#123>\nTotal: $0.42`,
    );
  });

  it("failed with phase and reason", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", phase: "research", reason: "phase timed out" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} failed: research — phase timed out`);
  });

  it("failed with reason but no phase", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", reason: "boom" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} failed: boom`);
  });

  it("failed with neither phase nor reason", () => {
    expect(
      formatTicketEvent({ kind: "failed" }, KEY, JIRA),
    ).toBe(`Task ${LINK} failed`);
  });

  it("failed — appends usage report when present", () => {
    expect(
      formatTicketEvent(
        { kind: "failed", phase: "impl", reason: "x", usageReport: "u" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} failed: impl — x\nu`);
  });

  it("canceled — includes reason", () => {
    expect(
      formatTicketEvent(
        { kind: "canceled", reason: "left AI column" },
        KEY,
        JIRA,
      ),
    ).toBe(`Task ${LINK} canceled: left AI column`);
  });

  it("trims a trailing slash on jiraBaseUrl", () => {
    expect(
      formatTicketEvent({ kind: "started" }, KEY, `${JIRA}/`),
    ).toBe(`Task ${LINK} started`);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails (module not found)**

Run: `pnpm vitest run src/adapters/messaging/format.test.ts`
Expected: FAIL with "Cannot find module './format'" (or equivalent resolution error).

- [ ] **Step 3: Implement `format.ts`**

Create `src/adapters/messaging/format.ts`:

```ts
import type { TicketEvent } from "./types.js";

/**
 * Format a TicketEvent as Slack-mrkdwn text with embedded links.
 *
 * Output is intended for `chat.channel(...).post(text)` or `thread.post(text)`.
 * Slack-native `<url|label>` syntax is used because remark/mdast escaping
 * via PostableMarkdown can mangle the angle brackets. We pass it as a plain
 * string; the chat package treats unmarked strings as PostableRaw on Slack.
 */
export function formatTicketEvent(
  event: TicketEvent,
  ticketKey: string,
  jiraBaseUrl: string,
): string {
  const link = jiraLink(ticketKey, jiraBaseUrl);
  const head = `Task ${link}`;

  switch (event.kind) {
    case "started":
      return `${head} started`;

    case "needs_clarification":
      return appendUsage(`${head} needs clarification`, event.usageReport);

    case "pr_ready": {
      const prLink = `<${event.pr.url}|#${event.pr.number}>`;
      return appendUsage(
        `${head} PR ready for review — ${prLink}`,
        event.usageReport,
      );
    }

    case "failed": {
      const body = formatFailedBody(event.phase, event.reason);
      return appendUsage(`${head} failed${body}`, event.usageReport);
    }

    case "canceled":
      return `${head} canceled: ${event.reason}`;
  }
}

function jiraLink(ticketKey: string, jiraBaseUrl: string): string {
  const base = jiraBaseUrl.replace(/\/$/, "");
  return `<${base}/browse/${ticketKey}|${ticketKey}>`;
}

function formatFailedBody(
  phase: "research" | "impl" | "push" | undefined,
  reason: string | undefined,
): string {
  if (phase && reason) return `: ${phase} — ${reason}`;
  if (reason) return `: ${reason}`;
  return "";
}

function appendUsage(base: string, usageReport: string | undefined): string {
  if (!usageReport) return base;
  return `${base}\n${usageReport}`;
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `pnpm vitest run src/adapters/messaging/format.test.ts`
Expected: PASS — all 11 cases.

- [ ] **Step 5: Commit (formatter only — adapter and call-site changes ride together later)**

```bash
git add src/adapters/messaging/format.ts src/adapters/messaging/format.test.ts
git commit -m "feat(messaging): add ticket event formatter with Jira/PR mrkdwn links"
```

---

## Phase 3 — Adapter rewrite

Goal: replace `notify()` with `notifyForTicket()` in `ChatSDKAdapter`, including missing-parent recovery. Tests are rewritten to match.

### Task 6: Rewrite `ChatSDKAdapter` around `notifyForTicket`

**Files:**
- Modify: `src/adapters/messaging/chatsdk.ts`

- [ ] **Step 1: Replace the file contents**

Replace `src/adapters/messaging/chatsdk.ts` with:

```ts
import { Chat, ThreadImpl } from "chat";
import type { StateAdapter, Lock } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { logger } from "../../lib/logger.js";
import { formatTicketEvent } from "./format.js";
import type { MessagingAdapter, TicketEvent } from "./types.js";
import type { ThreadStore } from "../run-registry/types.js";

export interface ChatSDKConfig {
  slackToken: string;
  channelId: string;
  botName: string;
  jiraBaseUrl: string;
  threadStore: ThreadStore;
}

/** Minimal no-op StateAdapter for outbound-only notification use. */
const noopState: StateAdapter = {
  acquireLock: async () => null,
  appendToList: async () => {},
  connect: async () => {},
  delete: async () => {},
  disconnect: async () => {},
  extendLock: async () => false,
  forceReleaseLock: async () => {},
  get: async () => null,
  getList: async () => [],
  isSubscribed: async () => false,
  releaseLock: async (_lock: Lock) => {},
  set: async () => {},
  setIfNotExists: async () => false,
  subscribe: async () => {},
  unsubscribe: async () => {},
};

/**
 * Slack error codes that mean "the parent message is gone."
 * When we see one of these on a thread reply, we clear the stored parent
 * and retry top-level. List sourced from Slack's chat.postMessage docs;
 * exact codes are confirmed during smoke-testing (deliberately delete a
 * parent in a test channel).
 */
const MISSING_PARENT_ERROR_CODES = new Set([
  "thread_not_found",
  "message_not_found",
]);

export class ChatSDKAdapter implements MessagingAdapter {
  private chat: InstanceType<typeof Chat>;
  private slackAdapter: ReturnType<typeof createSlackAdapter>;
  private channelId: string;
  private jiraBaseUrl: string;
  private threadStore: ThreadStore;

  constructor(config: ChatSDKConfig) {
    this.channelId = config.channelId;
    this.jiraBaseUrl = config.jiraBaseUrl;
    this.threadStore = config.threadStore;
    this.slackAdapter = createSlackAdapter({ botToken: config.slackToken });
    this.chat = new Chat({
      userName: config.botName,
      state: noopState,
      adapters: { slack: this.slackAdapter },
    });
  }

  async notifyForTicket(
    ticketKey: string,
    event: TicketEvent,
  ): Promise<void> {
    const text = formatTicketEvent(event, ticketKey, this.jiraBaseUrl);
    let parent = await this.threadStore.getParent(ticketKey).catch(() => null);

    let sentId: string | null = null;
    try {
      sentId = parent
        ? await this.postReply(parent, text)
        : await this.postTopLevel(text);
    } catch (err) {
      if (parent && isMissingParentError(err)) {
        logger.debug(
          { ticketKey, parent, eventKind: event.kind },
          "thread_parent_recovered",
        );
        await this.threadStore.clearParent(ticketKey).catch(() => {});
        parent = null;
        try {
          sentId = await this.postTopLevel(text);
        } catch (retryErr) {
          this.logFailure(ticketKey, event.kind, retryErr);
          return;
        }
      } else {
        this.logFailure(ticketKey, event.kind, err);
        return;
      }
    }

    if (event.kind === "started" && parent == null && sentId) {
      await this.threadStore
        .setParent(ticketKey, sentId)
        .catch((err) =>
          logger.warn(
            { ticketKey, error: (err as Error).message },
            "thread_parent_persist_failed",
          ),
        );
    }

    logger.info(
      {
        ticketKey,
        eventKind: event.kind,
        threadParentId: parent,
        channelId: this.channelId,
      },
      "notification_sent",
    );
  }

  /** Top-level post to the configured channel. Returns the sent message id. */
  private async postTopLevel(text: string): Promise<string> {
    const channel = this.chat.channel(`slack:${this.channelId}`);
    const sent = await channel.post(text);
    return sent.id;
  }

  /** Thread reply under `parentTs`. Returns the sent message id. */
  private async postReply(parentTs: string, text: string): Promise<string> {
    const thread = new ThreadImpl({
      id: `slack:${this.channelId}:${parentTs}`,
      adapter: this.slackAdapter,
      channelId: `slack:${this.channelId}`,
      stateAdapter: noopState,
      isDM: false,
    });
    const sent = await thread.post(text);
    return sent.id;
  }

  private logFailure(
    ticketKey: string,
    eventKind: TicketEvent["kind"],
    err: unknown,
  ): void {
    logger.warn(
      {
        ticketKey,
        eventKind,
        error: (err as Error).message,
        slackErrorCode: extractSlackErrorCode(err),
      },
      "notification_failed",
    );
  }
}

function isMissingParentError(err: unknown): boolean {
  const code = extractSlackErrorCode(err);
  return code != null && MISSING_PARENT_ERROR_CODES.has(code);
}

/**
 * Pull a Slack-style error code out of an unknown error. The chat package
 * surfaces Slack errors as ChatError-derived objects with a `code` string;
 * the underlying Web API error code may also live on `data.error` for raw
 * errors. We check both locations defensively.
 */
function extractSlackErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; data?: { error?: unknown } };
  if (typeof e.code === "string") return e.code;
  if (e.data && typeof e.data.error === "string") return e.data.error;
  return null;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: errors only at the call sites in `src/lib/adapters.ts`, `src/lib/step-adapters.ts`, `src/workflows/agent.ts`, `src/routes/cron/poll.get.ts`, `src/routes/webhooks/jira.post.ts`. The adapter file itself is clean.

- [ ] **Step 3: Do not commit yet** (call sites still broken — wired in Phase 4).

---

### Task 7: Rewrite `chatsdk.test.ts`

**Files:**
- Modify: `src/adapters/messaging/chatsdk.test.ts`

- [ ] **Step 1: Replace the file contents**

Replace `src/adapters/messaging/chatsdk.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatSDKAdapter } from "./chatsdk.js";
import type { ThreadStore } from "../run-registry/types.js";

const mockChannelPost = vi.fn();
const mockThreadPost = vi.fn();

vi.mock("chat", () => {
  return {
    Chat: vi.fn(() => ({
      channel: vi.fn((id: string) => ({
        id,
        post: mockChannelPost,
      })),
    })),
    ThreadImpl: vi.fn(function (this: { id: string; post: typeof mockThreadPost }, cfg: { id: string }) {
      this.id = cfg.id;
      this.post = mockThreadPost;
    }),
  };
});

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn(() => ({ name: "slack" })),
}));

function createThreadStore(): ThreadStore & {
  getParent: ReturnType<typeof vi.fn>;
  setParent: ReturnType<typeof vi.fn>;
  clearParent: ReturnType<typeof vi.fn>;
} {
  return {
    getParent: vi.fn().mockResolvedValue(null),
    setParent: vi.fn().mockResolvedValue(undefined),
    clearParent: vi.fn().mockResolvedValue(undefined),
  };
}

function createAdapter(threadStore: ThreadStore) {
  return new ChatSDKAdapter({
    slackToken: "xoxb-test",
    channelId: "C123",
    botName: "blazebot",
    jiraBaseUrl: "https://jira.example.com",
    threadStore,
  });
}

const JIRA_LINK = "<https://jira.example.com/browse/AWT-42|AWT-42>";

describe("ChatSDKAdapter.notifyForTicket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelPost.mockResolvedValue({ id: "1700000000.000111" });
    mockThreadPost.mockResolvedValue({ id: "1700000000.000222" });
  });

  it("started with no parent — posts top-level and records the parent", async () => {
    const store = createThreadStore();
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "started" });

    expect(mockChannelPost).toHaveBeenCalledWith(`Task ${JIRA_LINK} started`);
    expect(mockThreadPost).not.toHaveBeenCalled();
    expect(store.setParent).toHaveBeenCalledWith("AWT-42", "1700000000.000111");
  });

  it("subsequent event with parent set — posts as thread reply, does not setParent", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "needs_clarification",
      usageReport: "u",
    });

    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(mockThreadPost).toHaveBeenCalledWith(
      `Task ${JIRA_LINK} needs clarification\nu`,
    );
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("non-started event with no parent — posts top-level, does NOT setParent (orphan stays orphan)", async () => {
    const store = createThreadStore();
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "canceled",
      reason: "left AI column",
    });

    expect(mockChannelPost).toHaveBeenCalledWith(
      `Task ${JIRA_LINK} canceled: left AI column`,
    );
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("parent deleted on Slack — clears mapping, retries top-level, re-records on started", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("thread gone"), { code: "thread_not_found" }),
    );
    mockChannelPost.mockResolvedValueOnce({ id: "1700000000.000999" });
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "started" });

    expect(mockThreadPost).toHaveBeenCalledTimes(1);
    expect(store.clearParent).toHaveBeenCalledWith("AWT-42");
    expect(mockChannelPost).toHaveBeenCalledTimes(1);
    // Because the event is `started`, the new top-level message becomes the parent.
    expect(store.setParent).toHaveBeenCalledWith("AWT-42", "1700000000.000999");
  });

  it("parent deleted on Slack for non-started event — clears + retries, does not re-anchor", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { code: "message_not_found" }),
    );
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "failed",
      phase: "impl",
      reason: "boom",
    });

    expect(store.clearParent).toHaveBeenCalledWith("AWT-42");
    expect(mockChannelPost).toHaveBeenCalledWith(
      `Task ${JIRA_LINK} failed: impl — boom`,
    );
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("non-missing-parent error — does not retry, does not throw", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { code: "rate_limited" }),
    );
    const adapter = createAdapter(store);

    await expect(
      adapter.notifyForTicket("AWT-42", { kind: "started" }),
    ).resolves.not.toThrow();
    expect(store.clearParent).not.toHaveBeenCalled();
    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("top-level post failure — swallows error, no parent recorded", async () => {
    const store = createThreadStore();
    mockChannelPost.mockRejectedValueOnce(new Error("Slack API down"));
    const adapter = createAdapter(store);

    await expect(
      adapter.notifyForTicket("AWT-42", { kind: "started" }),
    ).resolves.not.toThrow();
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("pr_ready — formats with PR link inline", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "pr_ready",
      pr: { url: "https://github.com/o/r/pull/7", number: 7 },
      usageReport: "Total: $0.10",
    });

    expect(mockThreadPost).toHaveBeenCalledWith(
      `Task ${JIRA_LINK} PR ready for review — <https://github.com/o/r/pull/7|#7>\nTotal: $0.10`,
    );
  });
});
```

- [ ] **Step 2: Run only this test file — confirm it passes**

Run: `pnpm vitest run src/adapters/messaging/chatsdk.test.ts`
Expected: PASS — 8 cases.

- [ ] **Step 3: Commit the adapter + tests together**

```bash
git add src/adapters/messaging/types.ts src/adapters/messaging/chatsdk.ts src/adapters/messaging/chatsdk.test.ts
git commit -m "feat(messaging): replace notify() with notifyForTicket() and lifetime threading"
```

(Note: this commit makes call-site files temporarily fail typecheck. They are fixed in Phase 4 within the same PR, so main is never red. If you are using subagent-driven development, the next subagent should pick up immediately.)

---

## Phase 4 — Wire up call sites

Goal: convert every `messaging.notify(...)` and `notifySlack(...)` call to `notifyForTicket(ticketKey, event)`, and wire the new constructor args.

### Task 8: Pass `jiraBaseUrl` and `threadStore` into `ChatSDKAdapter`

**Files:**
- Modify: `src/lib/adapters.ts`
- Modify: `src/lib/step-adapters.ts`

- [ ] **Step 1: Update `src/lib/adapters.ts` — instantiate the run registry first, then reuse it as the thread store**

Replace the body of `createAdapters()` with:

```ts
export function createAdapters(): Adapters {
  const runRegistry = new UpstashRunRegistry({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
  });
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
      jiraBaseUrl: env.JIRA_BASE_URL,
      threadStore: runRegistry,
    }),
    runRegistry,
  };
}
```

- [ ] **Step 2: Apply the same change to `src/lib/step-adapters.ts`**

Replace the body of `createStepAdapters()` with the analogous version (same pattern, same fields — only the function name differs):

```ts
export function createStepAdapters(): StepAdapters {
  const runRegistry = new UpstashRunRegistry({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
  });
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
      jiraBaseUrl: env.JIRA_BASE_URL,
      threadStore: runRegistry,
    }),
    runRegistry,
  };
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: errors only at the three remaining `notify(...)` and `notifySlack(...)` call sites — `agent.ts`, `cron/poll.get.ts`, `webhooks/jira.post.ts`.

---

### Task 9: Convert `cron/poll.get.ts` and `webhooks/jira.post.ts`

**Files:**
- Modify: `src/routes/cron/poll.get.ts`
- Modify: `src/routes/webhooks/jira.post.ts`

- [ ] **Step 1: Update `src/routes/cron/poll.get.ts:23`**

Find the existing call inside the reconcile callback:

```ts
      await adapters.messaging.notify(
        `Task ${ticketKey} canceled: ${detail}.`,
      );
```

Replace with:

```ts
      await adapters.messaging.notifyForTicket(ticketKey, {
        kind: "canceled",
        reason: `${detail}.`,
      });
```

(Trailing period preserved to match today's text — the formatter does not add punctuation.)

- [ ] **Step 2: Update `src/routes/webhooks/jira.post.ts:110`**

Find the existing block:

```ts
    const cancelled = await cancelTrackedRun(ticketKey, adapters.runRegistry);
    if (cancelled) {
      await adapters.messaging.notify(
        `Task ${ticketKey} canceled: webhook confirmed ticket is outside AI column.`,
      );
    }
```

Replace the inner `notify` call (keep the surrounding `if (cancelled) { ... }`):

```ts
    const cancelled = await cancelTrackedRun(ticketKey, adapters.runRegistry);
    if (cancelled) {
      await adapters.messaging.notifyForTicket(ticketKey, {
        kind: "canceled",
        reason: "webhook confirmed ticket is outside AI column",
      });
    }
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: errors only inside `src/workflows/agent.ts`.

---

### Task 10: Convert `src/workflows/agent.ts` — replace the `notifySlack` step

**Files:**
- Modify: `src/workflows/agent.ts`

- [ ] **Step 1: Rename and retype the step function**

Find the existing step (around line 338):

```ts
async function notifySlack(message: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notify(message);
}
```

Replace with:

```ts
async function notifyTicket(ticketKey: string, event: TicketEvent) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notifyForTicket(ticketKey, event);
}
```

- [ ] **Step 2: Add the `TicketEvent` type import at the top of the file**

Locate the existing `import type { ... }` block from `../adapters/...` (the `PRComment, CheckRunResult` line). Add a sibling import:

```ts
import type { TicketEvent } from "../adapters/messaging/types.js";
```

- [ ] **Step 3: Replace the `started` notification at line 441**

```ts
    await notifySlack(`Task ${ticket.identifier} started`);
```

becomes:

```ts
    await notifyTicket(ticket.identifier, { kind: "started" });
```

- [ ] **Step 4: Replace research-timeout notification (line ~518)**

```ts
        await notifySlack(`Task ${ticket.identifier} failed: research phase timed out${usageSuffix()}`);
```

becomes:

```ts
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          phase: "research",
          reason: "phase timed out",
          usageReport: usageReportOrUndefined(),
        });
```

(Helper added in Step 11 below.)

- [ ] **Step 5: Replace research-clarification (line ~536)**

```ts
        await notifySlack(`Task ${ticket.identifier} needs clarification${usageSuffix()}`);
```

becomes:

```ts
        await notifyTicket(ticket.identifier, {
          kind: "needs_clarification",
          usageReport: usageReportOrUndefined(),
        });
```

- [ ] **Step 6: Replace research-failure (line ~543)**

```ts
        await notifySlack(`Task ${ticket.identifier} failed: research — ${research.body.slice(0, 200)}${usageSuffix()}`);
```

becomes:

```ts
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          phase: "research",
          reason: research.body.slice(0, 200),
          usageReport: usageReportOrUndefined(),
        });
```

- [ ] **Step 7: Replace impl-clarification (line ~587)**

```ts
        await notifySlack(`Task ${ticket.identifier} needs clarification${usageSuffix()}`);
```

becomes:

```ts
        await notifyTicket(ticket.identifier, {
          kind: "needs_clarification",
          usageReport: usageReportOrUndefined(),
        });
```

- [ ] **Step 8: Replace impl-failure (line ~594)**

```ts
        await notifySlack(`Task ${ticket.identifier} failed: implementation — ${implOutput.error ?? "unknown"}${usageSuffix()}`);
```

becomes:

```ts
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          phase: "impl",
          reason: implOutput.error ?? "unknown",
          usageReport: usageReportOrUndefined(),
        });
```

- [ ] **Step 9: Replace push-failure (line ~653)**

```ts
        await notifySlack(`Task ${ticket.identifier} failed: push failed — ${pushResult.error ?? "unknown"}${usageSuffix()}`);
```

becomes:

```ts
        await notifyTicket(ticket.identifier, {
          kind: "failed",
          phase: "push",
          reason: pushResult.error ?? "unknown",
          usageReport: usageReportOrUndefined(),
        });
```

- [ ] **Step 10: Replace PR-ready notification (line ~659–665) and capture the PR result**

Today the block reads:

```ts
      if (!prContext) {
        await createPullRequest(branchName, ticket.title, "");
      }
      // Notify Slack BEFORE moving the ticket out of the AI column.
      // Reconcile cancels runs whose tickets have left AI column; racing
      // that cancellation after moveTicket would skip the notification.
      const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel);
      await notifySlack(`Task ${ticket.identifier} PR ready for review\n${usageReport}`);
      await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
      await unregisterRun(ticket.identifier);
```

Replace with (capturing the new-PR return; for the existing-PR branch, reuse `prContext.findPR`-equivalent data already present):

```ts
      // We need a {url, number} regardless of whether the PR is new or pre-existing.
      // - New PR: createPullRequest returns the PullRequest ({ id, url, branch }) — capture it.
      // - Existing PR: prContext was built from vcs.findPR(branch), but findPR's return
      //   is dropped today. Re-fetch via the VCS adapter step (cheap; same call already
      //   ran on this branch earlier in the workflow).
      const pr = !prContext
        ? await createPullRequest(branchName, ticket.title, "")
        : await findPRForBranch(branchName);

      const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel);
      await notifyTicket(ticket.identifier, {
        kind: "pr_ready",
        pr: { url: pr.url, number: pr.id },
        usageReport,
      });
      await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
      await unregisterRun(ticket.identifier);
```

Add the supporting step function alongside the other VCS step wrappers (e.g., right after `createPullRequest`):

```ts
async function findPRForBranch(branchName: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  const pr = await vcs.findPR(branchName);
  if (!pr) {
    // The pr_ready branch only runs after a successful push to an existing
    // PR's branch — the PR cannot have vanished. Treat as an invariant.
    throw new Error(`Expected PR for branch ${branchName} but findPR returned null`);
  }
  return pr;
}
```

- [ ] **Step 11: Replace catch-all (line ~674)**

Today:

```ts
    await notifySlack(`Task ${ticket.identifier} failed: ${(err as Error).message ?? "unknown"}${usageSuffix()}`).catch(() => {});
```

Replace with:

```ts
    await notifyTicket(ticket.identifier, {
      kind: "failed",
      reason: (err as Error).message ?? "unknown",
      usageReport: usageReportOrUndefined(),
    }).catch(() => {});
```

- [ ] **Step 12: Add the `usageReportOrUndefined` helper next to the existing `usageSuffix`**

In `agentWorkflow`, find:

```ts
  const usageSuffix = () =>
    Object.keys(phaseUsages).length
      ? `\n${formatUsageReport(phaseUsages, priceLookup, activeModel)}`
      : "";
```

Add immediately below it:

```ts
  // Variant of usageSuffix() that returns the bare report (no leading newline)
  // or `undefined` so the messaging formatter can decide whether to render it.
  const usageReportOrUndefined = (): string | undefined =>
    Object.keys(phaseUsages).length
      ? formatUsageReport(phaseUsages, priceLookup, activeModel)
      : undefined;
```

`usageSuffix` becomes unused after Step 11. Delete it (the closure's only callers are the lines we just rewrote).

- [ ] **Step 13: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 14: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS. The following test files are touched in this change and must all pass:
- `src/adapters/messaging/format.test.ts`
- `src/adapters/messaging/chatsdk.test.ts`
- `src/adapters/run-registry/upstash.test.ts`

Existing tests for `agent.ts`, cron, and webhook handlers must continue to pass without modification — they don't assert on Slack call shapes.

- [ ] **Step 15: Commit**

```bash
git add src/lib/adapters.ts src/lib/step-adapters.ts src/routes/cron/poll.get.ts src/routes/webhooks/jira.post.ts src/workflows/agent.ts
git commit -m "feat(workflow): notify per-ticket events (start/clarify/pr/failed/cancel) into one Slack thread"
```

---

## Phase 5 — Verification

Goal: confirm Slack rendering and threading behavior against a real channel before merging. Two pieces are not exercised by unit tests:

1. Whether the Slack-mrkdwn `<url|label>` syntax survives the chat package's render pipeline.
2. Whether `thread_not_found` / `message_not_found` are the actual error codes Slack returns for a deleted parent.

### Task 11: Manual smoke verification against a real Slack channel

**Files:** none (operational task).

- [ ] **Step 1: Deploy the branch to a preview environment with a test Slack channel + Jira project configured**

Use the standard preview deploy flow for this repo (deploy via `pnpm dlx vercel deploy` or the team's preview pipeline — the user runs this).

- [ ] **Step 2: Trigger one ticket through to PR-ready**

Move a Jira ticket into the AI column. Watch the Slack channel:

Expected sequence in the channel:
1. Top-level message: `Task <jira-link|AWT-XX> started` — the `AWT-XX` text must be a clickable hyperlink.
2. Thread reply on the same message: `Task <jira-link|AWT-XX> PR ready for review — <github-link|#NN>` — both the Jira key and `#NN` are clickable.

- [ ] **Step 3: Verify link rendering**

Click the Jira link and the PR link. Both must navigate to the expected destinations. If either renders as raw `<…|…>` text instead of a hyperlink, the chat package is escaping the angle brackets — fall back to the alternate rendering option:

Edit `formatTicketEvent` callers in `chatsdk.ts` to pass the formatted string as `PostableRaw`:

```ts
// In ChatSDKAdapter, change:
const sent = await channel.post(text);
// to:
const sent = await channel.post({ raw: text });
```

(Same change for the `thread.post` call.) Re-run the smoke test. If links now render correctly, commit the change as a follow-up:

```bash
git add src/adapters/messaging/chatsdk.ts
git commit -m "fix(messaging): post raw mrkdwn so Slack hyperlinks render"
```

If they still don't render, document the failure in `.claude/learnings.md` and stop — the remediation is out of scope for this plan.

- [ ] **Step 4: Verify deleted-parent recovery**

In Slack, delete the original `started` message in the test channel. Trigger the same ticket through another full run (e.g., move it back into AI column). Observe:

Expected: a fresh top-level `Task ... started` message appears (new parent), followed by threaded subsequent messages.

Check the deployed logs for the line `thread_parent_recovered`. If the recovery path did not run (i.e., the second `started` posted as a reply under the deleted message), the Slack error code is not in `MISSING_PARENT_ERROR_CODES`. Capture the actual error code from the log line `notification_failed → slackErrorCode`, add it to the `MISSING_PARENT_ERROR_CODES` set in `chatsdk.ts`, and commit:

```bash
git add src/adapters/messaging/chatsdk.ts
git commit -m "fix(messaging): include <code> in missing-parent error code set"
```

- [ ] **Step 5: Update `.claude/learnings.md`**

Append a learning entry capturing whichever path the smoke test confirmed:

- Whether `<url|label>` renders correctly via plain string post or required `PostableRaw`.
- The exact Slack error codes seen for deleted parents.

This is a small file edit. The existing CLAUDE.md instruction (`Whenever you are corrected or discover something unexpected about this codebase, append the learning to .claude/learnings.md`) makes this mandatory regardless of outcome.

- [ ] **Step 6: Final report-out**

State to the user:

- The events posted (which ones, in which order).
- Whether links rendered correctly (and which option won — plain string vs `PostableRaw`).
- The actual Slack error code(s) seen for deleted parents (if encountered).
- Any out-of-scope follow-ups discovered.

The user reviews the smoke results and merges.

---

## Self-Review Checklist (verified)

- **Spec coverage:** every section of `2026-04-30-slack-threaded-messages-design.md` is mapped:
  - Solution / Threading Policy → Task 6 (adapter logic) + Task 5 (formatter).
  - Architecture / `ThreadStore` interface → Tasks 1–3.
  - Event Types and Formatting → Tasks 4–5.
  - Adapter Behavior pseudocode → Task 6.
  - Call-Site Changes (agent / cron / webhook) → Tasks 9–10.
  - Adapter wiring → Task 8.
  - Redis Data Model (THREAD_HASH_KEY, no TTL, untouched by `unregister`) → Task 2 + Task 3 (the "unregister leaves it alone" assertion).
  - Testing → Tasks 3, 5, 7.
  - Migration / Rollout → covered implicitly (no DB seeding required; revert is a normal git revert).
  - Observability (`thread_parent_recovered`, structured fields) → Task 6.
  - Risks (mrkdwn rendering, error codes) → Task 11 verification.
- **Placeholders:** none. Every step contains the exact code or command needed.
- **Type consistency:** `TicketEvent`, `ThreadStore`, `notifyForTicket`, `formatTicketEvent`, `findPRForBranch`, `usageReportOrUndefined`, `MISSING_PARENT_ERROR_CODES`, `THREAD_HASH_KEY` are spelled identically across every task that mentions them.
- **No half-state on main:** Phase 3 and Phase 4 commits both make the build green individually (commit boundaries align with green typecheck + green tests).
