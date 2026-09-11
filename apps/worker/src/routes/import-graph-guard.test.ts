import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The app tier must not pull the engine into a request that never runs a step.
 *
 * A route that imports a cluster barrel gets the whole cluster, and through the
 * cluster the engine graph, including every `"use step"` module the builder
 * registers. That costs cold start on requests that only read a row or answer a
 * probe, and it hides the coupling: nothing in the types says a health probe now
 * loads the workflow engine. So this test walks the static, value carrying
 * relative imports out of each entry below and fails when one reaches a file
 * carrying the `"use step"` directive, printing the chain that brought it in.
 *
 * The list is every route, MCP module, middleware and plugin that reached zero
 * step files at the stage 6c base (81dcb2d607ac427d8d346a259a3c6b73bccc5b25)
 * and reaches zero again now: 94 of the 97 that were zero at the base. The three
 * that are absent are absent on purpose, each held by one runtime value that
 * only a file move can free, and each recorded for the stage that moves shared
 * helpers below the cluster tier:
 *
 * - `api/v1/approvals.get.ts` and `api/v1/approvals/[id]/reject.post.ts`,
 *   through `services/approvals/approval-decisions.ts` importing its own
 *   cluster's `dispatch.ts`, which owns the engine's workflows;
 * - `api/v1/pre-pr-checks/restore.post.ts`, through two constants that
 *   `services/pre-pr-checks/check-configuration.ts` reads from the step module
 *   `engine/steps/pre-pr-checks-runner.ts`.
 *
 * `import type` and dynamic `import()` are ignored: neither survives into the
 * runtime graph. Package specifiers are ignored too, since no workspace package
 * declares a step.
 */

const SRC_ROOT = resolve(import.meta.dirname, "..");

/** Entry modules, relative to `apps/worker/src`, that must stay engine free. */
const ENTRIES = [
  "auth-instance.ts",
  "auth.ts",
  "mcp/auth-pages.ts",
  "mcp/canonical-json.ts",
  "mcp/contract-artifact.ts",
  "mcp/contracts.ts",
  "mcp/execute-tool.ts",
  "mcp/oauth.ts",
  "mcp/policy.ts",
  "mcp/request-context.ts",
  "mcp/sanitize-result.ts",
  "mcp/smoke-client.ts",
  "mcp/tool-catalog.ts",
  "mcp/tools/authoring-support.ts",
  "mcp/tools/blocks.ts",
  "mcp/tools/prompt-authoring.ts",
  "mcp/tools/run-control.ts",
  "mcp/tools/run-stats.ts",
  "mcp/tools/ticket-write.ts",
  "mcp/tools/tickets.ts",
  "middleware/api-auth.ts",
  "plugins/workflow-world.ts",
  "routes/.well-known/oauth-authorization-server/api/auth.get.ts",
  "routes/.well-known/oauth-protected-resource/mcp.get.ts",
  "routes/api/auth/[...all].ts",
  "routes/api/dashboard-auth/invite/[inviteId].get.ts",
  "routes/api/dashboard-auth/invite/accept.post.ts",
  "routes/api/dashboard-auth/sso/complete.get.ts",
  "routes/api/dashboard-auth/sso/consume.post.ts",
  "routes/api/dashboard-auth/sso/mcp-session.get.ts",
  "routes/api/dashboard-auth/sso/start.get.ts",
  "routes/api/dashboard-auth/sso/status.get.ts",
  "routes/api/v1/clarifications/[id]/answer.post.ts",
  "routes/api/v1/cost.get.ts",
  "routes/api/v1/evals.get.ts",
  "routes/api/v1/harness-capabilities.get.ts",
  "routes/api/v1/harness-profiles.get.ts",
  "routes/api/v1/harness-profiles.post.ts",
  "routes/api/v1/harness-profiles/[id].get.ts",
  "routes/api/v1/harness-profiles/[id].patch.ts",
  "routes/api/v1/harness-profiles/[id]/archive.post.ts",
  "routes/api/v1/harness-profiles/[id]/fork.post.ts",
  "routes/api/v1/harness-profiles/[id]/publish.post.ts",
  "routes/api/v1/harness-profiles/[id]/remove.post.ts",
  "routes/api/v1/harness-profiles/[id]/restore.post.ts",
  "routes/api/v1/harness-profiles/[id]/skills/refresh.post.ts",
  "routes/api/v1/harness-profiles/[id]/unarchive.post.ts",
  "routes/api/v1/harness-skills/discover.post.ts",
  "routes/api/v1/harness-skills/import.post.ts",
  "routes/api/v1/harness-skills/local.get.ts",
  "routes/api/v1/harness-skills/local.post.ts",
  "routes/api/v1/invites.get.ts",
  "routes/api/v1/invites.post.ts",
  "routes/api/v1/invites/[inviteId]/cancel.post.ts",
  "routes/api/v1/invites/[inviteId]/resend.post.ts",
  "routes/api/v1/json-schema/inspect.post.ts",
  "routes/api/v1/memory.delete.ts",
  "routes/api/v1/memory.get.ts",
  "routes/api/v1/overview/eval-health.get.ts",
  "routes/api/v1/overview/kpis.get.ts",
  "routes/api/v1/prompt-library.get.ts",
  "routes/api/v1/prompt-library.post.ts",
  "routes/api/v1/prompt-library/[id].delete.ts",
  "routes/api/v1/prompt-library/[id].get.ts",
  "routes/api/v1/prompt-library/[id].patch.ts",
  "routes/api/v1/prompt-library/[id].put.ts",
  "routes/api/v1/prompt-library/[id]/restore.post.ts",
  "routes/api/v1/prompt-library/[id]/usage.get.ts",
  "routes/api/v1/prompt-library/[id]/versions/[version].get.ts",
  "routes/api/v1/repositories.get.ts",
  "routes/api/v1/runs.get.ts",
  "routes/api/v1/runs/[runId].get.ts",
  "routes/api/v1/runs/[runId]/attempts/[attemptId].get.ts",
  "routes/api/v1/runs/[runId]/cancel.post.ts",
  "routes/api/v1/runs/[runId]/replay.get.ts",
  "routes/api/v1/runs/block-statuses.get.ts",
  "routes/api/v1/runs/live.get.ts",
  "routes/api/v1/runs/replay-query.ts",
  "routes/api/v1/runs/replay-route.ts",
  "routes/api/v1/session.get.ts",
  "routes/api/v1/system/health.get.ts",
  "routes/api/v1/system/health.post.ts",
  "routes/api/v1/tickets/[ticketKey].get.ts",
  "routes/api/v1/users.get.ts",
  "routes/api/v1/users/[userId]/role.patch.ts",
  "routes/api/v1/workflows.get.ts",
  "routes/cron/harness-capabilities.get.ts",
  "routes/health.get.ts",
  "routes/mcp-auth/consent.get.ts",
  "routes/mcp-auth/consent.post.ts",
  "routes/mcp-auth/login.get.ts",
  "routes/mcp-auth/login.post.ts",
  "routes/webhooks/resend.post.ts",
  "routes/webhooks/slack.post.ts",
];

