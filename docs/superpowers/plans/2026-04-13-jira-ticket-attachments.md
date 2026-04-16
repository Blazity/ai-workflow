# Jira Ticket Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jira ticket file attachments available to the agent inside the sandbox at `/tmp/attachments/` and advertise them via an index in `requirements.md`, so the agent can read mockups, spec PDFs, sample fixtures, and screenshots during research, implementation, and review.

**Architecture:** Extend `JiraAdapter` to surface attachment metadata and download bytes. Add a pure helper module `src/sandbox/attachments.ts` containing the retry loop, filename sanitizer, index formatter, and byte formatter. Wire two new workflow steps (`fetchAttachments`, `writeAttachments`) into `agentWorkflow` between `provisionSandbox` and Phase 1. Thread a `DownloadedAttachment[]` parameter through the four `assembleXContext` functions so an `## Attachments` section is rendered once per phase. Safety caps and timeouts come from new env vars.

**Tech Stack:** TypeScript, Vitest, `@vercel/sandbox` (writeFiles), `@t3-oss/env-core` + Zod (env), pino (logging), native `fetch` + `AbortSignal` (downloads).

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/adapters/issue-tracker/types.ts` | **Modify** | Add `TicketAttachment` interface; add `attachments: TicketAttachment[]` to `TicketContent`. |
| `src/adapters/issue-tracker/jira.ts` | **Modify** | Request `attachment` field in `fetchTicket`; map `data.fields.attachment` to `TicketAttachment[]`; add `downloadAttachment(url)` with manual-redirect auth-stripping and timeout. |
| `src/adapters/issue-tracker/jira.test.ts` | **Modify** | Extend tests: attachment parsing (present + absent), `downloadAttachment` follows one 302 and drops `Authorization` on the redirect. |
| `src/sandbox/attachments.ts` | **Create** | Pure helpers: `sanitizeFilename`, `formatBytes`, `formatAttachmentsIndex`, and the retry/caps loop `fetchAttachmentsWithRetry`. Exports `DownloadedAttachment` type. |
| `src/sandbox/attachments.test.ts` | **Create** | Unit tests for all four exports. |
| `src/sandbox/context.ts` | **Modify** | Accept optional `attachments` on all four `assembleXContext` functions; inject `## Attachments` section after the Ticket header block. |
| `src/sandbox/context.test.ts` | **Modify** | Add cases for attachment index rendering (present / empty / all-failed / mixed). |
| `src/workflows/agent.ts` | **Modify** | Two new `"use step"` functions (`fetchAttachments` before `provisionSandbox`, `writeAttachments` as the first action inside the sandbox `try {}`); forward the result into all four `assembleXContext` calls. |
| `env.ts` | **Modify** | Four new server vars: `ATTACHMENT_MAX_FILE_SIZE_MB`, `ATTACHMENT_MAX_TOTAL_SIZE_MB`, `ATTACHMENT_MAX_COUNT`, `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`. |

No changes to VCS adapters, run registry, Slack messaging, or sandbox manager.

---

## Shared Types (referenced by multiple tasks)

Defined in Task 2 (`TicketAttachment`) and Task 4 (`DownloadedAttachment`). Reproduced here so steps that use them later don't have to repeat the shape:

```ts
// src/adapters/issue-tracker/types.ts
export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}
```

```ts
// src/sandbox/attachments.ts
export interface DownloadedAttachment {
  filename: string;          // sanitized, collision-resolved
  originalFilename: string;
  mimeType: string;
  size: number;
  content?: Buffer;          // present only on success
  failed?: { reason: string; attempts: number }; // present only on failure
}

export interface AttachmentCaps {
  maxFileSizeBytes: number;
  maxTotalSizeBytes: number;
  maxCount: number;
  downloadTimeoutMs: number;
}
```

---

## Task 1: Add safety-cap env vars

**Files:**
- Modify: `env.ts`

- [ ] **Step 1: Add the four new vars to the `server` block**

In `env.ts`, inside the `server: { ... }` object in `createEnv(...)`, add the following entries (place them after the existing `Sandbox` group, before `POLL_INTERVAL_MS`):

```ts
    // Attachments
    ATTACHMENT_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(25),
    ATTACHMENT_MAX_TOTAL_SIZE_MB: z.coerce.number().int().positive().default(100),
    ATTACHMENT_MAX_COUNT: z.coerce.number().int().positive().default(20),
    ATTACHMENT_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 3: Verify env loads with defaults**

Run:
```bash
node -e "import('./env.ts').then(m => console.log({
  file: m.env.ATTACHMENT_MAX_FILE_SIZE_MB,
  total: m.env.ATTACHMENT_MAX_TOTAL_SIZE_MB,
  count: m.env.ATTACHMENT_MAX_COUNT,
  timeout: m.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
}))"
```
Expected: prints `{ file: 25, total: 100, count: 20, timeout: 30000 }` (or the overrides if already set in the environment).

---

## Task 2: Add `TicketAttachment` type and extend `TicketContent`

**Files:**
- Modify: `src/adapters/issue-tracker/types.ts`

Two targeted edits — add the `TicketAttachment` interface after `TicketComment`, and add a new `attachments` field to `TicketContent`. Do **not** replace the whole file; targeted edits are safer against concurrent changes.

- [ ] **Step 1: Add `attachments: TicketAttachment[]` to `TicketContent`**

In `src/adapters/issue-tracker/types.ts`, in the `TicketContent` interface, add a final field immediately after `trackerStatus: string;`:

```ts
  attachments: TicketAttachment[];
```

The interface now reads (for reference):

```ts
export interface TicketContent {
  id: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
  attachments: TicketAttachment[];
}
```

- [ ] **Step 2: Add the `TicketAttachment` interface**

In the same file, insert the following immediately after the `TicketComment` interface (and before `IssueTrackerAdapter`):

```ts
export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: FAIL — the existing `JiraAdapter.fetchTicket` does not populate `attachments`, so TypeScript will flag it. This is expected. Task 3 fixes it.

---

## Task 3: Parse attachment metadata in `JiraAdapter.fetchTicket`

