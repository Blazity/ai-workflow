import type {
  VCSAdapter,
  PRFile,
  ExistingReviewComment,
  ReviewPullRequest,
} from "../adapters/vcs/types.js";
import type { PRContext } from "./checks/types.js";

export interface ReviewLimits {
  max_changed_files: number;
  max_total_diff_bytes: number;
  max_file_content_bytes: number;
  // workflow-level only — annotation/comment/suggestion caps apply at output mapping (M8)
}

export interface ReviewBundleRequest {
  /** Default-ignore globs from config (always applied). */
  default_ignore: string[];
  limits: ReviewLimits;
  /** Whether to fetch full PR diff. */
  need_full_diff: boolean;
  /** Whether to fetch file contents for non-deleted, eligible files. */
  need_file_contents: boolean;
  /** Whether to fetch prior PR review comments. */
  need_prior_comments: boolean;
  /** Optional ticket / acceptance criteria enrichment (resolved from branch or label). */
  need_ticket: boolean;
  /** Pass an optional ticket fetcher; receives PR head branch name and labels and returns
      either the ticket id or null. */
  resolveTicket?: (input: { branch: string; labels: string[] }) => Promise<string | null>;
  /** Pass an optional ticket fetcher returning text-only ticket details. */
  fetchTicket?: (id: string) => Promise<{ summary: string; description: string; acceptanceCriteria: string | null } | null>;
}

export interface FileContentEntry {
  path: string;
  content?: string;
  /** When undefined `content`, populated with a reason. */
  skipped?: "deleted" | "oversized" | "binary" | "fetch_failed";
}

export interface ReviewBundle {
  pr: PRContext;
  pr_meta: ReviewPullRequest;
  /** Eligible files after default_ignore and file-count limit. */
  files: PRFile[];
  /** Files ignored by `default_ignore`. */
  ignored_files: string[];
  /** Files dropped because of file-count limit. */
  dropped_files: string[];
  /** Full diff with truncation flag. Present only when need_full_diff was true. */
  full_diff?: { content: string; truncated: boolean; original_bytes: number };
  /** File-content map. Present only when need_file_contents was true. Keys are paths
      from `files`. Deleted files emit { skipped: "deleted" }, oversized files emit
      { skipped: "oversized" }. */
  file_contents?: Record<string, FileContentEntry>;
  /** Existing review comments on the PR. Present only when need_prior_comments was true. */
  prior_comments?: ExistingReviewComment[];
  /** Optional ticket id (resolved or null). Present only when need_ticket was true. */
  ticket_id?: string | null;
  /** Optional ticket body. Present only when need_ticket was true and resolution succeeded. */
  ticket?: { id: string; summary: string; description: string; acceptanceCriteria: string | null } | null;
  /** Coverage notices for ignored / skipped / truncated data — must NOT be silent. */
  notices: string[];
}

/**
 * Convert a glob pattern to a RegExp.
 * Supports: `**`, `*`, `?`, `{a,b,c}`.
 * Paths are treated as POSIX (forward slashes only).
 */
function globToRegExp(pattern: string): RegExp {
  // Escape regex metacharacters except the ones we handle ourselves.
  // We handle: *, ?, {, }
  // We need to escape: . + ^ $ | \ ( ) [ ]
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*") {
      // `**` — match any sequence including slashes
      result += ".*";
      i += 2;
      // Consume a trailing slash after `**` so `**/foo` doesn't require leading slash
      if (pattern[i] === "/") {
        result += "(?:.*/)?";
        i += 1;
      }
    } else if (ch === "*") {
      // single `*` — match any chars except slash
      result += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      result += "[^/]";
      i += 1;
    } else if (ch === "{") {
      // `{a,b,c}` — alternation
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        // malformed — treat literally
        result += "\\{";
        i += 1;
      } else {
        const alternatives = pattern.slice(i + 1, close).split(",").map(escapeRegexLiteral);
        result += "(?:" + alternatives.join("|") + ")";
        i = close + 1;
      }
    } else {
      result += escapeRegexLiteral(ch);
      i += 1;
    }
  }

  return new RegExp("^" + result + "$");
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.+^$|\\()[\]]/g, "\\$&");
}

/**
 * Returns true if `path` matches any of the given glob patterns.
 * Exported so M6 can reuse it without re-implementing.
 */
export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  // Normalise to forward slashes (POSIX)
  const normalised = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(normalised)) {
      return true;
    }
  }
  return false;
}

// Pre-compile glob patterns once per call-site via a small helper.
function compileGlobs(patterns: string[]): Array<RegExp> {
  return patterns.map((p) => globToRegExp(p));
}

function matchesCompiled(path: string, regexps: RegExp[]): boolean {
  const normalised = path.replace(/\\/g, "/");
  return regexps.some((re) => re.test(normalised));
}

