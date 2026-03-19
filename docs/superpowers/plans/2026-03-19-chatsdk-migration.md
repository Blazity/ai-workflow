# Migrate Messaging Adapter to ChatSDK

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled `SlackMessagingAdapter` (which uses `@slack/web-api` directly) with a `ChatSDKMessagingAdapter` backed by the [ChatSDK](https://chat-sdk.dev/) library, enabling future multi-platform messaging (Discord, Teams, etc.) through ChatSDK's unified adapter system.

**Architecture:** Keep the existing `MessagingAdapter` interface as our domain contract (it has `notify` and `ping` — domain-specific methods the worker depends on). Replace only the Slack implementation with one that delegates to ChatSDK's `Chat` class and `channel.post()`. The factory and env config are updated accordingly. Noop and Console adapters remain unchanged.

**Tech Stack:** `chat` (ChatSDK core), `@chat-adapter/slack` (Slack platform adapter), vitest for testing.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/package.json` | Modify | Add `chat`, `@chat-adapter/slack`; remove `@slack/web-api` |
| `packages/shared/src/adapters/chatsdk-messaging.ts` | Create | New `ChatSDKMessagingAdapter` implementing `MessagingAdapter` via ChatSDK |
| `packages/shared/src/adapters/chatsdk-messaging.test.ts` | Create | Unit tests for the new adapter |
| `packages/shared/src/adapters/messaging-factory.ts` | Modify | Use `ChatSDKMessagingAdapter` instead of `SlackMessagingAdapter` |
| `packages/shared/src/adapters/messaging-factory.test.ts` | Modify | Update mocks and assertions for ChatSDK |
| `packages/shared/src/env.ts` | Modify | Add `SLACK_SIGNING_SECRET` env var; widen `MESSAGING_KIND` enum for future adapters |
| `packages/shared/src/adapters/slack-messaging.ts` | Delete | Replaced by `chatsdk-messaging.ts` |
| `packages/shared/src/adapters/slack-messaging.test.ts` | Delete | Replaced by `chatsdk-messaging.test.ts` |
| `packages/shared/src/index.ts` | Modify | Update re-exports |

---

### Task 1: Install ChatSDK dependencies

**Files:**
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Add ChatSDK packages**

Run from repo root:
```bash
cd packages/shared && pnpm add chat @chat-adapter/slack
```

- [ ] **Step 2: Verify installation**

```bash
pnpm ls chat @chat-adapter/slack --depth 0
```
Expected: both packages listed with versions.

- [ ] **Step 3: Verify TypeScript can resolve the modules**

```bash
cd packages/shared && npx tsc --noEmit --moduleResolution NodeNext -e "import { Chat } from 'chat'; import { createSlackAdapter } from '@chat-adapter/slack';" 2>&1 || echo "Check module resolution"
```

If resolution fails, check `tsconfig.json` for `moduleResolution` compatibility. ChatSDK ships ESM; our project is already `"type": "module"`, so this should work.

---

### Task 2: Create ChatSDKMessagingAdapter (TDD)

**Files:**
- Create: `packages/shared/src/adapters/chatsdk-messaging.ts`
- Create: `packages/shared/src/adapters/chatsdk-messaging.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/shared/src/adapters/chatsdk-messaging.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPost = vi.fn().mockResolvedValue({ id: "msg-1" });
const mockChannel = vi.fn().mockReturnValue({ post: mockPost });

vi.mock("chat", () => {
  const MockChat = vi.fn().mockImplementation(function (this: unknown) {
    (this as Record<string, unknown>).channel = mockChannel;
  });
  return { Chat: MockChat };
});

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("ChatSDKMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a notification via channel.post", async () => {
    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {} });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C123ABC");

    await adapter.notify("user-123", "PR ready for review");

    expect(mockChannel).toHaveBeenCalledWith("slack:C123ABC");
    expect(mockPost).toHaveBeenCalledWith("PR ready for review");
  });

  it("sends a ping via channel.post", async () => {
    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {} });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C456DEF");

    await adapter.ping("user-456", "Needs clarification");

    expect(mockChannel).toHaveBeenCalledWith("slack:C456DEF");
    expect(mockPost).toHaveBeenCalledWith("Needs clarification");
  });

  it("does not throw when channel.post fails on notify", async () => {
    mockPost.mockRejectedValueOnce(new Error("channel_not_found"));

    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {} });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C999");

    await expect(adapter.notify("user-123", "test")).resolves.not.toThrow();
  });

  it("does not throw when channel.post fails on ping", async () => {
    mockPost.mockRejectedValueOnce(new Error("channel_not_found"));

    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {} });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C999");

    await expect(adapter.ping("user-123", "test")).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/shared && pnpm vitest run src/adapters/chatsdk-messaging.test.ts
