# Slack Messaging Adapter Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Slack messaging adapter so Blazebot can send notifications (PR ready, clarification needed, retries exhausted) to Slack, and wire adapter selection via `MESSAGING_KIND` env var — with a no-op adapter when credentials are absent (no notifications sent, no console noise).

**Architecture:** `SlackMessagingAdapter` implements the existing `MessagingAdapter` interface using `@slack/web-api`. A `NoopMessagingAdapter` silently discards all calls. A `createMessagingAdapter()` factory in `src/adapters/messaging-factory.ts` returns Slack when credentials are present, or Noop when they're not. Slack env vars (`SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL`) are optional — when missing, the factory returns `NoopMessagingAdapter` and logs a single startup warning. `ConsoleMessagingAdapter` remains for local development use but is no longer the production default. `createAdapters()` in `worker.ts` delegates to the factory.

**Tech Stack:** TypeScript, `@slack/web-api`, Vitest, Zod (env validation unchanged)

---

## Chunk 1: Slack Adapter + Noop Adapter + Factory + Wiring

### Task 1: Add `SLACK_BOT_TOKEN` and `SLACK_DEFAULT_CHANNEL` env vars

Slack credentials must be optional. When absent, no notifications are sent at all. This matches the spec's "Notifications are best-effort — never block the workflow" (Section 14.2).

**Files:**
- Modify: `src/env.ts:23-24`
- Modify: `src/env.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing tests**

Add these tests to the existing `describe("env", ...)` block in `src/env.test.ts`:

```typescript
it("allows optional SLACK_BOT_TOKEN", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.SLACK_BOT_TOKEN).toBeUndefined();
});

it("parses SLACK_BOT_TOKEN when set", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");

  const { env } = await import("./env.js");
  expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
});

it("allows optional SLACK_DEFAULT_CHANNEL", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");

  const { env } = await import("./env.js");
  expect(env.SLACK_DEFAULT_CHANNEL).toBeUndefined();
});

