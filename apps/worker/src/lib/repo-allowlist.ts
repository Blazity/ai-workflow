/**
 * Temporary hard allowlist of "owner/repo" paths the agent may ever read, branch,
 * or PR. Set via the AGENT_ALLOWED_REPOS env var (comma-separated, case-insensitive);
 * empty/unset = no restriction. Reads process.env directly rather than the validated
 * env singleton so importing it never triggers full env validation (these guards live
 * on the repository adapters, whose unit tests do not configure the whole env).
 */
function allowedSet(): Set<string> {
  const raw = process.env.AGENT_ALLOWED_REPOS ?? "";
  return new Set(
    raw
      .split(",")
      .map((path) => path.trim().toLowerCase())
      .filter((path) => path.length > 0),
  );
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