export async function buildReviewBundle(
  vcs: VCSAdapter,
  args: { owner: string; repo: string; prNumber: number },
  request: ReviewBundleRequest,
): Promise<ReviewBundle> {
  const notices: string[] = [];

  // 1. PR metadata
  const meta = await vcs.getPullRequest!(args.prNumber);
  const pr: PRContext = {
    owner: meta.owner,
    repo: meta.repo,
    pr_number: meta.number,
    pr_url: meta.url,
    base_sha: meta.base.sha,
    head_sha: meta.head.sha,
    labels: meta.labels,
  };

  // 2. Files — apply ignore globs, then file-count limit
  const allFiles = await vcs.listPRFiles!(args.prNumber);

  // Sort for determinism before applying any filtering
  const sorted = [...allFiles].sort((a, b) => a.path.localeCompare(b.path));

  const ignoreRegexps = compileGlobs(request.default_ignore);
  const ignored_files: string[] = [];
  const eligible: PRFile[] = [];

  for (const file of sorted) {
    if (matchesCompiled(file.path, ignoreRegexps)) {
      ignored_files.push(file.path);
    } else {
      eligible.push(file);
    }
  }

  if (ignored_files.length > 0) {
    notices.push(`ignored ${ignored_files.length} files via default_ignore`);
  }

  const max = request.limits.max_changed_files;
  const files = eligible.slice(0, max);
  const dropped_files = eligible.slice(max).map((f) => f.path);

  if (dropped_files.length > 0) {
    notices.push(`dropped ${dropped_files.length} files due to max_changed_files=${max}`);
  }

  // 3. Full diff
  let full_diff: ReviewBundle["full_diff"];
  if (request.need_full_diff) {
    const raw = await vcs.getPRDiff!(args.prNumber);
    const original_bytes = Buffer.byteLength(raw, "utf8");
    const maxBytes = request.limits.max_total_diff_bytes;
    if (original_bytes > maxBytes) {
      // NOTE: slicing at a byte boundary may split a multibyte character; the resulting
      // string may end with a replacement character. This is acceptable for v1.
      const content = Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8");
      notices.push(`PR diff truncated from ${original_bytes} bytes to ${maxBytes} bytes`);
      full_diff = { content, truncated: true, original_bytes };
    } else {
      full_diff = { content: raw, truncated: false, original_bytes };
    }
  }

  // 4. File contents — fetch in bounded-parallel batches so 25 files don't serialise
  //    into 25 sequential round-trips inside a single workflow step.
  let file_contents: ReviewBundle["file_contents"];
  if (request.need_file_contents) {
    file_contents = {};
    const maxFileBytes = request.limits.max_file_content_bytes;
    const CONCURRENCY = 5;

    // Split into [needs-fetch] vs [deleted-handled-inline], preserving order.
    const toFetch: PRFile[] = [];
    for (const file of files) {
      if (file.status === "removed") {
        file_contents[file.path] = { path: file.path, skipped: "deleted" };
        notices.push(`skipped file ${file.path}: deleted`);
      } else {
        toFetch.push(file);
      }
    }

    // Fetch in batches of CONCURRENCY. Errors per-file are swallowed (treated as
    // null content) so a single failure does not abort the bundle build.
    const fetched: Array<string | null> = new Array(toFetch.length);
    for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
      const batch = toFetch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            return await vcs.getFileContentAtRef!(file.path, pr.head_sha);
          } catch {
            return null;
          }
        }),
      );
      for (let j = 0; j < results.length; j += 1) {
        fetched[i + j] = results[j];
      }
    }

    // Apply size / null checks in original order so notices stay deterministic.
    for (let i = 0; i < toFetch.length; i += 1) {
      const file = toFetch[i];
      const content = fetched[i];
      if (content === null) {
        file_contents[file.path] = { path: file.path, skipped: "fetch_failed" };
        notices.push(`skipped file ${file.path}: content unavailable`);
        continue;
      }
      if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
        file_contents[file.path] = { path: file.path, skipped: "oversized" };
        notices.push(`skipped file ${file.path}: oversized`);
        continue;
      }
      file_contents[file.path] = { path: file.path, content };
    }
  }

  // 5. Prior comments
  let prior_comments: ReviewBundle["prior_comments"];
  if (request.need_prior_comments) {
    prior_comments = await vcs.listExistingReviewComments!(args.prNumber);
  }

  // 6. Ticket
  let ticket_id: ReviewBundle["ticket_id"];
  let ticket: ReviewBundle["ticket"];
  if (request.need_ticket) {
    if (request.resolveTicket && request.fetchTicket) {
      try {
        ticket_id = await request.resolveTicket({ branch: meta.head.ref, labels: meta.labels });
        if (ticket_id === null) {
          ticket = null;
          notices.push("no ticket linked to this PR");
        } else {
          const details = await request.fetchTicket(ticket_id);
          if (details === null) {
            ticket = null;
            notices.push(`ticket ${ticket_id} not found`);
          } else {
            ticket = { id: ticket_id, ...details };
          }
        }
      } catch {
        ticket_id = null;
        ticket = null;
        notices.push("ticket lookup failed");
      }
    } else {
      ticket_id = null;
      ticket = null;
    }
  }

  const bundle: ReviewBundle = {
    pr,
    pr_meta: meta,
    files,
    ignored_files,
    dropped_files,
    notices,
  };

  if (request.need_full_diff) {
    bundle.full_diff = full_diff;
  }
  if (request.need_file_contents) {
    bundle.file_contents = file_contents;
  }
  if (request.need_prior_comments) {
    bundle.prior_comments = prior_comments;
  }
  if (request.need_ticket) {
    bundle.ticket_id = ticket_id;
    bundle.ticket = ticket;
  }

  return bundle;
}