const STEP_DIRECTIVE = /^\s*["']use step["']/mu;
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/gu;

const sources = new Map<string, string>();

function readSource(file: string): string {
  const cached = sources.get(file);
  if (cached !== undefined) return cached;
  const source = readFileSync(file, "utf8");
  sources.set(file, source);
  return source;
}

/** Specifiers that carry a value at runtime: type only clauses are dropped. */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    if (/^\s*type\s/u.test(match[1] ?? "")) continue;
    found.push(match[2] ?? "");
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) found.push(match[1] ?? "");
  return found;
}

/** Resolve a relative specifier the way the bundler does, or null for a package. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".tsx"),
    base,
    `${base}.ts`,
    `${base}/index.ts`,
  ];
  return (
    candidates.find((candidate) => /\.tsx?$/u.test(candidate) && existsSync(candidate)) ?? null
  );
}

/** Shortest import chain from `entry` to a `"use step"` module, or null. */
function chainToStep(entry: string): string[] | null {
  const seen = new Set([entry]);
  let frontier: { file: string; path: string[] }[] = [{ file: entry, path: [entry] }];
  while (frontier.length > 0) {
    const next: { file: string; path: string[] }[] = [];
    for (const { file, path } of frontier) {
      const source = readSource(file);
      if (STEP_DIRECTIVE.test(source)) return path;
      for (const specifier of runtimeSpecifiers(source)) {
        const target = resolveSpecifier(file, specifier);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        next.push({ file: target, path: [...path, target] });
      }
    }
    frontier = next;
  }
  return null;
}

/** Every step module reachable through static runtime imports from one entry. */
function reachableStepFiles(entry: string): Set<string> {
  const seen = new Set([entry]);
  const steps = new Set<string>();
  const frontier = [entry];
  while (frontier.length > 0) {
    const file = frontier.shift()!;
    const source = readSource(file);
    if (STEP_DIRECTIVE.test(source)) steps.add(file);
    for (const specifier of runtimeSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      frontier.push(target);
    }
  }
  return steps;
}

// Measured at stage 11 after removing one shared step from each webhook graph.
// These values are a one-way size ratchet: a smaller graph updates the constant;
// a larger graph fails with the newly reachable step paths.
const STEP_GRAPH_LIMITS = {
  "routes/health.get.ts": 0,
  "routes/webhooks/custom/[endpointId].post.ts": 34,
  "routes/webhooks/github.post.ts": 34,
  "routes/webhooks/gitlab.post.ts": 34,
  "routes/webhooks/jira.post.ts": 35,
  "routes/webhooks/resend.post.ts": 0,
  "routes/webhooks/slack.post.ts": 0,
} as const;

describe("app tier import graph", () => {
  it("lists entries that all exist", () => {
    const missing = ENTRIES.filter((entry) => !existsSync(resolve(SRC_ROOT, entry)));
    expect(missing).toEqual([]);
  });

  it.each(ENTRIES)("%s reaches no step module", (entry) => {
    const chain = chainToStep(resolve(SRC_ROOT, entry));
    const printed = chain?.map((file) => relative(SRC_ROOT, file)).join("\n  imports ") ?? "";
    expect(chain, `${entry} reaches a "use step" module:\n  ${printed}`).toBeNull();
  });

  it.each(Object.entries(STEP_GRAPH_LIMITS))(
    "%s does not grow its reachable step graph beyond %i",
    (entry, limit) => {
      const steps = reachableStepFiles(resolve(SRC_ROOT, entry));
      const printed = [...steps]
        .map((file) => relative(SRC_ROOT, file))
        // oxlint-disable-next-line unicorn/no-array-sort -- Node 20 lacks toSorted.
        .sort()
        .join("\n  ");
      expect(
        steps.size,
        `${entry} reaches ${steps.size} step modules (limit ${limit}):\n  ${printed}`,
      ).toBeLessThanOrEqual(limit);
    },
  );
});
