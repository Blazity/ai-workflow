import { describe, it, expect, vi } from "vitest";
import {
  sanitizeFilename,
  formatBytes,
  formatAttachmentsIndex,
  fetchAttachmentsWithRetry,
  type DownloadedAttachment,
  type AttachmentCaps,
} from "./attachments.js";
import type { TicketAttachment } from "../adapters/issue-tracker/types.js";

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
        meta("3", "c.bin", 40),
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
        .mockRejectedValue(new Error("Jira attachment error: status 500 Internal Server Error on url")),
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
        .mockRejectedValue(new Error("Jira attachment error: status 404 Not Found on url")),
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
        .mockRejectedValueOnce(new Error("Jira attachment error: status 503 Service Unavailable on url"))
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

  it("does not treat a bare 5xx sequence in a URL as retryable", async () => {
    const downloader = {
      downloadAttachment: vi
        .fn()
        .mockRejectedValue(new Error("fetch failed on https://example.test/path/500/resource")),
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