**Files:**
- Modify: `src/adapters/issue-tracker/jira.ts:41-61`
- Modify: `src/adapters/issue-tracker/jira.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `describe` block inside `describe("JiraAdapter", () => { ... })` in `src/adapters/issue-tracker/jira.test.ts`, immediately after the existing `describe("fetchTicket", () => { ... })`:

```ts
  describe("fetchTicket attachments", () => {
    it("parses attachment metadata into TicketAttachment[]", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Has attachments",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            attachment: [
              {
                id: "att-1",
                filename: "mockup.png",
                mimeType: "image/png",
                size: 348192,
                content: "https://test.atlassian.net/secure/attachment/att-1/mockup.png",
              },
              {
                id: "att-2",
                filename: "spec.pdf",
                mimeType: "application/pdf",
                size: 52100,
                content: "https://test.atlassian.net/secure/attachment/att-2/spec.pdf",
              },
            ],
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      expect(ticket.attachments).toHaveLength(2);
      expect(ticket.attachments[0]).toEqual({
        id: "att-1",
        filename: "mockup.png",
        mimeType: "image/png",
        size: 348192,
        contentUrl: "https://test.atlassian.net/secure/attachment/att-1/mockup.png",
      });
    });

    it("returns empty attachments array when field is absent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10002",
          key: "PROJ-2",
          fields: {
            summary: "No attachments",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            // attachment field intentionally omitted
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10002");
      expect(ticket.attachments).toEqual([]);
    });

    it("requests attachment field in the fields query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10003",
          key: "PROJ-3",
          fields: {
            summary: "x",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      });

      const adapter = jiraAdapter();
      await adapter.fetchTicket("10003");
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("fields=");
      expect(url).toContain("attachment");
    });
  });
```

Also extend the existing "returns normalized ticket content" test so it doesn't break — the `TicketContent` type now requires `attachments`. Add `attachment: []` to the `fields` object in that test's mock response, and add:

```ts
      expect(ticket.attachments).toEqual([]);
```

before the closing `});` of the `it` block.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/adapters/issue-tracker/jira.test.ts`
Expected: FAIL — the new tests report `ticket.attachments` is `undefined`.

- [ ] **Step 3: Update `fetchTicket` in `jira.ts`**

In `src/adapters/issue-tracker/jira.ts`, replace the `fetchTicket` method (currently at lines 41-61) with:

```ts
  async fetchTicket(id: string): Promise<TicketContent> {
    const data = await this.request(
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status,attachment`,
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
      attachments: (data.fields.attachment ?? []).map(
        (a: any): TicketAttachment => ({
          id: String(a.id),
          filename: a.filename ?? "",
          mimeType: a.mimeType ?? "application/octet-stream",
          size: Number(a.size ?? 0),
          contentUrl: a.content ?? "",
        }),
      ),
    };
  }
```

Update the existing type import at the top of the file to:

```ts
import type { IssueTrackerAdapter, TicketContent, TicketComment, TicketAttachment } from "./types.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/adapters/issue-tracker/jira.test.ts`
Expected: PASS — all attachment tests and the updated existing test pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

---

## Task 4: Add `downloadAttachment` to `JiraAdapter`

**Files:**
- Modify: `src/adapters/issue-tracker/jira.ts`
- Modify: `src/adapters/issue-tracker/jira.test.ts`

This step adds a raw-bytes downloader with two quirks:
1. Atlassian's attachment URL returns a 302 to a signed CDN URL. If we re-send `Authorization: Basic ...` on the redirect, the CDN rejects the request because its signed URL is the auth. We must follow one redirect **manually** with a fresh request that omits the `Authorization` header.
2. We bound the whole operation with a 30s (configurable) timeout via `AbortSignal.timeout(ms)`.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block in `src/adapters/issue-tracker/jira.test.ts`, after the `describe("fetchTicket attachments", ...)` block:

```ts
  describe("downloadAttachment", () => {
    it("follows one 302 redirect without Authorization header", async () => {
      const redirectUrl = "https://atlassian-cdn.example/signed?x=1";
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: "Found",
          headers: { get: (n: string) => (n.toLowerCase() === "location" ? redirectUrl : null) },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
        });

      const adapter = jiraAdapter();
      const buf = await adapter.downloadAttachment(
        "https://test.atlassian.net/secure/attachment/att-1/mockup.png",
      );

      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(4);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call: to Jira, with Authorization.
      const firstInit = mockFetch.mock.calls[0][1] as RequestInit;
      expect((firstInit.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      expect(firstInit.redirect).toBe("manual");

      // Second call: to the CDN, WITHOUT Authorization.
      const secondInit = mockFetch.mock.calls[1][1] as RequestInit;
      const secondHeaders = (secondInit.headers ?? {}) as Record<string, string>;
      expect(secondHeaders.Authorization).toBeUndefined();
      expect(mockFetch.mock.calls[1][0]).toBe(redirectUrl);
    });

    it("returns bytes directly on 200 (no redirect)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });

      const adapter = jiraAdapter();
      const buf = await adapter.downloadAttachment(
        "https://test.atlassian.net/secure/attachment/att-1/data.bin",
      );
      expect(Array.from(buf)).toEqual([1, 2, 3]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws on non-2xx, non-302 responses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: { get: () => null },
      });

      const adapter = jiraAdapter();
      await expect(
        adapter.downloadAttachment("https://test.atlassian.net/secure/attachment/att-1/x"),
      ).rejects.toThrow(/500/);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/adapters/issue-tracker/jira.test.ts`
Expected: FAIL — `adapter.downloadAttachment is not a function`.

- [ ] **Step 3: Implement `downloadAttachment`**

In `src/adapters/issue-tracker/jira.ts`, add the following method to the `JiraAdapter` class (place it right after `postComment`, before `searchTickets`):

```ts
  async downloadAttachment(
    url: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const signal = AbortSignal.timeout(timeoutMs);

    // First request: authenticated, manual redirect handling.
    const first = await fetch(url, {
      method: "GET",
      headers: { Authorization: this.authHeader },
      redirect: "manual",
      signal,
    });

    if (first.status === 302 || first.status === 301) {
      const location = first.headers.get("location");
      if (!location) {
        throw new Error(
          `Jira attachment redirect (${first.status}) missing Location header for ${url}`,
        );
      }
      // Re-fetch the signed CDN URL WITHOUT Authorization (its signature IS the auth).
      // Use redirect: "follow" so CDN-internal redirects (e.g. S3 region redirects) work.
      const second = await fetch(location, {
        method: "GET",
        redirect: "follow",
        signal,
      });
      if (!second.ok) {
        throw new Error(
          `Jira attachment CDN error: ${second.status} ${second.statusText} on ${location}`,
        );
      }
      return Buffer.from(await second.arrayBuffer());
    }

    if (!first.ok) {
      throw new Error(
        `Jira attachment error: ${first.status} ${first.statusText} on ${url}`,
      );
    }
    return Buffer.from(await first.arrayBuffer());
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/adapters/issue-tracker/jira.test.ts`
Expected: PASS — all three new cases pass, existing tests still pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

