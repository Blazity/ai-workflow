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
