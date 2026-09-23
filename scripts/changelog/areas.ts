/**
 * Which area of the product a changelog entry belongs to. This file is the
 * one home of that rule: the release notes group bullets by it and
 * changelog/README.md describes it without repeating the lists.
 *
 * Authors never name an area. The collation reads it from git, in this order:
 *   1. the conventional-commit scope of the commit that added the entry file,
 *      when that scope names an area (`feat(dashboard): ...`);
 *   2. the paths that commit changed, counted per area, most files winning;
 *   3. the paths the entry's whole pull request changed, counted the same way;
 *   4. Other.
 * The commit comes before the pull request because one pull request often
 * ships entries for several areas: a pull request that moved five providers
 * into integrations/ also added a dashboard page, and its paths alone would
 * file the page under Integrations.
 */

/** In the order the release notes list them. */
export const AREAS = [
  "Dashboard",
  "Runs and workflows",
  "Integrations",
  "MCP",
  "Setup and operations",
  "Other",
] as const;

export type Area = (typeof AREAS)[number];

/** First matching prefix wins, so the narrow rules sit above the broad ones. */
const PATH_RULES: ReadonlyArray<readonly [prefix: string, area: Area]> = [
  ["apps/worker/src/mcp/", "MCP"],
  ["apps/worker/src/mcp-dogfood/", "MCP"],
  ["apps/worker/src/services/mcp/", "MCP"],
  ["SETUP.md", "Setup and operations"],
  ["docs/runbooks/", "Setup and operations"],
  ["apps/worker/src/services/settings/", "Setup and operations"],
  ["apps/worker/src/services/system/", "Setup and operations"],
  ["apps/dashboard/app/(cockpit)/settings/", "Setup and operations"],
  ["apps/dashboard/app/api/settings/", "Setup and operations"],
  ["apps/dashboard/lib/settings/", "Setup and operations"],
  ["apps/worker/vercel.json", "Setup and operations"],
  ["apps/dashboard/vercel.json", "Setup and operations"],
  ["integrations/", "Integrations"],
  ["apps/worker/src/adapters/", "Integrations"],
  ["apps/worker/src/services/integrations/", "Integrations"],
  ["apps/dashboard/", "Dashboard"],
  ["apps/worker/", "Runs and workflows"],
  ["packages/", "Runs and workflows"],
];

/** Commit scopes that name an area on their own. `worker` is absent on purpose: it spans several. */
const SCOPE_AREAS: Readonly<Record<string, Area>> = {
  dashboard: "Dashboard",
  engine: "Runs and workflows",
  github: "Integrations",
  gitlab: "Integrations",
  integrations: "Integrations",
  jira: "Integrations",
  mcp: "MCP",
  settings: "Setup and operations",
  setup: "Setup and operations",
  slack: "Integrations",
  "system-health": "Setup and operations",
  vcs: "Integrations",
};

const SCOPE_PATTERN = /^[a-z]+\(([^)]+)\)!?:/u;

/** Paths that say nothing about where a change lands: the entry itself and tests. */
function isNoise(path: string): boolean {
  return (
    path === "CHANGELOG.md" ||
    path.startsWith("changelog/") ||
    /\.test\.[cm]?[jt]sx?$/u.test(path)
  );
}

export function areaOfPath(path: string): Area {
  return PATH_RULES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? "Other";
}

/** The area most of these paths land in, or undefined when none lands in a named area. */
export function areaOfPaths(paths: readonly string[]): Area | undefined {
  const counts = new Map<Area, number>();
  for (const path of paths) {
    if (isNoise(path)) continue;
    const area = areaOfPath(path);
    if (area === "Other") continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  let best: Area | undefined;
  for (const area of AREAS) {
    const count = counts.get(area) ?? 0;
    if (count > 0 && (!best || count > (counts.get(best) ?? 0))) best = area;
  }
  return best;
}

export function areaOfScope(subject: string): Area | undefined {
  const scope = SCOPE_PATTERN.exec(subject)?.[1];
  return scope ? SCOPE_AREAS[scope] : undefined;
}

export interface AreaEvidence {
  /** Subject line of the commit that added the entry file. */
  commitSubject?: string;
  /** Paths that commit changed. */
  commitPaths?: readonly string[];
  /** Paths the entry's pull request changed. */
  pullRequestPaths?: readonly string[];
}

export function assignArea(evidence: AreaEvidence): Area {
  return (
    (evidence.commitSubject ? areaOfScope(evidence.commitSubject) : undefined) ??
    areaOfPaths(evidence.commitPaths ?? []) ??
    areaOfPaths(evidence.pullRequestPaths ?? []) ??
    "Other"
  );
}