---

## Task 5: Create `src/sandbox/attachments.ts` scaffold and pure helpers

**Files:**
- Create: `src/sandbox/attachments.ts`
- Create: `src/sandbox/attachments.test.ts`

This task adds the pure utilities (`sanitizeFilename`, `formatBytes`, `formatAttachmentsIndex`) and the `DownloadedAttachment` / `AttachmentCaps` types. The retry loop comes in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `src/sandbox/attachments.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  formatBytes,
  formatAttachmentsIndex,
  type DownloadedAttachment,
} from "./attachments.js";

describe("sanitizeFilename", () => {
  it("preserves simple names", () => {
    expect(sanitizeFilename("mockup.png", "att-1")).toBe("mockup.png");
  });

  it("strips path separators", () => {
    expect(sanitizeFilename("a/b/c.png", "att-1")).toBe("abc.png");
    expect(sanitizeFilename("a\\b\\c.png", "att-1")).toBe("abc.png");
  });

  it("strips null bytes", () => {
    expect(sanitizeFilename("a\u0000b.png", "att-1")).toBe("ab.png");
  });

  it("strips leading dots (no hidden files)", () => {
    expect(sanitizeFilename(".env", "att-1")).toBe("env");
    expect(sanitizeFilename("...weird", "att-1")).toBe("weird");
  });

  it("falls back to attachment-<id> when result is empty", () => {
    expect(sanitizeFilename("", "att-9")).toBe("attachment-att-9");
    expect(sanitizeFilename("///", "att-9")).toBe("attachment-att-9");
    expect(sanitizeFilename("....", "att-9")).toBe("attachment-att-9");
  });

  // Note: after stripping path separators and leading dots, ".pdf" becomes "pdf"
  // (non-empty), so the fallback does NOT fire. This matches the spec's literal
  // rules ("strip leading dots; fall back only if empty"). Documented explicitly
  // so implementers don't get confused.
  it("does NOT invoke fallback when stripping leaves a non-empty extension-only name", () => {
    expect(sanitizeFilename(".pdf", "att-9")).toBe("pdf");
    expect(sanitizeFilename("/.png", "att-9")).toBe("png");
  });
});

describe("formatBytes", () => {
  it("formats bytes under 1KB as B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB with no decimals for whole numbers", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats KB with one decimal for fractions", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(348_192)).toBe("340 KB");
  });

  it("formats MB with one decimal", () => {
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });
});

describe("formatAttachmentsIndex", () => {
  const ok = (filename: string, mimeType: string, size: number): DownloadedAttachment => ({
    filename,
    originalFilename: filename,
    mimeType,
    size,
    content: Buffer.from([]),
  });
  const fail = (
    filename: string,
    reason: string,
    attempts = 1,
  ): DownloadedAttachment => ({
    filename,
    originalFilename: filename,
    mimeType: "application/octet-stream",
    size: 0,
    failed: { reason, attempts },
  });

  it("returns empty string when no attachments", () => {
    expect(formatAttachmentsIndex([])).toBe("");
  });

  it("lists successful downloads with path and size", () => {
    const out = formatAttachmentsIndex([
      ok("mockup.png", "image/png", 348_192),
      ok("api-sample.json", "application/json", 2048),
    ]);
    expect(out).toContain("## Attachments");
    expect(out).toContain("/tmp/attachments/");
    expect(out).toContain("`/tmp/attachments/mockup.png` — image/png, 340 KB");
    expect(out).toContain("`/tmp/attachments/api-sample.json` — application/json, 2 KB");
  });

  it("marks failed downloads with a warning prefix and reason", () => {
    const out = formatAttachmentsIndex([
      fail("spec.pdf", "HTTP 500", 3),
    ]);
    expect(out).toContain("⚠️");
    expect(out).toContain("spec.pdf");
    expect(out).toContain("failed to download after 3 attempts");
    expect(out).toContain("HTTP 500");
  });

  it("renders a mix of success and failure", () => {
    const out = formatAttachmentsIndex([
      ok("mockup.png", "image/png", 340_000),
      fail("broken.bin", "HTTP 404", 1),
    ]);
    expect(out).toContain("mockup.png");
    expect(out).toContain("⚠️");
    expect(out).toContain("broken.bin");
  });

  it("renders the section even when all entries failed", () => {
    const out = formatAttachmentsIndex([
      fail("a.pdf", "HTTP 500", 3),
      fail("b.pdf", "HTTP 500", 3),
    ]);
    expect(out).toContain("## Attachments");
    expect(out.match(/⚠️/g)?.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sandbox/attachments.test.ts`
Expected: FAIL — `Cannot find module './attachments.js'`.

- [ ] **Step 3: Create `src/sandbox/attachments.ts` with the helpers**

Create the file with:

```ts
import type { TicketAttachment } from "../adapters/issue-tracker/types.js";

export interface DownloadedAttachment {
  filename: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  content?: Buffer;
  failed?: { reason: string; attempts: number };
}

export interface AttachmentCaps {
  maxFileSizeBytes: number;
  maxTotalSizeBytes: number;
  maxCount: number;
  downloadTimeoutMs: number;
}

export function sanitizeFilename(name: string, id: string): string {
  // Strip path separators, null bytes, and leading dots (no hidden files).
  const cleaned = (name ?? "")
    .replace(/[\\/]/g, "")
    .replace(/\u0000/g, "")
    .replace(/^\.+/, "");

  // Fallback to `attachment-{id}` only when the result is empty, per spec.
  // An extension-only input like ".pdf" legitimately sanitizes to "pdf" and does
  // NOT trigger the fallback.
  return cleaned.length > 0 ? cleaned : `attachment-${id}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) {
    return Number.isInteger(kb) ? `${kb} KB` : `${roundOne(kb)} KB`;
  }
  const mb = kb / 1024;
  return Number.isInteger(mb) ? `${mb} MB` : `${roundOne(mb)} MB`;
}

