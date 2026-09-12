import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_REGISTRY, type SettingsGroup } from "@shared/contracts";

/**
 * No consumer reads a migrated setting, or the repository allowlist, from the
 * environment.
 *
 * The conversion is what makes the Settings page and the Repositories page mean
 * anything: a key that one handler takes from the snapshot and another still
 * takes from `env` answers differently depending on which path a request took,
 * and an operator who saved a value would see it apply in some places and not
 * others. Inside a run the same drift is worse: a run that re-reads the
 * environment mid-flight gives two different answers about the same repository.
 * That failure is silent, so it is a test rather than a review habit: the scan
 * below walks the entry tiers AND the run tiers and fails on a read of a
 * migrated key, on a call to one of this wave's accessors without a snapshot,
 * on the environment-resolved fallback, on an import of a deleted allowlist
 * module and on a read of the allowlist variable inside a run, naming the file
 * and the line so the fix is obvious.
 *
 * It scans text, deliberately. A type-aware pass would be exact but would only
 * see what compiles; a reintroduced `env.MAX_CONCURRENT_AGENTS` compiles fine,
 * which is precisely the thing that must not pass.
 */

const SRC_ROOT = resolve(import.meta.dirname, "../..");

/** The tiers an entry point and its services live in, plus the tiers a RUN
 *  lives in: the engine wave moved the run's values onto the run context, so a
 *  reintroduced environment read inside `engine/` is the same defect. */
const SCANNED_ROOTS = [
  "routes",
  "services",
  "mcp",
  "infra",
  "engine",
  "pre-sandbox",
  "workflow-graph-suites",
];

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
/**
 * Keys this wave converted only INSIDE a run. Their group is not in
 * WAVE_GROUPS, because an entry point outside a run may still read them from
 * the environment until the cleanup stage: what the engine wave promised is
 * narrower and exact, that no run reads one of them from the environment, so
 * they are scanned under the run roots alone.
 *
 * Each one was a live defect before this stage: a run that re-read
 * ENABLE_REPO_MEMORY mid-flight could compile a prompt with memory on its first
 * pass and without it on a replay, and PRE_PR_COMMAND_TIMEOUT_MINUTES was read
 * by `process.env` INSIDE a step, so the launch and the collect of one batch
 * could disagree about which bound a command blew.
 */
const RUN_ONLY_KEYS = [
  "COLUMN_AI",
  "COLUMN_AI_REVIEW",
  "COLUMN_BACKLOG",
  "ENABLE_REPO_MEMORY",
  "ENABLE_ORG_MEMORY_PROMOTION",
  "ENABLE_REPO_ROUTING_MEMORY",
  "REVIEW_LEDGER_ENABLED",
  "PRE_PR_COMMAND_TIMEOUT_MINUTES",
];

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
    // is implemented, and it holds the one surviving zero-argument accessor
    // (`ticketBoardSettings`, called by three trigger entry points).
    path: "services/settings/",
    because: "this cluster implements the resolution the rest of the wave reads",
  },
  {
    // The environment half of that resolution, split out of the settings
    // service so the engine can resolve a snapshot without importing
    // `services/` (ADR-001 forbids engine -> services). The cleanup stage (H)
    // deletes it with the parsing.
    path: "infra/settings-environment.ts",
    because: "this file IS the environment half of the resolution",
  },
  {
    // DASHBOARD_ORG_SLUG and MCP_ALLOW_PUBLIC_DCR, the last two. Both are
    // handed to Better Auth as static plugin options when the instance is
    // composed at module load (src/auth-instance.ts), before any request, tick
    // or call exists to load a snapshot, and the provider reads neither again.
    // Making them operator-editable needs the auth instance to be built per
    // request, which is its own slice. Stage H1 settled the consequence
    // instead: both keys are marked `requiresRedeploy` in the registry, so the
    // environment import leaves them alone and the cleanup release neither
    // deletes their parsing nor asks the operator to unset them.
    path: "services/auth/auth-deployment.ts",
    because: "the Better Auth instance is composed at module load, not at an entry point",
  },
];

/**
 * The `key`/`path` pairs this scan still tolerates in the run tiers.
 *
 * Empty, and that is the point: stage H1 converted the last of them
 * (`DASHBOARD_ORG_SLUG` in `engine/blocks/agent-sandbox.ts`,
 * `engine/steps/clarification.ts`, `engine/steps/telemetry.ts` and
 * `services/workflow-definitions/prompt-authoring.ts`), so a run now takes
 * every migrated value from the settings it froze at its start. A file
 * exemption would hide a reintroduced `env.JOB_TIMEOUT_MS` in the same file,
 * so the pair is what gets pinned here, and an entry added back has to say
 * which key in which file and why.
 */
const RUN_TIER_RESIDUE: Array<{ path: string; key: string; because: string }> = [];

