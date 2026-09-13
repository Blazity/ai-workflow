import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_REGISTRY, type SettingDefinition } from "@shared/contracts";

/**
 * No consumer reads a retired setting from the environment.
 *
 * The scan is textual because every forbidden read still typechecks when the
 * environment is mocked in a test. The only tolerated production reads are
 * pinned below, one site at a time, and every pinned key is `requiresRedeploy`.
 */

const SRC_ROOT = resolve(import.meta.dirname, "../..");
const SCANNED_ROOTS = [
  "routes",
  "services",
  "mcp",
  "infra",
  "engine",
  "pre-sandbox",
  "workflow-graph-suites",
];
const REGISTRY: readonly SettingDefinition[] = SETTINGS_REGISTRY;
const REGISTRY_KEYS = REGISTRY.map((definition) => definition.key).filter((key) =>
  /^[A-Z][A-Z0-9_]+$/u.test(key),
);
const REDEPLOY_KEYS = REGISTRY.filter(
  (definition) => definition.requiresRedeploy,
).map((definition) => definition.key);

/** Every explicit environment read H2 still permits. */
const ENVIRONMENT_RESIDUE: Array<{ path: string; key: string; because: string }> = [
  {
    path: "services/auth/auth-deployment.ts",
    key: "DASHBOARD_ORG_SLUG",
    because: "Better Auth is composed at module load",
  },
  {
    path: "services/auth/auth-deployment.ts",
    key: "MCP_ALLOW_PUBLIC_DCR",
    because: "Better Auth is composed at module load",
  },
  {
    path: "engine/steps/telemetry.ts",
    key: "DASHBOARD_ORG_SLUG",
    because: "replay compatibility for results recorded before H1",
  },
];

/** Every computed environment read H2 still permits, without line-number pins. */
const COMPUTED_ENVIRONMENT_RESIDUE = [
  "engine/steps/pre-pr-checks-runner.ts:process.env[PRE_PR_ALLOWED_ENV_VAR]",
  "engine/steps/pre-pr-checks-runner.ts:process.env[name]",
  "engine/steps/pre-pr-checks-runner.ts:process.env[name]",
  "infra/settings-environment.ts:process.env[name]",
  "services/auth/seed-auth-env.ts:env[name]",
];

const WAVE_ACCESSORS = [
  "maxConcurrentAgents",
  "dashboardOrganizationSettings",
  "mcpSettings",
  "agentRuntimeSettings",
  "triggerRateLimitDefaults",
];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const candidate = join(directory, name);
      if (statSync(candidate).isDirectory()) {
        walk(candidate);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      found.push(relative(SRC_ROOT, candidate));
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(SRC_ROOT, root));
  return found.sort();
}

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

function isPinnedEnvironmentRead(finding: string): boolean {
  return ENVIRONMENT_RESIDUE.some(
    (entry) =>
      finding.startsWith(`${entry.path}:`) &&
      finding.endsWith(`env.${entry.key}`),
  );
}

describe("settings and repository-access consumers", () => {
  it("scans the entry and run tiers", () => {
    expect(sourceFiles().length).toBeGreaterThan(400);
    expect(
      sourceFiles().filter((path) => RUN_ROOTS.some((root) => path.startsWith(root)))
        .length,
    ).toBeGreaterThan(150);
  });

  it("pins environment ownership to the three redeploy keys", () => {
    expect(REDEPLOY_KEYS).toEqual([
      "DASHBOARD_ORG_SLUG",
      "MCP_ALLOW_PUBLIC_DCR",
      "PRE_PR_CHECKS_ALLOWED_ENV",
    ]);
    expect(
      ENVIRONMENT_RESIDUE.every((entry) => REDEPLOY_KEYS.includes(entry.key)),
    ).toBe(true);
  });

  it("reads no registry key from the environment except pinned redeploy residue", () => {
    const findings = findingsFor(
      new RegExp(String.raw`\b(?:process\.)?env\.(${REGISTRY_KEYS.join("|")})\b`),
    );
    expect(findings.filter((finding) => !isPinnedEnvironmentRead(finding))).toEqual([]);
    for (const entry of ENVIRONMENT_RESIDUE) {
      expect(
        findings.some(
          (finding) =>
            finding.startsWith(`${entry.path}:`) &&
            finding.endsWith(`env.${entry.key}`),
        ),
        `${entry.path} no longer reads env.${entry.key}; remove the pinned residue`,
      ).toBe(true);
    }
  });

  it("allows computed environment reads only at the pinned redeploy accessors", () => {
    const findings = findingsFor(/\b(?:process\.)?env\[[^\]]+\]/).map((finding) =>
      finding.replace(/:\d+: /, ":"),
    );
    expect(findings).toEqual(COMPUTED_ENVIRONMENT_RESIDUE);
  });

  it("does not feed an ordinary setting name through the auth seed's computed reader", () => {
    const authSeedEnvironment = readFileSync(
      join(SRC_ROOT, "services/auth/seed-auth-env.ts"),
      "utf8",
    );
    const ordinaryKeys = REGISTRY.filter(
      (definition) => !definition.requiresRedeploy,
    ).map((definition) => definition.key);
    for (const key of ordinaryKeys) {
      expect(authSeedEnvironment).not.toContain(`"${key}"`);
      expect(authSeedEnvironment).not.toContain(`'${key}'`);
    }
  });

  it("calls no settings accessor without a snapshot", () => {
    expect(
      findingsFor(new RegExp(String.raw`\b(${WAVE_ACCESSORS.join("|")})\(\s*\)`)),
    ).toEqual([]);
  });

  it("resolves no production snapshot without a stored-row read", () => {
    expect(
      findingsFor(/\bsettingsSnapshotFromEnvironment\(\s*\)/).filter(
        (finding) => !finding.startsWith("services/settings/snapshot.ts:"),
      ),
    ).toEqual([]);
  });

  it("imports no deleted allowlist module", () => {
    expect(
      findingsFor(
        /from\s+["'][^"']*(engine\/support\/repo-allowlist|repository-allowlist-env)/,
      ),
    ).toEqual([]);
  });

  it("reads no allowlist variable inside a run", () => {
    expect(
      findingsFor(/\b(?:process\.)?env\.AGENT_ALLOWED_REPOS\b/, RUN_ROOTS),
    ).toEqual([]);
  });
});