function roundOne(x: number): string {
  // One decimal, but drop trailing ".0" (e.g. 340.0 -> "340").
  const rounded = Math.round(x * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatAttachmentsIndex(
  attachments: DownloadedAttachment[],
): string {
  if (attachments.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Attachments");
  lines.push("");
  lines.push(
    "The following files from the Jira ticket are available in `/tmp/attachments/`.",
  );
  lines.push("Read them when relevant to the task.");
  lines.push("");

  for (const a of attachments) {
    if (a.failed) {
      lines.push(
        `- ⚠️ \`${a.originalFilename}\` — failed to download after ${a.failed.attempts} attempt${a.failed.attempts === 1 ? "" : "s"} (${a.failed.reason})`,
      );
    } else {
      lines.push(
        `- \`/tmp/attachments/${a.filename}\` — ${a.mimeType}, ${formatBytes(a.size)}`,
      );
    }
  }

  return lines.join("\n");
}

// Placeholder export so the workflow step can import the name in Task 7; real
// implementation lands in Task 6.
export async function fetchAttachmentsWithRetry(
  _downloader: { downloadAttachment(url: string, opts?: { timeoutMs?: number }): Promise<Buffer> },
  _attachments: TicketAttachment[],
  _caps: AttachmentCaps,
  _log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
): Promise<DownloadedAttachment[]> {
  throw new Error("fetchAttachmentsWithRetry: not implemented (Task 6)");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sandbox/attachments.test.ts`
Expected: PASS — all 14 cases pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

---

## Task 6: Implement `fetchAttachmentsWithRetry`

**Files:**
- Modify: `src/sandbox/attachments.ts`
- Modify: `src/sandbox/attachments.test.ts`

Behavior (from the spec):
- Enforce caps **before** downloading (use metadata `size`):
  - Count cap: skip any attachment whose index >= `maxCount`.
  - Per-file cap: skip any whose `size > maxFileSizeBytes`.
  - Total cap: track a running sum of bytes that will be downloaded; skip once `sum + size > maxTotalSizeBytes`.
- Retry loop per file: max 3 attempts, backoffs `500ms`, `2000ms`, `5000ms`.
- Retryable: network errors (`AbortError`, `ECONNRESET`, `ETIMEDOUT`), HTTP 5xx, HTTP 429.
- Non-retryable: other 4xx (message already contains the code from `downloadAttachment`'s thrown error).
- 429 is retried using the normal backoff schedule. The spec mentions honoring a `Retry-After` header capped at 10s; this plan deliberately defers header-aware backoff to a follow-up because the current `downloadAttachment` throws a plain `Error` that discards headers. Refactoring to a richer error type is out of scope for v1 — document the gap and move on. A 429 from Jira's attachment CDN is rare enough that the normal 500/2000ms backoff is adequate for v1.
- Collisions: if the sanitized filename already exists in the accumulator, append `-{id}` before the extension.
- Return an array in the **original input order**, with skipped entries included as `failed` entries (reason `"skipped: per-file size cap"`, `"skipped: total size cap"`, or `"skipped: count cap"`) and zero attempts.

- [ ] **Step 1: Write the failing tests**

Append to `src/sandbox/attachments.test.ts`:

```ts
import { fetchAttachmentsWithRetry, type AttachmentCaps } from "./attachments.js";
import type { TicketAttachment } from "../adapters/issue-tracker/types.js";
import { vi } from "vitest";

const defaultCaps: AttachmentCaps = {
  maxFileSizeBytes: 25 * 1024 * 1024,
  maxTotalSizeBytes: 100 * 1024 * 1024,
  maxCount: 20,
  downloadTimeoutMs: 30_000,
};

function noopLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function meta(
  id: string,
  filename: string,
  size: number,
  mimeType = "application/octet-stream",
): TicketAttachment {
  return {
    id,
    filename,
    mimeType,
    size,
    contentUrl: `https://jira.example/attachment/${id}`,
  };
}

describe("fetchAttachmentsWithRetry", () => {
  it("downloads all attachments when under caps", async () => {
    const downloader = {
      downloadAttachment: vi.fn(async () => Buffer.from([1, 2, 3])),
    };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "a.png", 3), meta("2", "b.png", 3)],
      defaultCaps,
      noopLogger(),
    );
    expect(out).toHaveLength(2);
    expect(out[0].content).toBeInstanceOf(Buffer);
    expect(out[0].failed).toBeUndefined();
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(2);
  });

  it("skips attachments over per-file cap without downloading", async () => {
    const downloader = {
      downloadAttachment: vi.fn(async () => Buffer.from([])),
    };
    const caps: AttachmentCaps = { ...defaultCaps, maxFileSizeBytes: 100 };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "small.bin", 50), meta("2", "big.bin", 10_000)],
      caps,
      noopLogger(),
    );
    expect(out[0].content).toBeDefined();
    expect(out[1].failed?.reason).toMatch(/per-file size cap/);
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it("stops downloading once total cap is exceeded", async () => {
    const downloader = {
      downloadAttachment: vi.fn(async () => Buffer.from([])),
    };
    const caps: AttachmentCaps = { ...defaultCaps, maxTotalSizeBytes: 150 };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [
        meta("1", "a.bin", 100),
        meta("2", "b.bin", 100), // 100+100 = 200 > 150 → skipped
        meta("3", "c.bin", 40),  // 100+40 = 140 ≤ 150 → would fit, but spec says
                                  // "once exceeded, remaining attachments are skipped"
      ],
      caps,
      noopLogger(),
    );
    expect(out[0].failed).toBeUndefined();
    expect(out[1].failed?.reason).toMatch(/total size cap/);
    expect(out[2].failed?.reason).toMatch(/total size cap/);
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it("skips attachments beyond count cap", async () => {
    const downloader = {
      downloadAttachment: vi.fn(async () => Buffer.from([])),
    };
    const caps: AttachmentCaps = { ...defaultCaps, maxCount: 2 };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [
        meta("1", "a.bin", 10),
        meta("2", "b.bin", 10),
        meta("3", "c.bin", 10),
      ],
      caps,
      noopLogger(),
    );
    expect(out).toHaveLength(3);
    expect(out[0].failed).toBeUndefined();
    expect(out[1].failed).toBeUndefined();
    expect(out[2].failed?.reason).toMatch(/count cap/);
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(2);
  });

  it("retries transient 5xx up to 3 times then marks failed", async () => {
    const downloader = {
      downloadAttachment: vi
        .fn()
        .mockRejectedValue(new Error("Jira attachment error: 500 Internal Server Error on url")),
    };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "a.bin", 10)],
      defaultCaps,
      noopLogger(),
    );
    expect(out[0].failed).toBeDefined();
    expect(out[0].failed?.attempts).toBe(3);
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 404", async () => {
    const downloader = {
      downloadAttachment: vi
        .fn()
        .mockRejectedValue(new Error("Jira attachment error: 404 Not Found on url")),
    };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "a.bin", 10)],
      defaultCaps,
      noopLogger(),
    );
    expect(out[0].failed).toBeDefined();
    expect(out[0].failed?.attempts).toBe(1);
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it("succeeds on second attempt after transient failure", async () => {
    const downloader = {
      downloadAttachment: vi
        .fn()
        .mockRejectedValueOnce(new Error("Jira attachment error: 503 Service Unavailable on url"))
        .mockResolvedValueOnce(Buffer.from([9])),
    };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "a.bin", 1)],
      defaultCaps,
      noopLogger(),
    );
    expect(out[0].content).toBeDefined();
    expect(out[0].failed).toBeUndefined();
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(2);
  });

  it("resolves collisions by appending -{id} before the extension", async () => {
    const downloader = {
      downloadAttachment: vi.fn(async () => Buffer.from([1])),
    };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "report.pdf", 1), meta("2", "report.pdf", 1)],
      defaultCaps,
      noopLogger(),
    );
    expect(out[0].filename).toBe("report.pdf");
    expect(out[1].filename).toBe("report-2.pdf");
    expect(out[1].originalFilename).toBe("report.pdf");
  });

  it("retries on network abort errors", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    const downloader = {
      downloadAttachment: vi
        .fn()
        .mockRejectedValueOnce(abortErr)
        .mockResolvedValueOnce(Buffer.from([1])),
    };
    const out = await fetchAttachmentsWithRetry(
      downloader,
      [meta("1", "a.bin", 1)],
      defaultCaps,
      noopLogger(),
    );
    expect(out[0].content).toBeDefined();
    expect(downloader.downloadAttachment).toHaveBeenCalledTimes(2);
  });
});
```

**Note:** the retry tests will take up to a few seconds because of the backoff. That's acceptable — a 500/2000/5000 ms schedule means the 3-attempt failure case waits ~7.5s. If this feels too slow in CI, see "Speeding up retry tests" below.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sandbox/attachments.test.ts`
Expected: FAIL — most `fetchAttachmentsWithRetry` tests throw "not implemented" from the placeholder.