```
Expected: FAIL — `chatsdk-messaging.js` module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/adapters/chatsdk-messaging.ts`:

```typescript
import type { Chat } from "chat";
import { createLogger } from "../logger.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export class ChatSDKMessagingAdapter implements MessagingAdapter {
  private chat: Chat;
  private channelId: string;

  constructor(chat: Chat, platform: string, defaultChannelId: string) {
    this.chat = chat;
    this.channelId = `${platform}:${defaultChannelId}`;
  }

  async notify(_userId: string, message: string): Promise<void> {
    try {
      const channel = this.chat.channel(this.channelId);
      await channel.post(message);
      logger.info({ channelId: this.channelId }, "chatsdk_notification_sent");
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          channelId: this.channelId,
        },
        "chatsdk_notification_failed",
      );
    }
  }

  async ping(_userId: string, message: string): Promise<void> {
    try {
      const channel = this.chat.channel(this.channelId);
      await channel.post(message);
      logger.info({ channelId: this.channelId }, "chatsdk_ping_sent");
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          channelId: this.channelId,
        },
        "chatsdk_ping_failed",
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/shared && pnpm vitest run src/adapters/chatsdk-messaging.test.ts
```
Expected: All 4 tests PASS.

---

### Task 3: Update env config

**Files:**
- Modify: `packages/shared/src/env.ts`

ChatSDK's Slack adapter needs a signing secret for webhook verification. Even though our worker is outbound-only, the adapter may require it at construction time. Add it as optional. Also update `SLACK_DEFAULT_CHANNEL` docs to clarify it should be a **Slack channel ID** (e.g., `C123ABC`), not a channel name.

- [ ] **Step 1: Add SLACK_SIGNING_SECRET to env.ts**

In `packages/shared/src/env.ts`, add after the `SLACK_DEFAULT_CHANNEL` line:

```typescript
SLACK_SIGNING_SECRET: z.string().min(1).optional(),
```

- [ ] **Step 2: Verify build**

```bash
cd packages/shared && pnpm build
```
Expected: Clean build, no errors.

---

### Task 4: Update the messaging factory

**Files:**
- Modify: `packages/shared/src/adapters/messaging-factory.ts`

Replace `SlackMessagingAdapter` instantiation with ChatSDK-based adapter creation.

- [ ] **Step 1: Rewrite messaging-factory.ts**

Replace the full contents of `packages/shared/src/adapters/messaging-factory.ts`:

```typescript
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createLogger } from "../logger.js";
import { ChatSDKMessagingAdapter } from "./chatsdk-messaging.js";
import { NoopMessagingAdapter } from "./noop-messaging.js";
import type { MessagingAdapter } from "./messaging.js";

const logger = createLogger();

export function createMessagingAdapter(
  kind: string,
  slackBotToken: string | undefined,
  slackDefaultChannel: string | undefined,
  slackSigningSecret?: string | undefined,
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

    const chat = new Chat({
      userName: "blazebot",
      adapters: {
        slack: createSlackAdapter({
          botToken: slackBotToken,
          ...(slackSigningSecret && { signingSecret: slackSigningSecret }),
        }),
      },
    });

    return new ChatSDKMessagingAdapter(chat, "slack", slackDefaultChannel);
  }

  return new NoopMessagingAdapter();
}
```

- [ ] **Step 2: Update the factory call site in the worker**

In `packages/worker/src/worker.ts`, the `createAdapters()` function calls `createMessagingAdapter()` on line 47-51. Update to pass the new signing secret parameter:

```typescript
const messaging = createMessagingAdapter(
  env.MESSAGING_KIND,
  env.SLACK_BOT_TOKEN,
  env.SLACK_DEFAULT_CHANNEL,
  env.SLACK_SIGNING_SECRET,
);
```

- [ ] **Step 3: Verify build**

```bash
cd packages/shared && pnpm build && cd ../worker && pnpm build
```
Expected: Clean build.

---

### Task 5: Update factory tests

**Files:**
- Modify: `packages/shared/src/adapters/messaging-factory.test.ts`

Update mocks from `@slack/web-api` to `chat` and `@chat-adapter/slack`.

- [ ] **Step 1: Rewrite messaging-factory.test.ts**

Replace the full contents of `packages/shared/src/adapters/messaging-factory.test.ts`:

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