/** Drop the findings `RUN_TIER_RESIDUE` names, and nothing else. */
function withoutKnownResidue(findings: string[]): string[] {
  return findings.filter(
    (finding) =>
      !RUN_TIER_RESIDUE.some(
        (entry) =>
          finding.startsWith(`${entry.path}:`) && finding.endsWith(`env.${entry.key}`),
      ),
  );
}

function isExempt(relativePath: string): boolean {
  // A directory exemption covers what is under it and nothing else: a bare
  // prefix would also swallow a sibling whose name merely starts the same way
  // (`services/settings-admin.ts` next to `services/settings/`), which is an
  // exemption nobody wrote down.
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

/** The tiers a run executes in. Everything here reaches its values through the
 *  run context, so a read of the allowlist variable is a defect here even where
 *  it would be merely legacy elsewhere. */
const RUN_ROOTS = ["engine/", "pre-sandbox/"];

function findingsFor(pattern: RegExp, roots?: string[]): string[] {
  const findings: string[] = [];
  for (const relativePath of sourceFiles()) {
    if (roots && !roots.some((root) => relativePath.startsWith(root))) continue;
    const lines = readFileSync(join(SRC_ROOT, relativePath), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = new RegExp(pattern.source, pattern.flags).exec(line);
      if (match) findings.push(`${relativePath}:${index + 1}: ${match[0]}`);
    });
  }
  return findings;
}

describe("settings and repository-access consumers", () => {
  it("scans a surface that is actually there", () => {
    // A scan over nothing passes every assertion below, so the count is pinned:
    // a refactor that moves these tiers has to notice this file.
    expect(sourceFiles().length).toBeGreaterThan(400);
    // And the run tiers are actually in it, which is what the engine wave added.
    expect(
      sourceFiles().filter((path) => RUN_ROOTS.some((root) => path.startsWith(root)))
        .length,
    ).toBeGreaterThan(150);
  });

  it("reads no migrated key from the environment", () => {
    expect(
      withoutKnownResidue(
        findingsFor(new RegExp(String.raw`\benv\.(${WAVE_KEYS.join("|")})\b`)),
      ),
    ).toEqual([]);
  });

  it("keeps the tolerated residue down to the sites that are written down", () => {
    // The mirror of the assertion above: every pair in RUN_TIER_RESIDUE is a
    // real read, so a site that gets converted has to be struck from the list
    // rather than left behind as a licence nobody needs.
    const findings = findingsFor(
      new RegExp(String.raw`\benv\.(${WAVE_KEYS.join("|")})\b`),
    );
    for (const entry of RUN_TIER_RESIDUE) {
      expect(
        findings.some(
          (finding) =>
            finding.startsWith(`${entry.path}:`) && finding.endsWith(`env.${entry.key}`),
        ),
        `${entry.path} no longer reads env.${entry.key}; remove it from RUN_TIER_RESIDUE`,
      ).toBe(true);
    }
  });

  it("reads no run-only key from the environment inside a run", () => {
    // Both spellings, because the offender this catches last was a
    // `process.env.PRE_PR_COMMAND_TIMEOUT_MINUTES` inside a step module rather
    // than a read through the parsed module.
    expect(
      findingsFor(
        new RegExp(
          String.raw`\b(?:process\.)?env\.(${RUN_ONLY_KEYS.join("|")})\b`,
        ),
        RUN_ROOTS,
      ),
    ).toEqual([]);
  });

  it("calls no accessor of this wave without a snapshot", () => {
    expect(
      findingsFor(new RegExp(String.raw`\b(${WAVE_ACCESSORS.join("|")})\(\s*\)`)),
    ).toEqual([]);
  });

  it("resolves no snapshot from the environment", () => {
    // Every entry point and every run has a real snapshot to hand down: a
    // request loads one, and a run carries the one its run-start step froze.
    expect(findingsFor(/\bsettingsSnapshotFromEnvironment\(\s*\)/)).toEqual([]);
  });

  it("imports no deleted allowlist module", () => {
    // `engine/support/repo-allowlist.ts` and `infra/repository-allowlist-env.ts`
    // are gone (and listed in scripts/gates/no-resurrected-paths.json). The
    // surviving `services/dispatch/repo-allowlist.ts` is a different module and
    // a different question: who may be DISPATCHED, answered from a catalog
    // snapshot rather than the environment.
    expect(
      findingsFor(
        /from\s+["'][^"']*(engine\/support\/repo-allowlist|repository-allowlist-env)/,
      ),
    ).toEqual([]);
  });

  it("reads no allowlist variable inside a run", () => {
    // A run decides repository access from the list its run-start step froze.
    // Re-reading the variable would give one run two different answers about
    // the same repository when a deployment changes it mid-flight.
    expect(
      findingsFor(/\b(?:process\.)?env\.AGENT_ALLOWED_REPOS\b/, RUN_ROOTS),
    ).toEqual([]);
  });
});