- [ ] **Step 3: Replace the placeholder with a real implementation**

In `src/sandbox/attachments.ts`, replace the `fetchAttachmentsWithRetry` placeholder function (and anything after it) with:

```ts
// MAX_ATTEMPTS = 3 means at most 2 sleeps between 3 tries. The spec phrases this
// as "500 → 2000 → 5000ms" but with only 3 attempts the 5000ms delay never fires
// (the 3rd failure exits the loop). We encode just the two delays that actually
// run to avoid confusing dead-code.
const MAX_ATTEMPTS = 3;
const BACKOFFS_MS = [500, 2000];

interface Downloader {
  downloadAttachment(url: string, opts?: { timeoutMs?: number }): Promise<Buffer>;
}

interface AttachmentsLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export async function fetchAttachmentsWithRetry(
  downloader: Downloader,
  attachments: TicketAttachment[],
  caps: AttachmentCaps,
  log: AttachmentsLogger,
): Promise<DownloadedAttachment[]> {
  const result: DownloadedAttachment[] = [];
  const usedFilenames = new Set<string>();
  let bytesCommitted = 0;
  let totalCapTripped = false;

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];

    // Cap: count
    if (i >= caps.maxCount) {
      result.push(skip(att, "skipped: count cap", log));
      continue;
    }
    // Cap: per-file size
    if (att.size > caps.maxFileSizeBytes) {
      result.push(skip(att, "skipped: per-file size cap", log));
      continue;
    }
    // Cap: total size — once exceeded, all remaining are skipped.
    if (totalCapTripped || bytesCommitted + att.size > caps.maxTotalSizeBytes) {
      totalCapTripped = true;
      result.push(skip(att, "skipped: total size cap", log));
      continue;
    }

    const safeName = resolveFilename(att, usedFilenames);
    usedFilenames.add(safeName);

    let attempts = 0;
    let lastError: Error | undefined;
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        const content = await downloader.downloadAttachment(att.contentUrl, {
          timeoutMs: caps.downloadTimeoutMs,
        });
        bytesCommitted += att.size;
        log.info(
          {
            filename: safeName,
            originalFilename: att.filename,
            mimeType: att.mimeType,
            size: att.size,
            attempts,
          },
          "attachment downloaded",
        );
        result.push({
          filename: safeName,
          originalFilename: att.filename,
          mimeType: att.mimeType,
          size: att.size,
          content,
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
        if (!isRetryable(lastError) || attempts >= MAX_ATTEMPTS) break;
        const delay = Math.min(BACKOFFS_MS[attempts - 1] ?? 5000, 10_000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (lastError) {
      log.warn(
        {
          filename: att.filename,
          reason: lastError.message,
          attempts,
        },
        "attachment failed",
      );
      result.push({
        filename: safeName,
        originalFilename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        failed: { reason: shortReason(lastError.message), attempts },
      });
    }
  }

  return result;
}

function skip(
  att: TicketAttachment,
  reason: string,
  log: AttachmentsLogger,
): DownloadedAttachment {
  log.warn({ filename: att.filename, reason }, "attachment skipped");
  return {
    filename: sanitizeFilename(att.filename, att.id),
    originalFilename: att.filename,
    mimeType: att.mimeType,
    size: att.size,
    failed: { reason, attempts: 0 },
  };
}

function resolveFilename(
  att: TicketAttachment,
  used: Set<string>,
): string {
  const safe = sanitizeFilename(att.filename, att.id);
  if (!used.has(safe)) return safe;
  const dot = safe.lastIndexOf(".");
  if (dot <= 0) return `${safe}-${att.id}`;
  return `${safe.slice(0, dot)}-${att.id}${safe.slice(dot)}`;
}

function isRetryable(err: Error): boolean {
  const msg = err.message ?? "";
  if (err.name === "AbortError") return true;
  if (/ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/\b429\b/.test(msg)) return true;
  return false;
}

function shortReason(msg: string): string {
  // Strip the URL from thrown messages for cleaner index output.
  const m = msg.match(/\b(\d{3})\b(.*?)(?: on https?:\/\/.*)?$/);
  if (m) return `HTTP ${m[1]}${m[2] ?? ""}`.trim();
  return msg;
}
```

**Speeding up retry tests:** if the 500ms/2000ms/5000ms backoffs make Vitest slow enough to annoy you, add an env-gated override at the top of the retry loop:

```ts
const backoffMultiplier = process.env.ATTACHMENTS_TEST_FAST_RETRY === "1" ? 0 : 1;
// ...
const delay = Math.min((BACKOFFS_MS[attempts - 1] ?? 5000) * backoffMultiplier, 10_000);
```