vi.mock("chat", () => {
  const MockChat = vi.fn().mockImplementation(function (this: unknown) {
    (this as Record<string, unknown>).channel = vi.fn().mockReturnValue({
      post: vi.fn(),
    });
  });
  return { Chat: MockChat };
});

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn().mockReturnValue({ type: "slack-adapter" }),
}));

describe("createMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ChatSDKMessagingAdapter when token and channel are provided", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");

    const adapter = createMessagingAdapter("slack", "xoxb-test", "C123ABC");

    expect(adapter).toBeInstanceOf(ChatSDKMessagingAdapter);
  });

  it("passes signing secret to createSlackAdapter when provided", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { createSlackAdapter } = await import("@chat-adapter/slack");

    createMessagingAdapter("slack", "xoxb-test", "C123ABC", "s-secret-123");

    expect(createSlackAdapter).toHaveBeenCalledWith({
      botToken: "xoxb-test",
      signingSecret: "s-secret-123",
    });
  });

  it("returns NoopMessagingAdapter when SLACK_BOT_TOKEN is missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", undefined, "C123ABC");

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

    const adapter = createMessagingAdapter(
      "unknown" as "slack",
      undefined,
      undefined,
    );

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
  });
});
```

- [ ] **Step 2: Run all adapter tests**

```bash
cd packages/shared && pnpm vitest run src/adapters/
```
Expected: All tests PASS (chatsdk-messaging, messaging-factory, noop-messaging).

---

### Task 6: Clean up — remove old Slack adapter

**Files:**
- Delete: `packages/shared/src/adapters/slack-messaging.ts`
- Delete: `packages/shared/src/adapters/slack-messaging.test.ts`
- Modify: `packages/shared/package.json` (remove `@slack/web-api`)
- Modify: `packages/shared/src/index.ts` (remove any stale re-exports if present)

- [ ] **Step 1: Delete old adapter files**

```bash
rm packages/shared/src/adapters/slack-messaging.ts packages/shared/src/adapters/slack-messaging.test.ts
```

- [ ] **Step 2: Remove @slack/web-api dependency**

```bash
cd packages/shared && pnpm remove @slack/web-api
```

- [ ] **Step 3: Verify no remaining imports of @slack/web-api or slack-messaging**

```bash
grep -r "slack/web-api\|slack-messaging" packages/shared/src/ packages/worker/src/ || echo "Clean — no stale imports"
```

- [ ] **Step 4: Run full build**

```bash
pnpm --filter @blazebot/shared build && pnpm --filter @blazebot/worker build
```
Expected: Clean build, no errors.

- [ ] **Step 5: Run full test suite**

```bash
cd packages/shared && pnpm vitest run
```
Expected: All tests pass. No references to old adapter.

---

### Task 7: Final verification

- [ ] **Step 1: Run full monorepo build**

```bash
pnpm build
```
Expected: All packages build cleanly.

- [ ] **Step 2: Run all tests across the monorepo**

```bash
pnpm test
```
Expected: All tests pass.

- [ ] **Step 3: Verify TypeScript types**

```bash
cd packages/shared && npx tsc --noEmit
```
Expected: No type errors.

---

## Environment Variable Changes

| Variable | Before | After | Notes |
|----------|--------|-------|-------|
| `SLACK_BOT_TOKEN` | Optional | Optional (unchanged) | Same `xoxb-` token |
| `SLACK_DEFAULT_CHANNEL` | Channel name (`#general`) | **Channel ID** (`C123ABC`) | ChatSDK uses channel IDs, not names. Users must update this value. |
| `SLACK_SIGNING_SECRET` | N/A | Optional (new) | Required if you later add webhook handling; optional for outbound-only |
| `MESSAGING_KIND` | `"slack"` | `"slack"` (unchanged) | Future: add `"discord"`, `"teams"`, etc. |

## Notes

- **Channel ID format change:** `SLACK_DEFAULT_CHANNEL` must now be a Slack channel ID (e.g., `C123ABC`), not a channel name. This is because ChatSDK addresses channels by `platform:channelId`. Document this in any `.env.example` or deployment docs.
- **Future multi-platform:** To add Discord or Teams support, install the corresponding `@chat-adapter/*` package, add adapters to the `Chat` constructor in the factory, and extend `MESSAGING_KIND` enum. The `MessagingAdapter` interface and worker code remain unchanged.
- **State adapter:** Not needed for outbound-only messaging. If you later need subscriptions, reactions, or thread tracking, add `@chat-adapter/state-redis` and pass `state: createRedisState()` to the `Chat` constructor (the project already has Redis via BullMQ).
