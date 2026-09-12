import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_REGISTRY, type SettingsGroup } from "@shared/contracts";

/**
 * No consumer in this wave reads a migrated setting from the environment.
 *
 * The conversion is what makes the Settings page mean anything: a key that one
 * handler takes from the snapshot and another still takes from `env` answers
 * differently depending on which path a request took, and an operator who saved
 * a value would see it apply in some places and not others. That failure is
 * silent, so it is a test rather than a review habit: the scan below walks the
 * entry tiers and fails on a read of a migrated key, on a call to one of this
 * wave's accessors without a snapshot, and on the environment-resolved fallback,
 * naming the file and the line so the fix is obvious.
 *
 * It scans text, deliberately. A type-aware pass would be exact but would only
 * see what compiles; a reintroduced `env.MAX_CONCURRENT_AGENTS` compiles fine,
 * which is precisely the thing that must not pass.
 */

const SRC_ROOT = resolve(import.meta.dirname, "../..");

/** The tiers an entry point and its services live in. */
const SCANNED_ROOTS = ["routes", "services", "mcp", "infra"];

/** The groups this wave converted. */
const WAVE_GROUPS = new Set<SettingsGroup>([
  "general",
  "capacity",
  "attachments",
  "mcp",
  "harness",
  "triggers",
]);

/**
 * Three keys filed under Features in the registry travel inside this wave's
 * accessors, so converting those call sites converted them too and they belong
 * in this scan: `MCP_ENABLED` rides in `mcpSettings` with the rest of the MCP
 * limits, and `ENABLE_REVIEW_PHASE` and `ENABLE_LEAK_REVIEW` ride in
 * `agentRuntimeSettings` as `includeReview` and `includeLeakReview`.
 */
const EXTRA_WAVE_KEYS = ["MCP_ENABLED", "ENABLE_REVIEW_PHASE", "ENABLE_LEAK_REVIEW"];

const WAVE_KEYS = [
  ...SETTINGS_REGISTRY.filter((definition) => WAVE_GROUPS.has(definition.group)).map(
    (definition) => definition.key,
  ),
  ...EXTRA_WAVE_KEYS,
];

/** Accessors that take a snapshot in this wave. */
const WAVE_ACCESSORS = [
  "maxConcurrentAgents",
  "dashboardOrganizationSettings",
  "mcpSettings",
  "agentRuntimeSettings",
  "triggerRateLimitDefaults",
];

/**
 * Paths this scan does not cover, each for a reason that names the stage that
 * removes the exemption. Nothing else belongs here: an exemption added to make
 * a scan pass is the drift this file exists to catch.
 */
const EXEMPT: Array<{ path: string; because: string }> = [
  {
    // The environment schema itself. The cleanup stage (H) deletes the parsing.
    path: "infra/runtime-env.ts",
    because: "the environment schema is where the variables are declared",
  },
  {
    // The settings service resolves the environment on purpose: it is the one
    // place the resolution order (stored row, environment, registry default)
    // is implemented, and it holds the deprecated zero-argument accessors the
    // engine still calls until the engine wave (X).
    path: "services/settings/",
    because: "this cluster implements the resolution the rest of the wave reads",
  },
  {
    // GITHUB_BASE_BRANCH and GITLAB_BASE_BRANCH. The only consumer of the value
    // is the legacy single-repository path (getVcsConfig, createVCS), reached
    // from engine/support/adapters.ts and from nowhere else, and the infra tier
    // may not import the settings service (ADR-001 allows infra no outgoing
    // edges). The engine wave (X) owns that caller and converts both keys with
    // it.
    path: "infra/vcs-config.ts",
    because: "the legacy base branch is read only on an engine path, converted in stage X",
  },
  {
    // DASHBOARD_ORG_SLUG and MCP_ALLOW_PUBLIC_DCR. Both are handed to Better
    // Auth as static plugin options when the instance is composed at module
    // load (src/auth-instance.ts), before any request, tick or call exists to
    // load a snapshot, and the provider reads neither again. Making them
    // operator-editable needs the auth instance to be built per request, which
    // is its own slice.
    path: "services/auth/auth-deployment.ts",
    because: "the Better Auth instance is composed at module load, not at an entry point",
  },
  {
    // Stage C, running in parallel, owns these files.
    path: "services/pre-pr-checks/",
    because: "stage C owns the checks configuration",
  },
  {
    path: "services/repository-catalog/",
    because: "stage C owns the repository catalog",
  },
  {
    // Named twice because the match below is exact or directory-deep, never a
    // bare prefix: stage C ships both the collection route and the directory
    // under it, and a later `repository-catalog-admin.ts` is deliberately not
    // covered by either.
    path: "routes/api/v1/repository-catalog.get.ts",
    because: "stage C owns the repository catalog routes",
  },
  {
    path: "routes/api/v1/repository-catalog/",
    because: "stage C owns the repository catalog routes",
  },
];

function isExempt(relativePath: string): boolean {
  // A directory exemption covers what is under it and nothing else: a bare
  // prefix would also swallow a sibling whose name merely starts the same way
  // (`routes/api/v1/repository-catalog-admin.ts`), which is an exemption nobody
  // wrote down.
  return EXEMPT.some((entry) =>
    entry.path.endsWith("/")
      ? relativePath.startsWith(entry.path)
      : relativePath === entry.path || relativePath.startsWith(`${entry.path}/`),
  );
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const candidate = join(directory, name);
      if (statSync(candidate).isDirectory()) {
        walk(candidate);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      // Tests construct snapshots and call both accessor forms on purpose: the
      // rule is about what the deployment runs, not about what pins it.
      if (name.endsWith(".test.ts")) continue;
      const relativePath = relative(SRC_ROOT, candidate);
      if (isExempt(relativePath)) continue;
      found.push(relativePath);
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(SRC_ROOT, root));
  return found.sort();
}

function findingsFor(pattern: RegExp): string[] {
  const findings: string[] = [];
  for (const relativePath of sourceFiles()) {
    const lines = readFileSync(join(SRC_ROOT, relativePath), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = new RegExp(pattern.source, pattern.flags).exec(line);
      if (match) findings.push(`${relativePath}:${index + 1}: ${match[0]}`);
    });
  }
  return findings;
}

describe("settings consumers, services wave", () => {
  it("scans a surface that is actually there", () => {
    // A scan over nothing passes every assertion below, so the count is pinned:
    // a refactor that moves these tiers has to notice this file.
    expect(sourceFiles().length).toBeGreaterThan(150);
  });

  it("reads no migrated key from the environment", () => {
    expect(findingsFor(new RegExp(String.raw`\benv\.(${WAVE_KEYS.join("|")})\b`))).toEqual([]);
  });

  it("calls no accessor of this wave without a snapshot", () => {
    expect(
      findingsFor(new RegExp(String.raw`\b(${WAVE_ACCESSORS.join("|")})\(\s*\)`)),
    ).toEqual([]);
  });

  it("resolves no snapshot from the environment", () => {
    // The transition fallback belongs to the engine wave until stage X. An
    // entry point in this wave has a real snapshot to hand down.
    expect(findingsFor(/\bsettingsSnapshotFromEnvironment\(\s*\)/)).toEqual([]);
  });
});