Then run retry tests with `ATTACHMENTS_TEST_FAST_RETRY=1 npx vitest run src/sandbox/attachments.test.ts`. This is optional — if you don't add it, the failing-retry test takes ~7.5s, which is fine.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sandbox/attachments.test.ts`
Expected: PASS — all 9 `fetchAttachmentsWithRetry` tests plus the earlier helper tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

---

## Task 7: Thread attachments through `assembleXContext`

**Files:**
- Modify: `src/sandbox/context.ts`
- Modify: `src/sandbox/context.test.ts`

Each context function gains an optional `attachments?: DownloadedAttachment[]` field on its input interface. When present and non-empty, the `## Attachments` section is inserted **after** the ticket identifier/title block and **before** `## Description` (for research) or `## Acceptance Criteria` (for the other three, which have no description).

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe("assembleResearchPlanContext", ...)` block (and add new cases in other `describe`s) in `src/sandbox/context.test.ts` so that it also exercises attachments. Add the following test cases at the end of each of the four `describe` blocks:

```ts
  it("renders attachments index when attachments are provided", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-3",
        title: "With files",
        description: "desc",
        acceptanceCriteria: "ac",
        comments: [],
      },
      prompt: "prompt",
      branchName: "blazebot/test-3",
      attachments: [
        {
          filename: "mockup.png",
          originalFilename: "mockup.png",
          mimeType: "image/png",
          size: 348_192,
          content: Buffer.from([]),
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("/tmp/attachments/mockup.png");
    expect(result).toContain("image/png");

    // Attachments section appears before Description
    const atIdx = result.indexOf("## Attachments");
    const descIdx = result.indexOf("## Description");
    expect(atIdx).toBeGreaterThan(-1);
    expect(descIdx).toBeGreaterThan(atIdx);
  });

  it("omits attachments section when list is empty or absent", () => {
    const withoutField = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
    });
    expect(withoutField).not.toContain("## Attachments");

    const withEmpty = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      attachments: [],
    });
    expect(withEmpty).not.toContain("## Attachments");
  });

  it("shows failed attachments in the index even when no bytes downloaded", () => {
    const result = assembleResearchPlanContext({
      ticket: { identifier: "X", title: "t", description: "d", acceptanceCriteria: "a", comments: [] },
      prompt: "p",
      branchName: "b",
      attachments: [
        {
          filename: "spec.pdf",
          originalFilename: "spec.pdf",
          mimeType: "application/pdf",
          size: 0,
          failed: { reason: "HTTP 500", attempts: 3 },
        },
      ],
    });
    expect(result).toContain("## Attachments");
    expect(result).toContain("⚠️");
    expect(result).toContain("spec.pdf");
  });
```

Add the same three tests (adapted) to the `describe("assembleImplementationContext ...")`, `describe("assembleImplementationRetryContext ...")`, and `describe("assembleReviewContext ...")` blocks. In the "before Description" ordering check for the three non-research functions, replace `## Description` with `## Acceptance Criteria`:

```ts
    const atIdx = result.indexOf("## Attachments");
    const acIdx = result.indexOf("## Acceptance Criteria");
    expect(atIdx).toBeGreaterThan(-1);
    expect(acIdx).toBeGreaterThan(atIdx);
```

For `assembleImplementationRetryContext` and `assembleReviewContext`, include the required extra inputs (`researchPlanMarkdown`, `reviewFeedback`, `gitDiff`) as in the existing tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/sandbox/context.test.ts`
Expected: FAIL — the `attachments` field is rejected by TypeScript on the four context input interfaces, and the assertions fail because no `## Attachments` text exists.

- [ ] **Step 3: Update `src/sandbox/context.ts`**

At the top of the file, add:

```ts
import type { DownloadedAttachment } from "./attachments.js";
import { formatAttachmentsIndex } from "./attachments.js";
```

Add `attachments?: DownloadedAttachment[]` to each of the four input interfaces:

```ts
export interface ResearchPlanContextInput {
  ticket: TicketData;
  prompt: string;
  branchName: string;
  prComments?: PRComment[];
  checkResults?: CheckRunResult[];
  hasConflicts?: boolean;
  attachments?: DownloadedAttachment[];
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  attachments?: DownloadedAttachment[];
}

export interface ImplementationRetryContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  reviewFeedback: ReviewOutput;
  attachments?: DownloadedAttachment[];
}

export interface ReviewContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  gitDiff: string;
  attachments?: DownloadedAttachment[];
}
```

Then rewrite each of the four `assembleXContext` functions to insert the attachments index between the Ticket header and the next section. Use this pattern (apply to all four — shown for research here; adapt the specific sections for the other three):

For `assembleResearchPlanContext`, replace the implementation with:

```ts
export function assembleResearchPlanContext(input: ResearchPlanContextInput): string {
  const { ticket, prompt, branchName, prComments, checkResults, hasConflicts, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);

  let md = `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

## Branch

${branchName}
`;

  if (prComments && prComments.length > 0) {
    md += `\n## PR Review Feedback\n\n${formatPRComments(prComments)}\n`;
  }
  if (checkResults && checkResults.length > 0) {
    md += `\n## CI/CD Check Results\n\n${formatCheckResults(checkResults)}\n`;
  }
  if (hasConflicts) {
    md += `\n## Merge Conflicts\n\nThis PR has merge conflicts. The base branch has already been merged — the repo is in a MERGING state with conflict markers in the affected files. Resolve the markers, \`git add\` the files, and run \`git merge --continue\`.\n`;
  }

  md += `\n---\n\n${prompt}\n`;
  return md;
}
```

For `assembleImplementationContext`:

```ts
export function assembleImplementationContext(input: ImplementationContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

---

${prompt}
`;
}
```

For `assembleImplementationRetryContext`:

```ts
export function assembleImplementationRetryContext(input: ImplementationRetryContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, reviewFeedback, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

## Review Feedback

${reviewFeedback.feedback}

### Issues

${formatReviewIssues(reviewFeedback.issues)}

---

${prompt}
`;
}
```

For `assembleReviewContext`:

```ts
export function assembleReviewContext(input: ReviewContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, gitDiff, attachments } = input;
  const attachmentsSection = renderAttachmentsSection(attachments);
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}
${attachmentsSection}
## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

## Git Diff