it("parses SLACK_DEFAULT_CHANNEL when set", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("SLACK_DEFAULT_CHANNEL", "#blazebot-notifications");

  const { env } = await import("./env.js");
  expect(env.SLACK_DEFAULT_CHANNEL).toBe("#blazebot-notifications");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/env.test.ts`
Expected: FAIL — `SLACK_BOT_TOKEN` and `SLACK_DEFAULT_CHANNEL` not in env schema.

- [ ] **Step 3: Add the env vars to `src/env.ts`**

Add these two entries inside the `server` object in `createEnv`, after the existing `MESSAGING_KIND` line (around line 23):

```typescript
SLACK_BOT_TOKEN: z.string().min(1).optional(),
SLACK_DEFAULT_CHANNEL: z.string().min(1).optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/env.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Update `.env.example`**

Add these lines after the `MESSAGING_KIND=slack` line:

```
# Slack notifications (optional — if omitted, no notifications are sent)
# SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
# SLACK_DEFAULT_CHANNEL=#blazebot-notifications
```

- [ ] **Step 6: Commit**

```bash
git add src/env.ts src/env.test.ts .env.example
git commit -m "feat: add optional SLACK_BOT_TOKEN and SLACK_DEFAULT_CHANNEL env vars"
```

---

### Task 2: Install `@slack/web-api` and create `SlackMessagingAdapter`

The adapter implements `MessagingAdapter` using the official Slack SDK. Both `notify` and `ping` call `chat.postMessage`. Errors are caught and logged — never thrown — because notifications are best-effort per spec Section 14.2.

**Files:**
- Create: `src/adapters/slack-messaging.ts`
- Create: `src/adapters/slack-messaging.test.ts`

- [ ] **Step 1: Install `@slack/web-api`**

Run: `pnpm add @slack/web-api`

- [ ] **Step 2: Write the failing tests**

Create `src/adapters/slack-messaging.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
  })),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("SlackMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a notification via chat.postMessage", async () => {
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#general");

    await adapter.notify("user-123", "PR ready for review");

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "#general",
      text: "PR ready for review",
    });
  });

  it("sends a ping via chat.postMessage", async () => {
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#alerts");

    await adapter.ping("user-456", "Needs clarification");

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "#alerts",
      text: "Needs clarification",
    });
  });

  it("does not throw when Slack API fails on notify", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("channel_not_found"));

    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#gone");

    await expect(adapter.notify("user-123", "test")).resolves.not.toThrow();
  });

  it("does not throw when Slack API fails on ping", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("channel_not_found"));

    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#gone");

    await expect(adapter.ping("user-123", "test")).resolves.not.toThrow();
  });

  it("initializes WebClient with the provided token", async () => {
    const { WebClient } = await import("@slack/web-api");
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");

    new SlackMessagingAdapter("xoxb-my-token", "#ch");

    expect(WebClient).toHaveBeenCalledWith("xoxb-my-token");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/adapters/slack-messaging.test.ts`
Expected: FAIL — `SlackMessagingAdapter` does not exist.

- [ ] **Step 4: Implement `SlackMessagingAdapter`**

Create `src/adapters/slack-messaging.ts`:

```typescript
import { WebClient } from "@slack/web-api";
import { createLogger } from "../logger.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export class SlackMessagingAdapter implements MessagingAdapter {
  private client: WebClient;
  private defaultChannel: string;

  constructor(token: string, defaultChannel: string) {
    this.client = new WebClient(token);
    this.defaultChannel = defaultChannel;
  }

  async notify(_userId: string, message: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: this.defaultChannel,
        text: message,
      });
      logger.info({ channel: this.defaultChannel }, "slack_notification_sent");
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : "Unknown error", channel: this.defaultChannel },
        "slack_notification_failed",
      );
    }
  }

  async ping(_userId: string, message: string): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel: this.defaultChannel,
        text: message,
      });
      logger.info({ channel: this.defaultChannel }, "slack_ping_sent");
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : "Unknown error", channel: this.defaultChannel },
        "slack_ping_failed",
      );
    }
  }
}
```

Note: `_userId` is unused in MVP — Slack DM routing (per-user notifications via Jira→Slack user mapping) is deferred per spec Section 18.2. Messages go to the configured default channel.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/adapters/slack-messaging.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/slack-messaging.ts src/adapters/slack-messaging.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add SlackMessagingAdapter with best-effort delivery (spec Section 11.3)"
```

---

### Task 3: Create `NoopMessagingAdapter` and `createMessagingAdapter` factory

When no messaging provider is configured (missing credentials), the system should silently skip notifications — not fake them through console output. `NoopMessagingAdapter` does nothing: its methods are empty async functions. The factory returns it when credentials are absent.

`ConsoleMessagingAdapter` remains in the codebase for explicit local development use (e.g., if someone wants to see notification payloads in logs during debugging) but is not the default fallback.

**Files:**
- Create: `src/adapters/noop-messaging.ts`
- Create: `src/adapters/noop-messaging.test.ts`
- Create: `src/adapters/messaging-factory.ts`
- Create: `src/adapters/messaging-factory.test.ts`

- [ ] **Step 1: Write the failing tests for `NoopMessagingAdapter`**

Create `src/adapters/noop-messaging.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { NoopMessagingAdapter } from "./noop-messaging.js";

describe("NoopMessagingAdapter", () => {
  it("implements MessagingAdapter interface", () => {
    const adapter = new NoopMessagingAdapter();
    expect(typeof adapter.notify).toBe("function");
    expect(typeof adapter.ping).toBe("function");
  });

  it("notify resolves without doing anything", async () => {
    const adapter = new NoopMessagingAdapter();
    await expect(adapter.notify("user", "message")).resolves.toBeUndefined();
  });

  it("ping resolves without doing anything", async () => {
    const adapter = new NoopMessagingAdapter();
    await expect(adapter.ping("user", "message")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/noop-messaging.test.ts`
Expected: FAIL — `NoopMessagingAdapter` does not exist.

- [ ] **Step 3: Implement `NoopMessagingAdapter`**

Create `src/adapters/noop-messaging.ts`:

```typescript
import type { MessagingAdapter } from "./messaging.js";

export class NoopMessagingAdapter implements MessagingAdapter {
  async notify(): Promise<void> {}
  async ping(): Promise<void> {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/noop-messaging.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Write the failing tests for the factory**

Create `src/adapters/messaging-factory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("createMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns SlackMessagingAdapter when token and channel are provided", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");

    const adapter = createMessagingAdapter("slack", "xoxb-test", "#general");

    expect(adapter).toBeInstanceOf(SlackMessagingAdapter);
  });

  it("returns NoopMessagingAdapter when SLACK_BOT_TOKEN is missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", undefined, "#general");

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_BOT_TOKEN"),
    );
  });

  it("returns NoopMessagingAdapter when SLACK_DEFAULT_CHANNEL is missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", "xoxb-test", undefined);

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_DEFAULT_CHANNEL"),
    );
  });

  it("returns NoopMessagingAdapter when both credentials are missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", undefined, undefined);

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
  });

  it("returns NoopMessagingAdapter for unknown messaging kind", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("unknown" as "slack", undefined, undefined);

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/adapters/messaging-factory.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement the factory**

Create `src/adapters/messaging-factory.ts`:

```typescript
import { createLogger } from "../logger.js";
import { NoopMessagingAdapter } from "./noop-messaging.js";
import { SlackMessagingAdapter } from "./slack-messaging.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export function createMessagingAdapter(
  kind: string,
  slackBotToken: string | undefined,
  slackDefaultChannel: string | undefined,
): MessagingAdapter {
  if (kind === "slack") {
    if (!slackBotToken) {
      logger.warn("SLACK_BOT_TOKEN not set — notifications disabled");
      return new NoopMessagingAdapter();
    }
    if (!slackDefaultChannel) {
      logger.warn("SLACK_DEFAULT_CHANNEL not set — notifications disabled");
      return new NoopMessagingAdapter();
    }
    return new SlackMessagingAdapter(slackBotToken, slackDefaultChannel);
  }

  return new NoopMessagingAdapter();
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/adapters/messaging-factory.test.ts src/adapters/noop-messaging.test.ts`
Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/noop-messaging.ts src/adapters/noop-messaging.test.ts src/adapters/messaging-factory.ts src/adapters/messaging-factory.test.ts
git commit -m "feat: add NoopMessagingAdapter and createMessagingAdapter factory"
```

---

### Task 4: Wire factory into `createAdapters()` in `worker.ts`

Replace the hardcoded `ConsoleMessagingAdapter` in `createAdapters()` with the factory, and update the worker test to verify correct wiring.

**Files:**
- Modify: `src/worker.ts:12,27-36`
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/worker.test.ts`, the existing mock for `console-messaging.js` needs to be replaced with a mock for `messaging-factory.js`. Replace the existing console-messaging mock:

```typescript
// REMOVE this mock:
// vi.mock("./adapters/console-messaging.js", () => ({
//   ConsoleMessagingAdapter: vi.fn().mockImplementation(function (this: unknown) {
//     return mockMessaging;
//   }),
// }));

// ADD this mock:
vi.mock("./adapters/messaging-factory.js", () => ({
  createMessagingAdapter: vi.fn().mockReturnValue(mockMessaging),
}));
```

Then add a new test inside the `describe("worker handler", ...)` block:

```typescript
it("uses createMessagingAdapter factory for notifications", async () => {
  const { createMessagingAdapter } = await import("./adapters/messaging-factory.js");

  mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
  mockRunSandbox.mockResolvedValue({
    exitCode: 0,
    status: "complete",
    summary: "Done",
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

  expect(createMessagingAdapter).toHaveBeenCalled();
  expect(mockMessaging.notify).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/worker.test.ts`
Expected: FAIL — worker still imports `ConsoleMessagingAdapter` directly.

- [ ] **Step 3: Update `createAdapters()` in `src/worker.ts`**

Replace the import:

```typescript
// REMOVE:
import { ConsoleMessagingAdapter } from "./adapters/console-messaging.js";

// ADD:
import { createMessagingAdapter } from "./adapters/messaging-factory.js";
```

Replace the `createAdapters` function body:

```typescript
function createAdapters() {
  const jira = new JiraClient(
    env.JIRA_BASE_URL!,
    env.JIRA_USER_EMAIL!,
    env.JIRA_API_TOKEN!,
  );
  const github = new GitHubClient(env.GITHUB_TOKEN!);
  const messaging = createMessagingAdapter(
    env.MESSAGING_KIND,
    env.SLACK_BOT_TOKEN,
    env.SLACK_DEFAULT_CHANNEL,
  );
  return { jira, github, messaging };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: wire createMessagingAdapter factory into worker (spec Section 11.3)"
```

---

## Spec Alignment Notes

This plan implements:
- **Spec Section 3.3** — Messaging API (Slack) as MVP external dependency.
- **Spec Section 11.3** — `notify(message) → void` interface, now with a real Slack implementation.
- **Spec Section 11.5** — Adapter Registration: `MESSAGING_KIND` env var now drives adapter selection. Swapping adapters is a single-module replacement.
- **Spec Section 14.2** — "Can't send notification → Log warning, don't block workflow." When credentials are absent, `NoopMessagingAdapter` silently discards notifications. When Slack is configured but the API fails, the error is caught and logged as a warning — workflow continues unblocked.

Design decisions:
- **No-op by default** — When `SLACK_BOT_TOKEN` or `SLACK_DEFAULT_CHANNEL` is missing, `createMessagingAdapter` returns `NoopMessagingAdapter`. No notifications are sent, no console noise. A single warning is logged at factory creation time to explain why.
- **No console fallback** — `ConsoleMessagingAdapter` is not used as a fallback. It remains in the codebase for explicit local development use but is never selected automatically. If you want notifications, configure Slack. If you don't, nothing happens.
- **Channel-based routing (not DM)** — Per-user Slack DMs require a Jira→Slack user mapping (deferred per spec Section 18.2). MVP sends all notifications to a default channel. The `_userId` parameter is accepted but unused.
- **Best-effort delivery** — `SlackMessagingAdapter` catches all errors from `chat.postMessage` and logs them. It never throws. This prevents Slack outages from blocking ticket workflows.
- **Factory pattern** — `createMessagingAdapter()` is a pure function that takes the kind + credentials and returns a `MessagingAdapter`. No global state, easy to test, and ready for future adapters (Teams, etc.) via additional `else if` branches.
