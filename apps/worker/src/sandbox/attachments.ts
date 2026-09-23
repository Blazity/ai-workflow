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
    .replace(new RegExp(String.raw`\u0000`, "gu"), "")
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

  const lines: string[] = [
    "## Attachments",
    "",
    "The following files from the ticket are available in `/tmp/attachments/`.",
    "Read them when relevant to the task.",
    "",
  ];

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

interface Downloader {
  downloadAttachment(url: string, opts?: { timeoutMs?: number }): Promise<Buffer>;
}

interface AttachmentsLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Download what the ticket carries into memory, within the caps, one tracker
 * call per attachment.
 *
 * No retry here. The tracker's adapter makes its requests through `ctx.http`,
 * which already retries a read on the failures that say nothing about it (a
 * network error, a 5xx, a rate limit) inside the operator's per-attachment
 * deadline. A loop here on top multiplied that: up to nine requests for one
 * file, and, for a provider that stays down or a download that times out, the
 * operator's deadline spent three times over inside one step.
 */
export async function downloadTicketAttachments(
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
    // Cap: total size. Once exceeded, all remaining are skipped.
    if (totalCapTripped || bytesCommitted + att.size > caps.maxTotalSizeBytes) {
      totalCapTripped = true;
      result.push(skip(att, "skipped: total size cap", log));
      continue;
    }
    const contentUrl = att.contentUrl?.trim();
    if (!contentUrl) {
      result.push(skip(att, "skipped: missing content url", log));
      continue;
    }

    const safeName = resolveFilename(att, usedFilenames);
    usedFilenames.add(safeName);

    try {
      const content = await downloader.downloadAttachment(contentUrl, {
        timeoutMs: caps.downloadTimeoutMs,
      });
      bytesCommitted += att.size;
      log.info(
        {
          filename: safeName,
          originalFilename: att.filename,
          mimeType: att.mimeType,
          size: att.size,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ filename: att.filename, reason: message }, "attachment failed");
      result.push({
        filename: safeName,
        originalFilename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        failed: { reason: shortReason(message), attempts: 1 },
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

function shortReason(msg: string): string {
  // Strip the URL from thrown messages for cleaner index output.
  const m = msg.match(/\b(\d{3})\b(.*?)(?: on https?:\/\/.*)?$/);
  if (m) return `HTTP ${m[1]}${m[2] ?? ""}`.trim();
  return msg;
}