\`\`\`diff
${gitDiff}
\`\`\`

---

${prompt}
`;
}
```

Finally, add this private helper at the bottom of the file (below the other `format*` helpers):

```ts
function renderAttachmentsSection(
  attachments: DownloadedAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return "";
  return `\n${formatAttachmentsIndex(attachments)}\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/sandbox/context.test.ts`
Expected: PASS — all existing tests still pass, plus the four new sets of attachments tests.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

---

## Task 8: Wire workflow steps `fetchAttachments` and `writeAttachments`

**Files:**
- Modify: `src/workflows/agent.ts`

This is the integration task. Two new `"use step"` functions run in sequence between `provisionSandbox` (line ~256) and the Phase 1 research block. The downloaded-attachments array is captured in workflow-local state and passed to all four `assembleXContext` calls (research, impl, impl retry, review).

Key points:
- `fetchAndValidateTicket` already returns a `ticket`; after Task 2 its shape includes `attachments: TicketAttachment[]`. Forward that array into the new step.
- `fetchAttachments` is pure-ish (HTTP + retry) and should **not** throw on per-file failures — that's the spec contract. Set `fetchAttachments.maxRetries = 0` so WDK doesn't re-run the whole step on a partial failure that was already handled.
- `writeAttachments` writes to the shared sandbox. Set `writeAttachments.maxRetries = 0` like `writeAndStartPhase` does; a persistent failure is a real sandbox issue and should fail fast.
- `DownloadedAttachment` includes `Buffer` — Buffers serialize across WDK step boundaries fine (they become `Uint8Array` under the hood; `sandbox.writeFiles` accepts `Buffer`). If any issue surfaces in practice, swap to `{ path, content }` tuples at the step boundary.

- [ ] **Step 1: Add the `fetchAttachments` step function**

In `src/workflows/agent.ts`, immediately after the `fetchAndValidateTicket` function (around line 16), insert:

```ts
async function fetchAttachments(
  ticketIdentifier: string,
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    contentUrl: string;
  }>,
) {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ ticket_identifier: ticketIdentifier, step: "fetchAttachments" });
  log.info({ count: attachments.length }, "fetchAttachments: start");

  if (attachments.length === 0) {
    log.info({}, "fetchAttachments: no attachments");
    return [];
  }

  const { env } = await import("../../env.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { fetchAttachmentsWithRetry } = await import("../sandbox/attachments.js");
  const { issueTracker } = createStepAdapters();

  // The JiraAdapter exposes downloadAttachment. Other issue-tracker adapters don't
  // (yet), so guard it here — if we ever add more, the workflow will just skip
  // attachments for trackers without a downloader.
  const downloader = issueTracker as unknown as {
    downloadAttachment?: (url: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
  };
  if (typeof downloader.downloadAttachment !== "function") {
    log.warn(
      { tracker: issueTracker.constructor.name },
      "issue tracker does not support attachment downloads; skipping",
    );
    return [];
  }

  const result = await fetchAttachmentsWithRetry(
    downloader as { downloadAttachment: (url: string, opts?: { timeoutMs?: number }) => Promise<Buffer> },
    attachments,
    {
      maxFileSizeBytes: env.ATTACHMENT_MAX_FILE_SIZE_MB * 1024 * 1024,
      maxTotalSizeBytes: env.ATTACHMENT_MAX_TOTAL_SIZE_MB * 1024 * 1024,
      maxCount: env.ATTACHMENT_MAX_COUNT,
      downloadTimeoutMs: env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    },
    log,
  );
  log.info(
    {
      succeeded: result.filter((a) => !a.failed).length,
      failed: result.filter((a) => a.failed).length,
    },
    "fetchAttachments: done",
  );
  return result;
}
fetchAttachments.maxRetries = 0;
```

- [ ] **Step 2: Add the `writeAttachments` step function**

Immediately after `fetchAttachments`, add:

```ts
async function writeAttachments(
  sandboxId: string,
  attachments: Array<{
    filename: string;
    originalFilename: string;
    mimeType: string;
    size: number;
    content?: Buffer | Uint8Array;
    failed?: { reason: string; attempts: number };
  }>,
): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ sandboxId, step: "writeAttachments" });

  const toWrite = attachments.filter((a) => a.content && !a.failed);
  log.info(
    { count: toWrite.length, totalReceived: attachments.length },
    "writeAttachments: start",
  );
  if (toWrite.length === 0) {
    log.info({}, "writeAttachments: nothing to write");
    return;
  }

  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Ensure target directory exists — writeFiles does not guarantee mkdir -p semantics.
  await sandbox.runCommand("mkdir", ["-p", "/tmp/attachments"]);

  await sandbox.writeFiles(
    toWrite.map((a) => ({
      path: `/tmp/attachments/${a.filename}`,
      content: Buffer.isBuffer(a.content)
        ? (a.content as Buffer)
        : Buffer.from(a.content as Uint8Array),
    })),
  );
  log.info({ count: toWrite.length }, "writeAttachments: done");
}
writeAttachments.maxRetries = 0;
```

- [ ] **Step 3: Call the two new steps in `agentWorkflow`**

The spec's architecture diagram places `fetchAttachments` at workflow start (before `createFeatureBranch` / `provisionSandbox`) and `writeAttachments` after `provisionSandbox`. Placement matters:

- Download **before** `provisionSandbox` so a slow/partial-failure download doesn't burn sandbox CPU hours while idle.
- Write **inside** the `try { ... }` block so a thrown `writeAttachments` always routes through `finally { teardownSandbox }` — no leaked sandbox.

Inside `agentWorkflow`, locate this block (in the top half of the `try { ... }` outer body, after `createFeatureBranch` handling):

```ts
    const mergeBase = prContext?.hasConflicts ? baseBranch : undefined;

    // Provision sandbox once for all phases
    const sandboxId = await provisionSandbox(branchName, mergeBase);

    try {
```

Insert the `fetchAttachments` call **immediately before** `const sandboxId = await provisionSandbox(...)`:

```ts
    const downloadedAttachments = await fetchAttachments(ticket.identifier, ticket.attachments);
```

So that block becomes:

```ts
    const mergeBase = prContext?.hasConflicts ? baseBranch : undefined;

    const downloadedAttachments = await fetchAttachments(ticket.identifier, ticket.attachments);

    // Provision sandbox once for all phases
    const sandboxId = await provisionSandbox(branchName, mergeBase);

    try {
```

Then, as the **first** action inside `try { ... }` (above `// ========== PHASE 1: Research & Plan ==========`), insert:

```ts
      await writeAttachments(sandboxId, downloadedAttachments);
```

- [ ] **Step 4: Forward attachments to every `assembleXContext` call**

Locate the four `assembleXContext` calls in `agentWorkflow` and add an `attachments: downloadedAttachments` property to each.

Research (around line 270):

```ts
      const researchInput = assembleResearchPlanContext({
        ticket: ticketData,
        prompt: getPrompt("research-plan.md"),
        branchName,
        prComments: prContext?.prComments,
        checkResults: prContext?.checkResults,
        hasConflicts: prContext?.hasConflicts,
        attachments: downloadedAttachments,
      });
```

Implementation retry / first (around line 336):

```ts
        const implInput = lastReviewFeedback
          ? assembleImplementationRetryContext({
              ticket: ticketData,
              prompt: getPrompt("implement.md"),
              researchPlanMarkdown,
              reviewFeedback: lastReviewFeedback,
              attachments: downloadedAttachments,
            })
          : assembleImplementationContext({
              ticket: ticketData,
              prompt: getPrompt("implement.md"),
              researchPlanMarkdown,
              attachments: downloadedAttachments,
            });
```

Review (around line 400):

```ts
        const reviewInput = assembleReviewContext({
          ticket: ticketData,
          prompt: getPrompt("review.md"),
          researchPlanMarkdown,
          gitDiff,
          attachments: downloadedAttachments,
        });
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0. The `ticket.attachments` field is now required on `TicketContent`, so ensure any place that constructs a `TicketContent` (primarily the Jira adapter and fixtures) already includes it. If typecheck flags other call sites, fix them — most likely a test fixture that builds `TicketContent` manually.

- [ ] **Step 6: Run the full unit test suite**

Run: `npm run test`
Expected: all suites pass. Pay special attention to `src/adapters/issue-tracker/jira.test.ts`, `src/sandbox/context.test.ts`, and `src/sandbox/attachments.test.ts`.

---

## Task 9: End-to-end integration sanity check (mocked sandbox)

**Files:**
- Create: `src/sandbox/attachments.integration.test.ts`

This is a light integration test that proves the three moving pieces line up: Jira mock → `fetchAttachmentsWithRetry` → a fake sandbox's `writeFiles`. It does **not** spin up a real sandbox or a real workflow — it exercises the shapes.

- [ ] **Step 1: Write the test**

Create `src/sandbox/attachments.integration.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchAttachmentsWithRetry, type AttachmentCaps } from "./attachments.js";
import type { TicketAttachment } from "../adapters/issue-tracker/types.js";

