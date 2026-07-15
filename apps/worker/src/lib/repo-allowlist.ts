import { logger } from "./logger.js";

/**
 * Hard allowlist of "owner/repo" paths the agent may ever read, branch,
 * or PR. Set via the AGENT_ALLOWED_REPOS env var (comma-separated, case-insensitive);
 * empty/unset = no restriction (all installed repos allowed). Reads process.env
 * directly rather than the validated env singleton so importing it never triggers
 * full env validation (these guards live on the repository adapters, whose unit
 * tests do not configure the whole env).
 *
 * The empty-means-unrestricted default is intentional (this is the multi-repo
 * product default), but it fails OPEN, so both failure modes are made loud rather
 * than silent:
 *   - a one-time `warn` when the effective allowlist is empty, so an operator sees
 *     the fail-open state instead of it being invisible;
 *   - an `error` naming any entry that is not a valid "owner/repo" path (exactly
 *     one slash, non-empty owner and repo). Malformed entries are ignored
 *     individually so a single typo cannot silently widen the allowlist to "all"
 *     as long as one valid entry remains.
 */

// owner/repo: exactly one slash, non-empty owner and repo.
const REPO_PATH_RE = /^[^/]+\/[^/]+$/;

// One-time-per-process dedupe so allowedSet() (called on every repo check) does
// not spam the log. Keyed per distinct bad entry for the malformed case.
let warnedEmpty = false;
const warnedMalformed = new Set<string>();

function allowedSet(): Set<string> {
  const raw = process.env.AGENT_ALLOWED_REPOS ?? "";
  const entries = raw
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  const valid = new Set<string>();
  for (const entry of entries) {
    if (REPO_PATH_RE.test(entry)) {
      valid.add(entry.toLowerCase());
      continue;
    }
    if (!warnedMalformed.has(entry)) {
      warnedMalformed.add(entry);
      logger.error(
        { envVar: "AGENT_ALLOWED_REPOS", entry },
        `AGENT_ALLOWED_REPOS entry "${entry}" is not a valid "owner/repo" path; ignoring it`,
      );
    }
  }

  if (valid.size === 0 && !warnedEmpty) {
    warnedEmpty = true;
    logger.warn(
      { envVar: "AGENT_ALLOWED_REPOS" },
      "AGENT_ALLOWED_REPOS is empty; the agent may branch/PR on ANY installed repo",
    );
  }

  return valid;
}

/** True when the repo may be touched: either no allowlist is configured, or the
 *  path is on it. Case-insensitive on "owner/repo". */
export function isRepoAllowed(repoPath: string): boolean {
  const set = allowedSet();
  return set.size === 0 || set.has(repoPath.toLowerCase());
}

/** Drop any repo not on the allowlist. No-op when the allowlist is empty. */
export function filterAllowedRepositories<T extends { repoPath: string }>(repos: T[]): T[] {
  const set = allowedSet();
  if (set.size === 0) return repos;
  return repos.filter((repo) => set.has(repo.repoPath.toLowerCase()));
}
