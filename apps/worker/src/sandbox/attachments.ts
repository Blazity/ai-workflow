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
    const contentUrl = att.contentUrl?.trim();
    if (!contentUrl) {
      result.push(skip(att, "skipped: missing content url", log));
      continue;
    }

    const safeName = resolveFilename(att, usedFilenames);
    usedFilenames.add(safeName);

    let attempts = 0;
    let lastError: Error | undefined;
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
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
        // Known simplification: we do not honor `Retry-After` on 429 responses.
        // The `Downloader` interface returns only Buffer, so response headers are
        // not surfaced. Static backoff is sufficient for v1; revisit if Atlassian
        // rate-limiting causes repeated retry storms.
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
  const status5xxPattern =
    /\b(?:status(?:Code)?\s*[:=]?\s*5\d\d|HTTP\/\d(?:\.\d)?\s+5\d\d)\b/i;
  const status429Pattern =
    /\b(?:status(?:Code)?\s*[:=]?\s*429|HTTP\/\d(?:\.\d)?\s+429)\b/i;
  if (err.name === "AbortError") return true;
  if (/ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(msg)) return true;
  if (status5xxPattern.test(msg)) return true;
  if (status429Pattern.test(msg)) return true;
  return false;
}

function shortReason(msg: string): string {
  // Strip the URL from thrown messages for cleaner index output.
  const m = msg.match(/\b(\d{3})\b(.*?)(?: on https?:\/\/.*)?$/);
  if (m) return `HTTP ${m[1]}${m[2] ?? ""}`.trim();
  return msg;
}