describe("attachments → sandbox writeFiles shape", () => {
  it("produces writeFiles payloads at /tmp/attachments/<safe filename>", async () => {
    const downloader = {
      downloadAttachment: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        .mockResolvedValueOnce(Buffer.from("{\"ok\":true}")),
    };

    const attachments: TicketAttachment[] = [
      {
        id: "1",
        filename: "mockup.png",
        mimeType: "image/png",
        size: 4,
        contentUrl: "https://jira.example/1",
      },
      {
        id: "2",
        filename: "sample.json",
        mimeType: "application/json",
        size: 11,
        contentUrl: "https://jira.example/2",
      },
    ];

    const caps: AttachmentCaps = {
      maxFileSizeBytes: 1_000_000,
      maxTotalSizeBytes: 10_000_000,
      maxCount: 10,
      downloadTimeoutMs: 5_000,
    };

    const downloaded = await fetchAttachmentsWithRetry(
      downloader,
      attachments,
      caps,
      { info: vi.fn(), warn: vi.fn() },
    );

    // Simulate the writeAttachments step's payload mapping.
    const payload = downloaded
      .filter((a) => a.content && !a.failed)
      .map((a) => ({
        path: `/tmp/attachments/${a.filename}`,
        content: a.content!,
      }));

    expect(payload).toHaveLength(2);
    expect(payload[0].path).toBe("/tmp/attachments/mockup.png");
    expect(payload[0].content).toBeInstanceOf(Buffer);
    expect(payload[1].path).toBe("/tmp/attachments/sample.json");
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/sandbox/attachments.integration.test.ts`
Expected: PASS.

---

## Task 10: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Spot-check the generated requirements.md shape manually**

Run:
```bash
node --input-type=module -e "
import { assembleResearchPlanContext } from './src/sandbox/context.ts';
console.log(assembleResearchPlanContext({
  ticket: {
    identifier: 'TEST-1',
    title: 'Example',
    description: 'desc',
    acceptanceCriteria: 'ac',
    comments: [],
  },
  prompt: 'PROMPT',
  branchName: 'blazebot/test-1',
  attachments: [
    { filename: 'mockup.png', originalFilename: 'mockup.png', mimeType: 'image/png', size: 348192, content: Buffer.from([]) },
    { filename: 'spec.pdf', originalFilename: 'spec.pdf', mimeType: 'application/pdf', size: 0, failed: { reason: 'HTTP 500', attempts: 3 } },
  ],
}));
"
```
Expected: output contains:
- A `## Ticket ID` header, followed shortly after by
- A `## Attachments` header
- A line like ``- `/tmp/attachments/mockup.png` — image/png, 340 KB``
- A line like `- ⚠️ \`spec.pdf\` — failed to download after 3 attempts (HTTP 500)`
- `## Description` appearing **after** `## Attachments`

- [ ] **Step 4: Review workflow wiring**

Re-read `src/workflows/agent.ts` and confirm:
- `fetchAttachments(ticket.identifier, ticket.attachments)` is called **before** `provisionSandbox` (per spec architecture).
- `writeAttachments(sandboxId, downloadedAttachments)` is the **first** statement inside `try {`.
- All four `assembleXContext(...)` invocations pass `attachments: downloadedAttachments`.
- Neither step forwards errors that would crash the workflow — `fetchAttachments` always returns an array, `writeAttachments` no-ops when there is nothing to write.

---

## Notes for the implementer

- **Do not** add `.gitignore` entries for `/tmp/attachments/` — the files live outside the cloned repo and are never staged by `git`. The existing `requirements.md` convention at `/tmp/research-requirements.md` etc. already relies on this.
- **Do not** attempt to follow URLs embedded in the ticket description or comments. That is explicitly out-of-scope (SSRF risk, auth friction). The agent can decide to fetch external URLs itself inside the sandbox if needed.
- **Do not** add attachment counts to Slack messages — v1 keeps Slack unchanged.
- **Do not** dedup by content hash — v1 keeps one-off delivery per ticket.
- If you discover a call site that constructs a `TicketContent` literal (most likely a test fixture) and typecheck complains after Task 2, add `attachments: []` to it. Do not widen the type to make `attachments` optional — the spec is explicit that it is always present, even when empty.
- The `shortReason` regex in Task 6 is intentionally simple; if you find messages it can't parse cleanly, just return the raw message. The index is for the agent, not for humans.
